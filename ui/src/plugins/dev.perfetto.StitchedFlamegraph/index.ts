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

import m from 'mithril';
import {z} from 'zod';
import {ensureExists} from '../../base/assert';
import {AtomicTaskQueue} from '../../base/async_memo';
import {Memo} from '../../base/memo';
import type {Store} from '../../base/store';
import {TreeExplorerFetcher} from '../../components/tree_explorer_fetcher';
import {TreeExplorerPanel} from '../../components/tree_explorer_panel';
import type {PerfettoPlugin} from '../../public/plugin';
import {
  type AreaSelection,
  type AreaSelectionTab,
  areaSelectionKey,
} from '../../public/selection';
import type {Trace} from '../../public/trace';
import {SLICE_TRACK_KIND} from '../../public/track_kinds';
import {RadioGroup} from '../../widgets/radio_group';
import {
  TREE_EXPLORER_STATE_SCHEMA,
  type TreeExplorerState,
  updateTreeExplorerState,
} from '../../widgets/tree_explorer';
import {STITCHED_SQL_PACKAGE_NAME} from './core_sql';
import {
  type StitchDirection,
  type StitchedMetricProvider,
  type StitchedSelection,
  viewForDirection,
} from './metrics';
import {STITCHED_PROVIDERS} from './providers';
import {STITCHED_SQL_MODULES} from './sql_modules';

const STATE_SCHEMA = z.object({
  direction: z.enum(['DOWN', 'UP']).default('DOWN'),
  flamegraph: TREE_EXPLORER_STATE_SCHEMA.optional(),
});
type State = z.infer<typeof STATE_SCHEMA>;

// The fetcher of one (selection, direction) and the tables its metrics
// materialize.
interface Generation extends Disposable {
  readonly fetcher: TreeExplorerFetcher;
}

// Thread frames between stitched slices are the only nodes with an icon.
function nodeIcon(properties: ReadonlyMap<string, string>): string | undefined {
  return properties.get('kind') === 'hop' ? 'swap_horiz' : undefined;
}

// A flamegraph of the selected slices stitched across threads and processes:
// downstream to everything they ran and triggered, or upstream to what led to
// them.
export default class StitchedFlamegraphPlugin implements PerfettoPlugin {
  static readonly id = 'dev.perfetto.StitchedFlamegraph';

  private store?: Store<State>;
  private providers: ReadonlyArray<StitchedMetricProvider> = [];
  private generation = 0;

  async onTraceLoad(trace: Trace): Promise<void> {
    this.store = trace.mountStore(StitchedFlamegraphPlugin.id, (init) => {
      return STATE_SCHEMA.safeParse(init ?? {}).data ?? {direction: 'DOWN'};
    });
    // Only registers the SQL: nothing runs until a stitched metric is shown.
    await trace.addSqlPackages([
      {name: STITCHED_SQL_PACKAGE_NAME, modules: STITCHED_SQL_MODULES},
    ]);
    const available = await Promise.all(
      STITCHED_PROVIDERS.map(
        async (p) => p.isAvailable === undefined || p.isAvailable(trace.engine),
      ),
    );
    this.providers = STITCHED_PROVIDERS.filter((_, i) => available[i]);
    trace.selection.registerAreaSelectionTab(this.createTab(trace));
  }

  private createTab(trace: Trace): AreaSelectionTab {
    // Serializes the queries of the tab: the metrics of a generation and the
    // dropping of its tables once superseded.
    const queue = new AtomicTaskQueue();
    const generationMemo = new Memo<Generation | undefined>();
    return {
      id: 'stitched_flamegraph',
      name: 'Stitched Flamegraph',
      render: (area: AreaSelection) => {
        const store = ensureExists(this.store);
        const direction = store.state.direction;
        const generation = generationMemo.use({
          key: {area: areaSelectionKey(area), direction},
          compute: () => {
            const selection = toStitchedSelection(area, direction);
            if (selection === undefined) return undefined;
            return this.createGeneration(trace, queue, selection);
          },
        });
        if (generation === undefined) return undefined;
        return {
          isLoading: false,
          content: m(TreeExplorerPanel, {
            fetcher: generation.fetcher,
            state: store.state.flamegraph,
            onStateChange: (state: TreeExplorerState) => {
              store.edit((draft) => {
                draft.flamegraph = state;
              });
            },
            nodeIcon,
            extraControls: renderDirectionToggle(direction, (next) => {
              store.edit((draft) => {
                draft.direction = next;
                if (draft.flamegraph !== undefined) {
                  draft.flamegraph = {
                    ...draft.flamegraph,
                    view: viewForDirection(next),
                  };
                }
              });
            }),
          }),
        };
      },
    };
  }

  private createGeneration(
    trace: Trace,
    queue: AtomicTaskQueue,
    selection: StitchedSelection,
  ): Generation {
    const gen = ++this.generation;
    const results = this.providers.map((p) =>
      p.metrics(trace, selection, `_stitched_${gen}`),
    );
    const metrics = results.flatMap((r) => r.metrics);
    const tables = [...new Set(results.flatMap((r) => r.tables))];
    const store = ensureExists(this.store);
    store.edit((draft) => {
      draft.flamegraph = updateTreeExplorerState(
        draft.flamegraph ?? {
          selectedMetricId: '',
          addedMetricIds: [],
          displayMode: 'flamegraph',
          filters: [],
          view: viewForDirection(selection.direction),
        },
        metrics,
      );
    });
    const fetcher = new TreeExplorerFetcher(trace, metrics, queue);
    return {
      fetcher,
      [Symbol.dispose]: () => {
        fetcher[Symbol.dispose]();
        // The flamegraph copies its input when built, so the tables are not
        // needed past this point. Queued after any in-flight metric query.
        queue.schedule({}, async () => {
          await trace.engine.query(
            tables.map((t) => `drop table if exists ${t};`).join('\n'),
          );
        });
      },
    };
  }
}

function toStitchedSelection(
  area: AreaSelection,
  direction: StitchDirection,
): StitchedSelection | undefined {
  const trackIds: number[] = [];
  for (const track of area.tracks) {
    if (!track.tags?.kinds?.includes(SLICE_TRACK_KIND)) continue;
    trackIds.push(...(track.tags.trackIds ?? []));
  }
  if (trackIds.length === 0 || area.end <= area.start) return undefined;
  return {trackIds, start: area.start, end: area.end, direction};
}

function renderDirectionToggle(
  direction: StitchDirection,
  onChange: (direction: StitchDirection) => void,
): m.Children {
  return m(
    RadioGroup,
    {
      selectedValue: direction,
      onValueChange: (value) => onChange(value as StitchDirection),
    },
    [
      m(
        RadioGroup.Button,
        {
          value: 'DOWN',
          icon: 'south',
          title:
            'What the selected slices ran and triggered on other threads ' +
            'and processes (selection on top)',
        },
        'Downstream',
      ),
      m(
        RadioGroup.Button,
        {
          value: 'UP',
          icon: 'north',
          title:
            'What led to the selected slices running, across threads and ' +
            'processes (selection on top, causes below)',
        },
        'Upstream',
      ),
    ],
  );
}
