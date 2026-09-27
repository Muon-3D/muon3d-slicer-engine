// The OrcaSlicer settings catalogue (data/settings-catalogue.json, made by `npm run gen:settings`) and
// helpers to read it. Types are in types.ts. Node-only: a page gets the catalogue as data, not code.
import { readFile } from 'node:fs/promises';
import type { LayoutGroup, LayoutLine, LayoutPage, LayoutTab, SettingDef, SettingMode, SettingsCatalogue } from './types.ts';

export type * from './types.ts';

export const CATALOGUE_URL = new URL('../../data/settings-catalogue.json', import.meta.url);

let loading: Promise<SettingsCatalogue> | undefined;

/** The catalogue, loaded once (later calls share the first load; after a failed load, they try again). */
export function loadCatalogue(): Promise<SettingsCatalogue> {
  loading ??= readFile(CATALOGUE_URL, 'utf8').then(
    (text) => JSON.parse(text) as SettingsCatalogue,
    (err: unknown) => {
      loading = undefined;
      throw err;
    },
  );
  return loading;
}

/** The definition of option `key`, or undefined when Orca has no such option. */
export function settingDef(catalogue: SettingsCatalogue, key: string): SettingDef | undefined {
  return Object.hasOwn(catalogue.options, key) ? catalogue.options[key] : undefined;
}

const MODE_RANK: Record<SettingMode, number> = { simple: 0, advanced: 1, expert: 2, develop: 3 };

/** Whether something at `mode` shows when the user has chosen `selected` (simple < advanced < expert < develop). */
export function shownInMode(mode: SettingMode, selected: SettingMode): boolean {
  return MODE_RANK[mode] <= MODE_RANK[selected];
}

/** A line's mode: its first option's, as in Orca (OptionsGroup.cpp). */
export function lineMode(catalogue: SettingsCatalogue, line: LayoutLine): SettingMode {
  return settingDef(catalogue, line.options[0].key)?.mode ?? 'develop';
}

/** The label a row shows: its own (a line of several options), else its option's full label. */
export function lineLabel(catalogue: SettingsCatalogue, line: LayoutLine): string {
  if (line.label !== undefined) return line.label;
  const option = line.options[0];
  const def = settingDef(catalogue, option.key);
  return option.label ?? (line.modeColumns ? def?.fullLabel : undefined) ?? def?.label ?? option.key;
}

/** Where a tab shows an option. */
export interface Placement {
  tab: LayoutTab;
  page: LayoutPage;
  group: LayoutGroup;
  line: LayoutLine;
}

const placements = new WeakMap<SettingsCatalogue, Map<string, Placement>>();

/** Where option `key` is shown (every option is shown at most once across the tabs), or undefined. */
export function findPlacement(catalogue: SettingsCatalogue, key: string): Placement | undefined {
  let index = placements.get(catalogue);
  if (!index) {
    index = new Map();
    for (const tab of catalogue.tabs) {
      for (const page of tab.pages) {
        for (const group of page.groups) {
          for (const line of group.lines) for (const option of line.options) index.set(option.key, { tab, page, group, line });
        }
      }
    }
    placements.set(catalogue, index);
  }
  return index.get(key);
}
