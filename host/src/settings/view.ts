// The dynamic part of a settings.view document: which pages, rows and cells of a form show for the
// current values, what Orca's rules grey out, rename or narrow, and Orca's issues. The Tab behaviour of the
// app's settings panel (pages per mode and printer, the nozzle picker, the machine limits' silent column,
// the filament overrides' inherited values), its object settings list and its plate settings dialog.
//
// Provenance: the row and cell logic is ported on 2026-09-28 from the Muon3D Slicer app (Muon 3D
// Technologies' own code: web/src/components/AllSettings.tsx, ObjectSettingsSection.tsx and
// web/src/settings/PlateSettingsForm.tsx); part of this repository and licensed like it (AGPL-3.0-only).
import type { SettingScope } from '../../../packages/protocol/src/catalogue.ts';
import type { ConfigPatch } from '../../../packages/protocol/src/data.ts';
import type {
  ObjectRow,
  ObjectView,
  PlateRow,
  PlateView,
  SettingIssue,
  SettingsEnv,
  TabView,
  ViewCell,
  ViewLine,
  ViewPage,
} from '../../../packages/protocol/src/settings.ts';
import { settingDef } from './catalogue.ts';
import { pageActive, pageGroups, pageHasVariantRows, tabPages, type LineRef, type OptionRef, type PageEnv } from './layout.ts';
import { currentOf, currentSlot, evaluate, extruderCount, inheritedSlot, slotResolver, type SettingsState } from './model.ts';
import {
  addGroups,
  evaluateObject,
  inheritedValue,
  isSupportSetting,
  layerHeightLimits,
  objectSettingKeys,
  objectSettingRows,
  planObjectValues,
} from './object.ts';
import { plateRulesEnv, spiralNeedsByObject, SPIRAL_NEEDS_BY_OBJECT } from './plate.ts';
import { evaluateRules, isDisabled, isHidden, type RuleIssue, type TabRules } from './rules.ts';
import { isOn, valueText } from './text.ts';
import { settingsForm } from './form.ts';

const toIssue = (issue: RuleIssue): SettingIssue => {
  const out: SettingIssue = { id: issue.id, scope: issue.scope, key: issue.key, keys: [...issue.keys], severity: issue.severity, message: issue.message };
  if (issue.fix) out.fix = { ...issue.fix };
  if (issue.fixLabel) out.fixLabel = issue.fixLabel;
  if (issue.alternative) out.alternative = { label: issue.alternative.label, values: { ...issue.alternative.values } };
  if (issue.triggers) out.triggers = [...issue.triggers];
  if (issue.checkedOn) out.checkedOn = [...issue.checkedOn];
  return out;
};

// ---------------------------------------------------------------------------------------------
// Preset tabs
// ---------------------------------------------------------------------------------------------

/** The page environment of the page strip: the mode, the nozzles, the values page conditions read. */
function pageEnv(state: SettingsState, config: { get(key: string): unknown }): PageEnv {
  return {
    mode: state.mode ?? 'advanced',
    extruderCount: extruderCount(state),
    value: (key) => {
      const v = (config.get(key) as string | string[] | undefined) ?? settingDef(state.catalogue, key)?.default;
      return v === undefined ? undefined : valueText(key, v);
    },
  };
}

function lineView(state: SettingsState, scope: SettingScope, pageId: string, line: LineRef, rules: TabRules, values: boolean): ViewLine {
  const layout = line.line;
  // Machine limits: a second column for the silent mode while the printer has one. Each nozzle variant
  // has its normal/silent pair: the option's slot is the pair's first.
  const silent = layout.modeColumns === true && isOn(currentSlot(state, 'machine', 'silent_mode'));
  const cells: Array<OptionRef & { column?: string }> = silent
    ? line.options.flatMap((o) => [
        { ...o, index: o.index ?? 0, ruleIndex: 0, column: 'Normal' },
        { ...o, index: (o.index ?? 0) + 1, ruleIndex: 1, column: 'Silent' },
      ])
    : line.options;
  const overrideFrom = layout.overrideOf;
  const out: ViewLine = {
    id: `${pageId}/${line.id}`,
    cells: cells.map((c) => {
      const cell: ViewCell = { key: c.key };
      if (c.index !== undefined) cell.index = c.index;
      if (c.column) cell.label = c.column;
      if (isDisabled(rules, c.key, c.ruleIndex)) cell.disabled = true;
      const choices = rules.enumFilters.get(c.key);
      if (choices) cell.choices = [...choices];
      if (values) {
        cell.value = currentSlot(state, scope, c.key, c.index);
        if (overrideFrom) cell.inherited = inheritedSlot(state, overrideFrom, c.index ?? 0);
      }
      return cell;
    }),
  };
  // Orca renamed a one-option row (rowLabel took the rules' label).
  if (line.options.length === 1 && layout.label === undefined && rules.labels.get(line.options[0].key)) out.label = line.label;
  if (overrideFrom && rules.lockedOverrides.has(line.options[0].key)) out.locked = true;
  return out;
}

