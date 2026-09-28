// The static part of a settings.view document (SettingsForm): the options' text and the layout, for one
// scope and one `omit` list. Built once per (scope, omit, one or several filaments) and cached; its id
// names the engine build too, so a client's cached form is never used with another engine's state.
import type { LayoutLine, SettingDef, SettingsCatalogue } from '../../../packages/protocol/src/catalogue.ts';
import type { FormLine, FormOption, FormPage, SettingsForm, SettingsScope } from '../../../packages/protocol/src/settings.ts';
import { lineLabel, lineMode, settingDef } from './catalogue.ts';
import { isShown, readableLabel, type LayoutCatalogue } from './layout.ts';
import { inPanelOrder, objectSettingKeys, objectSettingLabel } from './object.ts';
import { controlKind } from './text.ts';

/** A short hash of a string (64-bit FNV-1a, two lanes), hex. */
export function shortHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** A form option: Orca's definition in the form's terms. `label` overrides the definition's. */
export function formOption(key: string, def: SettingDef, label?: string): FormOption {
  const option: FormOption = {
    key,
    type: def.type,
    control: controlKind(def),
    label: label ?? readableLabel(key, def.label),
    mode: def.mode,
  };
  if (def.fullLabel !== undefined && def.fullLabel !== option.label) option.fullLabel = def.fullLabel;
  if (def.tooltip) option.tooltip = def.tooltip;
  if (def.unit) option.unit = def.unit;
  if (def.category) option.category = def.category;
  if (def.min !== undefined) option.min = def.min;
  if (def.max !== undefined) option.max = def.max;
  if (def.maxLiteral !== undefined) option.maxLiteral = def.maxLiteral;
  if (def.ratioOver) option.ratioOver = def.ratioOver;
  if (def.enumValues) option.enum = def.enumValues.map((value, i) => ({ value, label: def.enumLabels?.[i] || value }));
  if (def.openEnum) option.openEnum = true;
  if (def.multiline) option.multiline = true;
  if (def.code) option.code = true;
  if (def.serialized) option.serialized = true;
  if (def.nullable) option.nullable = true;
  if (def.slots) option.slots = def.slots;
  if (def.orcaReadOnly) option.readOnly = true;
  if (def.default !== undefined) option.default = def.default;
  return option;
}

/** The form line of layout line `line` (`id` given), or null when `omit` leaves none of its options. */
export function formLine(catalogue: LayoutCatalogue, line: LayoutLine, id: string, options: Record<string, FormOption>): FormLine | null {
  const shown = line.options.filter((o) => isShown(catalogue, o.key));
  if (shown.length === 0) return null;
  const out: FormLine = {
    id,
    label: readableLabel(line.options[0].key, lineLabel(catalogue, line)),
    mode: lineMode(catalogue, line),
    options: shown.map((o) => {
      const def = settingDef(catalogue, o.key)!;
      options[o.key] ??= formOption(o.key, def);
      return {
        key: o.key,
        label: readableLabel(o.key, o.label ?? def.label),
        ...(o.index !== undefined ? { index: o.index } : {}),
        ...(o.tooltip ? { tooltip: o.tooltip } : {}),
      };
    }),
  };
  const tooltip = line.tooltip ?? line.options[0].tooltip;
  if (tooltip) out.tooltip = tooltip;
  if (line.widget) out.widget = line.widget;
  if (line.overrideOf) out.overrideOf = line.overrideOf;
  if (line.modeColumns) out.modeColumns = true;
  return out;
}

/** The engine build a form belongs to: the catalogue's Orca and the host's version. */
function buildId(catalogue: SettingsCatalogue): string {
  return `${catalogue.orca.commit}|${catalogue.format}|${HOST_BUILD}`;
}

/** Set by the host at start (its version and commit), so forms of different builds never share an id. */
let HOST_BUILD = 'dev';
export function setHostBuild(id: string): void {
  HOST_BUILD = id;
  forms.clear();
}

const forms = new Map<string, SettingsForm>();

/** The form of `scope` for this catalogue's `omit` list (cached). */
export function settingsForm(catalogue: LayoutCatalogue, scope: SettingsScope, filamentCount = 1): SettingsForm {
  const omit = [...catalogue.omit].sort();
  const several = scope === 'object' && filamentCount > 1;
  const key = `${buildId(catalogue)}|${scope}|${several ? 'n' : '1'}|${omit.join(',')}`;
  let form = forms.get(key);
  if (form) return form;
  const options: Record<string, FormOption> = {};
  form = { format: 1, id: `${scope}:${shortHash(key)}`, scope, omit, options };
  if (scope === 'object') {
    const { categories } = objectSettingKeys(catalogue, filamentCount);
    form.categories = categories
      .map((c) => ({ title: c.title, keys: inPanelOrder(c.keys, catalogue).filter((k) => isShown(catalogue, k)) }))
      .filter((c) => c.keys.length > 0);
    for (const c of form.categories) for (const k of c.keys) options[k] = formOption(k, settingDef(catalogue, k)!, objectSettingLabel(catalogue, k));
    form.frequent = objectSettingKeys(catalogue, filamentCount).frequent.filter((k) => isShown(catalogue, k));
  } else if (scope === 'plate') {
    form.lines = catalogue.plate.map((line, i) => formLine(catalogue, line, `plate/${i}`, options)).filter((l): l is FormLine => l !== null);
  } else {
    const tab = catalogue.tabs.find((t) => t.id === scope)!;
    const pages: FormPage[] = [];
    for (const page of tab.pages) {
      const groups = page.groups
        .map((group) => ({
          id: group.id,
          title: group.title,
          lines: group.lines.map((line, i) => formLine(catalogue, line, `${page.id}/${group.id}/${i}`, options)).filter((l): l is FormLine => l !== null),
        }))
        .filter((g) => g.lines.length > 0);
      if (groups.length === 0) continue;
      const out: FormPage = { id: page.id, title: page.title, groups };
      if (page.repeat) out.repeat = page.repeat;
      if (page.when) out.when = page.when;
      if (page.other) out.other = true;
      pages.push(out);
    }
    form.pages = pages;
  }
  forms.set(key, form);
  return form;
}
