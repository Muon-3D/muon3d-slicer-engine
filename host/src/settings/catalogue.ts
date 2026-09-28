// The settings catalogue (data/settings-catalogue.json, format 2: `npm run gen:settings`) as the settings
// service reads it: the option definitions, the layout of Orca's tabs, and the lookups the layout and the
// rules need. Bundled into the host's settings chunk, which is loaded only for settings ops.
import type { LayoutLine, SettingDef, SettingMode, SettingsCatalogue } from '../../../packages/protocol/src/catalogue.ts';
import data from '../../../data/settings-catalogue.json' with { type: 'json' };

export const CATALOGUE = data as unknown as SettingsCatalogue;

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