/** The dynamic state of a preset tab, and the issues of its scope. */
export function tabView(state: SettingsState, scope: SettingScope, env: SettingsEnv, values: boolean): { tab: TabView; issues: SettingIssue[] } {
  const { env: rulesEnv, result } = evaluate(state);
  const rules = result[scope];
  const mode = state.mode ?? 'advanced';
  const catalogue = state.catalogue;
  const tab = catalogue.tabs.find((t) => t.id === scope)!;
  const penv = pageEnv(state, rulesEnv.config);
  const nozzles = extruderCount(state);
  const extruder = Math.max(0, Math.min(Math.floor(env.extruder ?? 0), nozzles - 1));
  const slots = slotResolver(state, scope);
  const issues = result.issues.filter((i) => i.scope === scope);
  // The form's page ids: an omitted page (no options left) is not in the form.
  const form = settingsForm(catalogue, scope);
  const formPages = new Set(form.pages!.map((p) => p.id));

  const pages: ViewPage[] = [];
  for (const ref of tabPages(catalogue, tab, penv)) {
    const hidden: LineRef[] = [];
    const groups = pageGroups(catalogue, ref, mode, rules, slots, extruder, hidden);
    const keys = new Set(groups.flatMap((g) => g.lines.flatMap((l) => l.options.map((o) => o.key))));
    const page: ViewPage = {
      id: ref.id,
      page: ref.page.id,
      title: ref.title,
      groups: groups.map((g) => ({ id: g.group.id, lines: g.lines.map((l) => lineView(state, scope, ref.page.id, l, rules, values)) })),
    };
    if (ref.extruder !== undefined) page.extruder = ref.extruder;
    if (nozzles > 1 && pageHasVariantRows(catalogue, ref.page)) page.nozzlePicker = true;
    const count = issues.filter((i) => keys.has(i.key) && i.severity !== 'info').length;
    if (count > 0) page.issues = count;
    if (hidden.length > 0) page.hiddenLines = hidden.map((l) => `${ref.page.id}/${l.id}`);
    pages.push(page);
  }
  const inactivePages = tab.pages.filter((p) => formPages.has(p.id) && !pageActive(p, penv)).map((p) => p.id);
  return { tab: { pages, inactivePages, extruders: nozzles, extruder }, issues: issues.map(toIssue) };
}

// ---------------------------------------------------------------------------------------------
// An object's settings
// ---------------------------------------------------------------------------------------------

export function objectView(
  state: SettingsState,
  settings: ConfigPatch | undefined,
  env: SettingsEnv,
  values: boolean,
): { object: ObjectView; issues: SettingIssue[] } {
  const catalogue = state.catalogue;
  const filamentCount = state.filamentCount ?? 1;
  const known = objectSettingKeys(catalogue, filamentCount).keys;
  const rules = evaluateObject(state, settings);
  const tab = rules.result.process;
  const supportOn = isOn(String(rules.env.config.get('enable_support') ?? '0'));
  const groups = objectSettingRows(settings, catalogue, filamentCount).map((group) => ({
    title: group.title,
    rows: group.keys.map((key): ObjectRow => {
      const row: ObjectRow = { key };
      if (!known.has(key) || !settingDef(catalogue, key)) {
        row.unknown = true;
      } else {
        const disabled = isHidden(tab, key) || isDisabled(tab, key);
        if (disabled) row.disabled = isSupportSetting(key) && !supportOn ? 'support' : 'rules';
        const renamed = tab.labels.get(key);
        if (renamed) row.label = renamed;
        const choices = tab.enumFilters.get(key);
        if (choices) row.choices = [...choices];
      }
      if (values) {
        row.value = settings![key];
        if (!row.unknown) row.inherited = inheritedValue(state, key);
      }
      return row;
    }),
  }));
  const form = settingsForm(catalogue, 'object', filamentCount);
  const issues = rules.issues.map((i) => {
    const issue = toIssue(i);
    if (i.fix) issue.fixable = planObjectValues(settings, i.fix, known) !== null;
    return issue;
  });
  return {
    object: {
      groups,
      add: addGroups(catalogue, state.mode ?? 'advanced', env.frequent ?? form.frequent ?? [], filamentCount),
      limits: { layerHeight: layerHeightLimits(state) },
    },
    issues,
  };
}

// ---------------------------------------------------------------------------------------------
// A plate's settings
// ---------------------------------------------------------------------------------------------

export function plateView(state: SettingsState, settings: ConfigPatch, objectCount: number): { plate: PlateView; issues: SettingIssue[] } {
  const form = settingsForm(state.catalogue, 'plate');
  const env = plateRulesEnv(state, settings, objectCount);
  const rules = evaluateRules(env).process;
  const rows = form.lines!.map((line): PlateRow => {
    const key = line.options[0].key;
    const row: PlateRow = { key, global: currentOf(state, 'process', key) };
    if (Object.hasOwn(settings, key)) row.value = settings[key];
    const choices = rules.enumFilters.get(key);
    if (choices) row.choices = [...choices];
    return row;
  });
  const issues: SettingIssue[] = [];
  const sequence = settings.print_sequence ?? (currentOf(state, 'process', 'print_sequence') || 'by layer');
  const spiral = settings.spiral_mode !== undefined ? isOn(settings.spiral_mode) : isOn(currentOf(state, 'process', 'spiral_mode'));
  if (spiralNeedsByObject(spiral, sequence, objectCount)) {
    issues.push({
      id: 'spiral-vase-by-object',
      scope: 'process',
      key: 'print_sequence',
      keys: ['print_sequence', 'spiral_mode'],
      severity: 'error',
      message: SPIRAL_NEEDS_BY_OBJECT,
      fix: { print_sequence: 'by object' },
    });
  }
  return { plate: { rows }, issues };
}
