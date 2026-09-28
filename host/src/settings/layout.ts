// Which pages, groups and rows of OrcaSlicer's settings tabs (the catalogue's layout) a form shows:
// Orca's mode rule (a row shows at its first option's mode and above), the rows Orca's rules hide, pages
// Orca shows only for some printers, one Extruder page per nozzle, the generated "Other" page (Expert
// only), and the client's `omit` list (keys it never shows).
//
// Provenance: ported on 2026-09-28 from the Muon3D Slicer app (Muon 3D Technologies' own code:
// web/src/settings/layout.ts, the Tab behaviour); part of this repository and licensed like it
// (AGPL-3.0-only). Changed here: the app's policy (which keys it never shows) is the request's `omit`.
import type { LayoutGroup, LayoutLine, LayoutOption, LayoutPage, LayoutTab, SettingDef, SettingScope, SettingsCatalogue } from '../../../packages/protocol/src/catalogue.ts';
import type { PanelMode } from '../../../packages/protocol/src/settings.ts';
import { lineLabel, lineMode, settingDef, shownInMode } from './catalogue.ts';
import { isHidden, type TabRules } from './rules.ts';

/** The catalogue with the keys a client never shows (ViewOptions.omit). */
export interface LayoutCatalogue extends SettingsCatalogue {
  omit: ReadonlySet<string>;
}

const withOmit = new WeakMap<SettingsCatalogue, Map<string, LayoutCatalogue>>();

/** `catalogue` with `omit` (one object per omit list, so caches keyed by it hold). */
export function layoutCatalogue(catalogue: SettingsCatalogue, omit: readonly string[] = []): LayoutCatalogue {
  const id = [...new Set(omit)].sort().join(',');
  let byOmit = withOmit.get(catalogue);
  if (!byOmit) withOmit.set(catalogue, (byOmit = new Map()));
  let found = byOmit.get(id);
  if (!found) byOmit.set(id, (found = { ...catalogue, omit: new Set(id ? id.split(',') : []) }));
  return found;
}

/** Whether a form shows option `key` at all (Orca's read-only ones are shown, greyed). */
export function isShown(catalogue: LayoutCatalogue, key: string, def: SettingDef | undefined = settingDef(catalogue, key)): def is SettingDef {
  return def !== undefined && !catalogue.omit.has(key);
}

/** A page as the page strip shows it: an Extruder page appears once per nozzle. */
export interface PageRef {
  tab: LayoutTab;
  page: LayoutPage;
  /** Unique in the tab: the page id, or `<page>#<i>` for nozzle i. */
  id: string;
  title: string;
  /** The nozzle an Extruder page edits (0-based). */
  extruder?: number;
}

export interface OptionRef {
  key: string;
  def: SettingDef;
  layout: LayoutOption;
  /**
   * The vector slot the row edits (for an option stored per nozzle variant, the slot of the nozzle
   * shown: get_index_for_extruder); undefined = the option as a whole (slot 0 of a vector).
   */
  index: number | undefined;
  /**
   * The slot Orca's rules toggle for this row (`key#ruleIndex`): the nozzle of an Extruder page, a
   * machine-limit column. undefined = the option as a whole.
   */
  ruleIndex: number | undefined;
  /** Its label inside a row of several options ("Target", "10%"). */
  label: string;
}

/**
 * Which slot and which rules slot an option of a row edits for nozzle `extruder`, given the slot the
 * layout names ('extruder' = the page's nozzle, a number, or undefined = the whole option). The settings
 * model resolves options stored per nozzle variant (model.ts slotResolver); without one, the layout's
 * slot is used as it is.
 */
export type SlotResolver = (
  key: string,
  def: SettingDef,
  layoutIndex: number | 'extruder' | undefined,
  extruder: number,
  line: LayoutLine,
) => { index: number | undefined; ruleIndex: number | undefined };

/** The layout's slot as it is: an Extruder page's nozzle, or the fixed slot the layout names. */
export const plainSlots: SlotResolver = (_key, _def, layoutIndex, extruder) => {
  const index = layoutIndex === 'extruder' ? extruder : layoutIndex;
  return { index, ruleIndex: index };
};

export interface LineRef {
  /** Unique on its page: `<group>/<line index>`. */
  id: string;
  line: LayoutLine;
  group: LayoutGroup;
  label: string;
  options: OptionRef[];
  /** Orca's rules hide this row for the current values (only a search shows it then, greyed). */
  hiddenByRules: boolean;
}

export interface GroupRef {
  group: LayoutGroup;
  lines: LineRef[];
}

export interface PageEnv {
  mode: PanelMode;
  /** Nozzles of the printer (the Extruder page repeats per nozzle). */
  extruderCount: number;
  /** Effective value of an option as text (for page conditions such as the G-code flavor). */
  value(key: string): string | undefined;
}

/** Whether a row shows in `mode`: at its first option's mode and above; the "Other" page in Expert only. */
export function lineShownInMode(catalogue: SettingsCatalogue, page: LayoutPage, line: LayoutLine, mode: PanelMode): boolean {
  if (page.other) return mode === 'expert';
  return shownInMode(lineMode(catalogue, line), mode);
}

/** Whether a page shows for the printer: its `when` holds. */
export function pageActive(page: LayoutPage, env: Pick<PageEnv, 'value'>): boolean {
  return !page.when || page.when.oneOf.includes(env.value(page.when.key) ?? '');
}

