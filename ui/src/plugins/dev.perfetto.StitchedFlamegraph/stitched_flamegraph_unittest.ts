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

import {Time} from '../../base/time';
import type {Trace} from '../../public/trace';
import {parseSliceIds} from './actions';
import {STITCHED_SQL_PACKAGE_NAME} from './core_sql';
import {
  type StitchedSelection,
  StitchedPipeline,
  viewForDirection,
} from './metrics';
import {STITCHED_PROVIDERS} from './providers';
import {STITCHED_SQL_MODULES} from './sql_modules';

const SELECTION: StitchedSelection = {
  trackIds: [3, 7],
  start: Time.fromRaw(100n),
  end: Time.fromRaw(200n),
  direction: 'DOWN',
};

const moduleNames = new Set(STITCHED_SQL_MODULES.map((m) => m.name));

// The metrics never touch the trace when built, only when their actions run.
const TRACE = {} as Trace;

describe('StitchedFlamegraph parseSliceIds', () => {
  test('parses the merged ids of a node', () => {
    expect(parseSliceIds(undefined)).toEqual([]);
    expect(parseSliceIds('')).toEqual([]);
    expect(parseSliceIds('42')).toEqual([42]);
    expect(parseSliceIds('1, 2,1,,3')).toEqual([1, 2, 3]);
  });

  test('drops anything which is not a slice id', () => {
    expect(parseSliceIds('-1,abc,1.5,7')).toEqual([7]);
  });
});

describe('StitchedFlamegraph viewForDirection', () => {
  test('shows the selection on top in both directions', () => {
    expect(viewForDirection('DOWN')).toEqual({kind: 'TOP_DOWN'});
    expect(viewForDirection('UP')).toEqual({kind: 'BOTTOM_UP'});
  });
});

describe('StitchedFlamegraph StitchedPipeline', () => {
  test('materializes each step in a prefixed table', () => {
    const p = new StitchedPipeline('_p', ['stitched_flamegraph.core']);
    const a = p.table('a', 'select 1 as id', 'id');
    const b = p.table('b', `select * from ${a}`);
    expect([a, b]).toEqual(['_p_a', '_p_b']);
    expect(p.tables).toEqual(['_p_a', '_p_b']);
    expect(p.sql).toBe(
      [
        'include perfetto module stitched_flamegraph.core;',
        'create or replace perfetto table _p_a as select 1 as id;',
        'create or replace perfetto index _p_a_idx on _p_a(id);',
        'create or replace perfetto table _p_b as select * from _p_a;',
      ].join('\n'),
    );
  });
});

describe('StitchedFlamegraph SQL package', () => {
  test('has uniquely named modules in the package', () => {
    expect(moduleNames.size).toBe(STITCHED_SQL_MODULES.length);
    for (const name of moduleNames) {
      expect(name.startsWith(`${STITCHED_SQL_PACKAGE_NAME}.`)).toBe(true);
    }
  });

  test('only includes registered modules of its own package', () => {
    for (const m of STITCHED_SQL_MODULES) {
      const includes = m.sql.matchAll(/INCLUDE PERFETTO MODULE ([\w.]+);/g);
      for (const [, name] of includes) {
        if (name.startsWith(`${STITCHED_SQL_PACKAGE_NAME}.`)) {
          expect(moduleNames.has(name)).toBe(true);
        }
      }
    }
  });
});

describe('StitchedFlamegraph providers', () => {
  for (const direction of ['DOWN', 'UP'] as const) {
    test(`build well formed ${direction} metrics`, () => {
      const prefix = '_t';
      const metricIds = new Set<string>();
      for (const provider of STITCHED_PROVIDERS) {
        const res = provider.metrics(TRACE, {...SELECTION, direction}, prefix);
        expect(res.metrics.length).toBeGreaterThan(0);
        for (const t of res.tables) {
          expect(t.startsWith(`${prefix}_`)).toBe(true);
        }
        for (const metric of res.metrics) {
          const id = metric.id ?? metric.name;
          expect(metricIds.has(id)).toBe(false);
          metricIds.add(id);
          const deps = metric.dependencySql;
          const sql = typeof deps === 'string' ? deps : (deps ?? []).join('\n');
          // Every module the metric includes is registered.
          for (const [, name] of sql.matchAll(
            /include perfetto module ([\w.]+);/g,
          )) {
            expect(moduleNames.has(name)).toBe(true);
          }
          // Every table the metric creates is one it reports for cleanup.
          for (const [, name] of sql.matchAll(
            /create or replace perfetto table (\w+)/g,
          )) {
            expect(res.tables).toContain(name);
          }
          expect(metric.statement).toContain('_stitched_finalize!');
        }
      }
    });
  }

  test('share the flows pipeline between providers', () => {
    const sqls = STITCHED_PROVIDERS.flatMap((provider) =>
      provider
        .metrics(TRACE, SELECTION, '_t')
        .metrics.flatMap((m) =>
          typeof m.dependencySql === 'string'
            ? [m.dependencySql]
            : [...(m.dependencySql ?? [])],
        ),
    );
    const flows = sqls.filter((sql) => sql.includes('_t_flows_seeds as'));
    expect(flows.length).toBeGreaterThan(1);
    expect(new Set(flows).size).toBe(1);
  });
});
