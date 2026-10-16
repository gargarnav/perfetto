// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import type {SqlModule} from '../../public/extra_sql_packages';

// The PerfettoSQL package backing the stitched flamegraph. Its modules are
// registered with every trace but only run when a stitched flamegraph metric
// is first computed (via INCLUDE PERFETTO MODULE in the metric's dependency
// SQL), after which trace processor caches them for the rest of the session.
export const STITCHED_SQL_PACKAGE_NAME = 'stitched_flamegraph';

// Shared building blocks used by every stitching mode:
//  - `_stitched_parent`: the slice that causally started each slice running
//    elsewhere (flows: binder, message queues, thread pools, coroutines; plus
//    the AIDL slice that follows an async binder receive on the same track).
//  - `_stitched_track` / `_stitched_thread_label`: thread context of tracks.
//  - `_stitched_finalize!`: turns a tree of stitched nodes into flamegraph
//    rows, inserting a thread frame wherever the tree hops threads.
export const STITCHED_CORE_MODULE: SqlModule = {
  name: `${STITCHED_SQL_PACKAGE_NAME}.core`,
  sql: `
INCLUDE PERFETTO MODULE android.thread;
INCLUDE PERFETTO MODULE graphs.search;

-- For each slice which continues work started by another slice (the target
-- of a flow, or the AIDL slice following an async binder receive on the same
-- track, mirroring stdlib's _async_binder_reply), the slice which started it.
CREATE PERFETTO TABLE _stitched_parent(
  id JOINID(slice.id),
  parent_id JOINID(slice.id)
) AS
WITH
  async_binder AS (
    SELECT
      id,
      name,
      lead(id) OVER w AS next_id,
      lead(name) OVER w AS next_name
    FROM slice
    WHERE depth = 0
      AND (
        name = 'binder async rcv'
        OR name GLOB 'AIDL::*Server'
        OR name GLOB 'AIDL::*server'
        OR name GLOB 'HIDL::*server'
      )
    WINDOW w AS (PARTITION BY track_id ORDER BY ts)
  ),
  edges AS (
    SELECT slice_in AS id, slice_out AS parent_id
    FROM flow
    UNION ALL
    SELECT next_id AS id, id AS parent_id
    FROM async_binder
    WHERE name = 'binder async rcv'
      AND next_name != 'binder async rcv'
  )
SELECT id, min(parent_id) AS parent_id
FROM edges
GROUP BY id
ORDER BY id;

CREATE PERFETTO TABLE _stitched_track(
  track_id JOINID(track.id),
  utid JOINID(thread.id),
  upid JOINID(process.id)
) AS
SELECT id AS track_id, utid, NULL AS upid FROM thread_track
UNION ALL
SELECT id AS track_id, NULL AS utid, upid FROM process_track
ORDER BY track_id;

CREATE PERFETTO INDEX _stitched_track_idx ON _stitched_track(track_id);

CREATE PERFETTO FUNCTION _stitched_basename(path STRING)
RETURNS STRING AS
SELECT replace($path, rtrim($path, replace($path, '/', '')), '');

-- Human readable "process › thread" label of every thread (keyed by
-- utid * 2) and process (keyed by upid * 2 + 1).
CREATE PERFETTO TABLE _stitched_thread_label(
  thread_key LONG,
  label STRING
) AS
SELECT
  t.utid * 2 AS thread_key,
  coalesce(_stitched_basename(p.name) || ' › ', '') ||
    iif(
      t.is_main_thread,
      'main',
      coalesce(android_standardize_thread_name(t.name), 'tid ' || t.tid)
    ) AS label
FROM thread t
LEFT JOIN process p USING (upid)
UNION ALL
SELECT
  upid * 2 + 1 AS thread_key,
  coalesce(_stitched_basename(name), 'pid ' || pid) AS label
FROM process
ORDER BY thread_key;

CREATE PERFETTO INDEX _stitched_thread_label_idx
ON _stitched_thread_label(thread_key);

-- Turns a table of stitched nodes into flamegraph rows.
--
-- $nodes must be a table with the columns:
--   id LONG, parent_id LONG: the tree (parent_id NULL for roots).
--   name STRING: the node name.
--   slice_id LONG: the slice the node stands for (NULL if none).
--   slice_ids STRING: comma separated ids of all the slices the node stands
--     for, when several were merged into it (else the slice_id).
--   utid LONG, upid LONG: the thread (or process) the node ran on.
--   is_stitch BOOL: whether the node continues work of its parent on another
--     work item; always true when the parent ran on another thread.
--   kind STRING: 'slice', or 'frame' for nodes which never start a run of
--     work on a thread (e.g. callstack frames below a slice).
--   self_dur LONG, self_count LONG: the node's own weights.
--
-- A thread frame (named after the thread) is inserted above every node that
-- starts a run of work on a thread: roots and nodes reached through a
-- stitch. Thread frames are the 'thread' (roots) or 'hop' kind and carry no
-- weight of their own.
CREATE PERFETTO MACRO _stitched_finalize(nodes TableOrSubquery)
RETURNS TableOrSubquery AS (
  SELECT
    n.id * 2 + 1 AS id,
    n.parent_id * 2 AS parentId,
    coalesce(l.label, '[unknown thread]') AS name,
    iif(n.parent_id IS NULL, 'thread', 'hop') AS kind,
    coalesce(l.label, '') AS thread,
    NULL AS slice_ids,
    0 AS self_dur,
    0 AS self_count
  FROM $nodes n
  LEFT JOIN _stitched_thread_label l
    ON l.thread_key = coalesce(n.utid * 2, n.upid * 2 + 1)
  WHERE n.kind != 'frame' AND (n.parent_id IS NULL OR n.is_stitch)
  UNION ALL
  SELECT
    n.id * 2 AS id,
    iif(
      n.kind != 'frame' AND (n.parent_id IS NULL OR n.is_stitch),
      n.id * 2 + 1,
      n.parent_id * 2
    ) AS parentId,
    coalesce(nullif(n.name, ''), '[unnamed]') AS name,
    n.kind,
    coalesce(l.label, '') AS thread,
    n.slice_ids,
    n.self_dur,
    n.self_count
  FROM $nodes n
  LEFT JOIN _stitched_thread_label l
    ON l.thread_key = coalesce(n.utid * 2, n.upid * 2 + 1)
);
`,
};