/** The pages of `tab` the page strip shows, in Orca's order. */
export function tabPages(catalogue: LayoutCatalogue, tab: LayoutTab, env: PageEnv): PageRef[] {
  const pages: PageRef[] = [];
  for (const page of tab.pages) {
    if (page.other && env.mode !== 'expert') continue;
    if (!pageActive(page, env)) continue;
    const anyLine = page.groups.some((g) =>
      g.lines.some((l) => l.options.some((o) => isShown(catalogue, o.key)) && lineShownInMode(catalogue, page, l, env.mode)),
    );
    if (!anyLine) continue;
    if (page.repeat === 'extruder') {
      const count = Math.max(1, env.extruderCount);
      for (let i = 0; i < count; i++) {
        pages.push({ tab, page, id: `${page.id}#${i}`, title: count > 1 ? `${page.title} ${i + 1}` : page.title, extruder: i });
      }
    } else {
      pages.push({ tab, page, id: page.id, title: page.title });
    }
  }
  return pages;
}

/** The option refs of a layout line, with the slot resolved for nozzle `extruder`. */
export function lineOptions(catalogue: LayoutCatalogue, line: LayoutLine, extruder = 0, slots: SlotResolver = plainSlots): OptionRef[] {
  const out: OptionRef[] = [];
  for (const layout of line.options) {
    const def = settingDef(catalogue, layout.key);
    if (!isShown(catalogue, layout.key, def)) continue;
    const { index, ruleIndex } = slots(layout.key, def, layout.index, extruder, line);
    out.push({ key: layout.key, def, layout, index, ruleIndex, label: readableLabel(layout.key, layout.label ?? def.label) });
  }
  return out;
}

/** Whether Orca's rules hide this row (a row of several options hides when any of them is hidden). */
export function lineHidden(options: readonly OptionRef[], rules: TabRules | undefined): boolean {
  return !!rules && options.some((o) => isHidden(rules, o.key, o.ruleIndex));
}

/**
 * Whether a row edits an option stored per nozzle variant as a whole (a Process, Filament or Motion
 * ability row): with several nozzles, which nozzle's value it shows is picked above the page.
 */
export function isVariantLine(catalogue: SettingsCatalogue, line: LayoutLine): boolean {
  return line.options.some((o) => o.index !== 'extruder' && settingDef(catalogue, o.key)?.slots === 'variant');
}

/** Whether a page has rows that show one nozzle's value of a per-variant option (the nozzle picker's pages). */
export function pageHasVariantRows(catalogue: SettingsCatalogue, page: LayoutPage): boolean {
  return page.repeat !== 'extruder' && page.groups.some((g) => g.lines.some((l) => isVariantLine(catalogue, l)));
}

/** The label of a row; Orca's rules may rename a single-option row. */
export function rowLabel(catalogue: SettingsCatalogue, line: LayoutLine, options: readonly OptionRef[], rules?: TabRules): string {
  if (options.length === 1 && line.label === undefined) {
    const renamed = rules?.labels.get(options[0].key);
    if (renamed) return renamed;
  }
  return readableLabel(line.options[0].key, lineLabel(catalogue, line));
}

/**
 * A label for people: Orca gives some options (mostly develop ones) no label, and the catalogue then uses
 * the key; "enable_pre_heating" reads as "Enable pre heating".
 */
export function readableLabel(key: string, label: string): string {
  if (label !== key || !/_/.test(key)) return label;
  const words = key.replace(/_+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One line of a group as a row, or null when `omit` leaves nothing of it to show. */
export function lineRef(
  catalogue: LayoutCatalogue,
  group: LayoutGroup,
  line: LayoutLine,
  index: number,
  extruder: number | undefined,
  rules: TabRules | undefined,
  slots?: SlotResolver,
): LineRef | null {
  const options = lineOptions(catalogue, line, extruder ?? 0, slots);
  if (options.length === 0) return null;
  return {
    id: `${group.id}/${index}`,
    line,
    group,
    label: rowLabel(catalogue, line, options, rules),
    options,
    hiddenByRules: lineHidden(options, rules),
  };
}

/**
 * The groups and rows of a page for the current mode. Rows Orca's rules hide are left out, or listed in
 * `hidden` when given. Groups left with no rows are dropped. An Extruder page shows its own nozzle; other
 * pages show `extruder`'s values of per-variant options.
 */
export function pageGroups(
  catalogue: LayoutCatalogue,
  page: PageRef,
  mode: PanelMode,
  rules?: TabRules,
  slots?: SlotResolver,
  extruder = 0,
  hidden?: LineRef[],
): GroupRef[] {
  const groups: GroupRef[] = [];
  for (const group of page.page.groups) {
    const lines: LineRef[] = [];
    group.lines.forEach((line, i) => {
      if (!lineShownInMode(catalogue, page.page, line, mode)) return;
      const ref = lineRef(catalogue, group, line, i, page.extruder ?? extruder, rules, slots);
      if (!ref) return;
      if (!ref.hiddenByRules) lines.push(ref);
      else hidden?.push(ref);
    });
    if (lines.length > 0) groups.push({ group, lines });
  }
  return groups;
}

/** Where every placed option is: tab, page and group. */
export interface KeyPlace {
  scope: SettingScope;
  tab: LayoutTab;
  page: LayoutPage;
  group: LayoutGroup;
  line: LayoutLine;
  lineIndex: number;
}

const places = new WeakMap<SettingsCatalogue, Map<string, KeyPlace>>();

/** The row that shows option `key`, or undefined for an option no tab shows. */
export function keyPlace(catalogue: SettingsCatalogue, key: string): KeyPlace | undefined {
  let index = places.get(catalogue);
  if (!index) {
    index = new Map();
    for (const tab of catalogue.tabs) {
      for (const page of tab.pages) {
        for (const group of page.groups) {
          group.lines.forEach((line, lineIndex) => {
            for (const option of line.options) {
              if (!index!.has(option.key)) index!.set(option.key, { scope: tab.id, tab, page, group, line, lineIndex });
            }
          });
        }
      }
    }
    places.set(catalogue, index);
  }
  return index.get(key);
}
