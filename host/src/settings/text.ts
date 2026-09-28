// Values of OrcaSlicer settings in Orca's text form, as the settings service reads and writes them. A
// value is Orca's text for the whole option (what a 3MF project or the command line holds, one string per
// setting), which is also what a client stores as an override:
//   - a scalar option (float, int, percent, "mm or %", bool, enum, point, string): the text;
//   - a vector per extruder, filament or variant: comma-separated slots, "0.4,0.6"; one slot means every
//     slot (Orca sizes these vectors to the extruder/filament count);
//   - a list (a polygon of points "0x0,200x0,...", a list of names): exactly the entries given;
//   - point groups: groups separated by "#";
//   - text lists (strings) with a text per slot: the text of one slot as it is (so G-code with ";"
//     comments stays whole), or Orca's quoted list when it starts with a double quote and reads as one
//     ("a";"b"); a list of names, and the few options Orca edits as one text (gui_flags "serialized"), are
//     always Orca's ";" list (A;"B C", and "" for one empty entry);
//   - bools are written "1"/"0" ("true"/"false" are read too), and "nil" leaves a slot of a nullable
//     option unset (the filament "Setting Overrides" then use the printer's value).
// A row edits one slot of a value (the extruder of an extruder page, a machine-limit column), and an edit
// that gives back the preset's value removes the override instead of storing a copy.
//
// Provenance: ported on 2026-09-28 from the Muon3D Slicer app (Muon 3D Technologies' own code:
// shared/overrides.ts and web/src/settings/values.ts); part of this repository and licensed like it
// (AGPL-3.0-only). Changed here: the option types come from the settings catalogue, and the app's policy
// (keys it refuses) and its display helpers are left out.
import type { ConfigValue } from '../../../packages/protocol/src/data.ts';
import type { OrcaOptionType, SettingDef } from '../../../packages/protocol/src/catalogue.ts';
import type { ControlKind } from '../../../packages/protocol/src/settings.ts';
import { CATALOGUE } from './catalogue.ts';

const REAL_OPTIONS = Object.entries(CATALOGUE.options).filter(([, def]) => !def.synthetic);
const OPTION_TYPES: Readonly<Record<string, OrcaOptionType>> = Object.fromEntries(REAL_OPTIONS.map(([key, def]) => [key, def.type]));
const NULLABLE_OPTIONS: ReadonlySet<string> = new Set(REAL_OPTIONS.filter(([, def]) => def.nullable).map(([key]) => key));
const SERIALIZED_OPTIONS: ReadonlySet<string> = new Set(REAL_OPTIONS.filter(([, def]) => def.serialized).map(([key]) => key));
/** Vector options whose entries are the value itself (a polygon, a list of names), not one value per slot. */
export const LIST_OPTIONS: ReadonlySet<string> = new Set(REAL_OPTIONS.filter(([, def]) => def.slots === 'list').map(([key]) => key));

/** A value the service cannot read as its option's type; the message says why. */
export class OverrideError extends Error {}

/** Orca's type of option `key`, or undefined when it defines no such option. */
export function optionType(key: string): OrcaOptionType | undefined {
  return Object.hasOwn(OPTION_TYPES, key) ? OPTION_TYPES[key] : undefined;
}

const COMMA_VECTORS: ReadonlySet<OrcaOptionType> = new Set(['floats', 'ints', 'percents', 'floatsOrPercents', 'bools', 'enums', 'points']);
const GROUP_VECTORS: ReadonlySet<OrcaOptionType> = new Set(['pointsGroups', 'intsGroups']);
const isList = (key: string) => LIST_OPTIONS.has(key);

const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
// Orca splits a point at a lower-case "x" only (ConfigOptionPoint(s)::deserialize).
const POINT = new RegExp(`^${NUMBER}\\s*x\\s*${NUMBER}$`);
const POINT_SCALAR = new RegExp(`^${NUMBER}\\s*[,x]\\s*${NUMBER}$`);

/** Orca's escape_string_cstyle: backslash, double quote, CR and LF escaped. */
function escapeCString(text: string): string {
  return text.replace(/[\\"\r\n]/g, (c) => ({ '\\': '\\\\', '"': '\\"', '\r': '\\r', '\n': '\\n' })[c]!);
}

/** Orca's escape_strings_cstyle: entries joined with ";", quoted when they hold blanks, ";", quotes or line breaks. */
function escapeStrings(entries: readonly string[]): string {
  return entries.map((s) => (/[ \t;\\"\r\n]/.test(s) || (entries.length === 1 && s === '') ? `"${escapeCString(s)}"` : s)).join(';');
}

/** Orca's unescape_strings_cstyle, or null where Orca would fail to read the text. */
function unescapeStrings(text: string): string[] | null {
  const out: string[] = [];
  if (text === '') return out;
  let i = 0;
  const skipBlanks = () => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  };
  for (;;) {
    skipBlanks();
    if (i === text.length) return out;
    let entry = '';
    if (text[i] === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\') {
          if (++i === text.length) return null;
          entry += text[i] === 'r' ? '\r' : text[i] === 'n' ? '\n' : text[i];
        } else {
          entry += text[i];
        }
      }
      if (i === text.length) return null;
      i++;
    } else {
      for (; i < text.length && text[i] !== ';'; i++) entry += text[i];
    }
    out.push(entry);
    if (i === text.length) return out;
    skipBlanks();
    if (i === text.length) return out;
    if (text[i] !== ';') return null;
    if (++i === text.length) {
      out.push('');
      return out;
    }
  }
}

const normaliseBool = (slot: string) => (/^true$/i.test(slot) ? '1' : /^false$/i.test(slot) ? '0' : slot);

/**
 * The slot values the text `text` holds for option `key`. A scalar option, and a key Orca does not
 * define, hold one value: the text. Throws OverrideError when the text cannot be read as the option's
 * type: points that are not "XxY", a broken list of names or serialized list, or "nil" for an option that
 * cannot be left unset.
 */
export function overrideSlots(key: string, text: string): string[] {
  const type = optionType(key);
  let slots: string[];
  if (type === 'strings') {
    if (SERIALIZED_OPTIONS.has(key) || isList(key)) {
      const list = unescapeStrings(text);
      if (!list) throw new OverrideError(`The value for "${key}" is not a valid list of texts (Orca's a;"b c" form).`);
      slots = list;
    } else {
      // A slot's text that starts with a quote but is no quoted list ("quoted" G-code) is just text.
      slots = (text.startsWith('"') ? unescapeStrings(text) : null) ?? [text];
    }
  } else if (type && COMMA_VECTORS.has(type)) {
    slots = text === '' ? (type === 'points' ? [] : ['']) : text.split(',').map((s) => s.trim());
  } else if (type && GROUP_VECTORS.has(type)) {
    slots = text === '' ? [] : text.split('#').map((s) => s.trim());
  } else {
    slots = [text];
  }
  if (type === 'bool' || type === 'bools') slots = slots.map(normaliseBool);
  if (type === 'points' && slots.some((p) => !POINT.test(p))) {
    throw new OverrideError(`The value for "${key}" must be points written like 0x0,200x0 (found "${text.slice(0, 60)}").`);
  }
  if (type === 'point' && !POINT_SCALAR.test(text)) {
    throw new OverrideError(`The value for "${key}" must be a point written like 10,20 (found "${text.slice(0, 60)}").`);
  }
  if (type && type !== 'strings' && type !== 'string' && !NULLABLE_OPTIONS.has(key) && slots.includes('nil')) {
    throw new OverrideError(`The setting "${key}" cannot be left unset ("nil").`);
  }
  return slots;
}

/** The text for slot values of option `key`: the inverse of overrideSlots. */
export function overrideText(key: string, slots: readonly string[]): string {
  const type = optionType(key);
  if (type === 'strings') {
    if (SERIALIZED_OPTIONS.has(key) || isList(key)) return escapeStrings(slots);
    if (slots.length === 1 && !slots[0].startsWith('"')) return slots[0];
    return slots.map((s) => `"${escapeCString(s)}"`).join(';');
  }
  if (type && COMMA_VECTORS.has(type)) return slots.join(',');
  if (type && GROUP_VECTORS.has(type)) return slots.join('#');
  if (slots.length !== 1) throw new OverrideError(`"${key}" holds one value, not ${slots.length}.`);
  return slots[0];
}

/** The text that reproduces the preset JSON value `value` of option `key`. */
export function presetValueText(key: string, value: ConfigValue): string {
  if (Array.isArray(value)) return overrideText(key, value);
  // A plain string in a preset is Orca's serialized text of the whole option; only a text list reads
  // differently here (one slot's text unless quoted).
  return optionType(key) === 'strings' ? overrideText(key, unescapeStrings(value) ?? [value]) : value;
}

// ---------------------------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------------------------

/** The slot values of `text` for option `key`, or the text as one slot when Orca could not read it. */
export function slotsOf(key: string, text: string): string[] {
  try {
    return overrideSlots(key, text);
  } catch {
    return [text];
  }
}

/** Slot `index` of `slots`: one value stands for every slot (as Orca's vectors are resized). */
export function slotValue(slots: readonly string[], index = 0): string {
  return slots[index] ?? slots[0] ?? '';
}

/** Orca's text for a preset JSON value of `key` (a string, or an array per slot). */
export function valueText(key: string, value: ConfigValue): string {
  try {
    return presetValueText(key, value);
  } catch {
    return Array.isArray(value) ? value.join(',') : value;
  }
}

/** The value without an override: the preset's, else Orca's default, as text. */
export function baseText(key: string, def: SettingDef | undefined, preset: ConfigValue | undefined): string {
  if (preset !== undefined) return valueText(key, preset);
  if (def?.default !== undefined) return valueText(key, def.default);
  return '';
}

const VECTOR_TYPES: ReadonlySet<OrcaOptionType> = new Set([
  'floats', 'ints', 'percents', 'floatsOrPercents', 'bools', 'enums', 'points', 'strings', 'pointsGroups', 'intsGroups',
]);

export function isVectorType(type: OrcaOptionType | undefined): boolean {
  return type !== undefined && VECTOR_TYPES.has(type);
}

/**
 * `text` with slot `index` set to `value`. A value standing for every slot is first spread over `count`
 * slots (the extruder count) so the other slots keep it; slots that end up all equal collapse back to one
 * value, which Orca spreads again. List options (a polygon, names) are one value as a whole and are
 * replaced.
 */
export function withSlot(key: string, text: string, index: number, value: string, count = 1): string {
  if (LIST_OPTIONS.has(key) || !isVectorType(optionType(key))) return value;
  const slots = slotsOf(key, text);
  const size = Math.max(slots.length, count, index + 1);
  const next = Array.from({ length: size }, (_, i) => slotValue(slots, i));
  next[index] = value;
  const collapsed = next.every((s) => s === next[0]) ? [next[0]] : next;
  return overrideText(key, collapsed);
}

const NUMBER_TYPES: ReadonlySet<OrcaOptionType> = new Set(['float', 'floats', 'int', 'ints', 'percent', 'percents', 'floatOrPercent', 'floatsOrPercents']);

/** "15%" -> { n: 15, percent: true }; null when it is not a number. */
export function readNumber(text: string): { n: number; percent: boolean } | null {
  const trimmed = text.trim();
  const percent = trimmed.endsWith('%');
  const body = (percent ? trimmed.slice(0, -1) : trimmed).trim();
  if (body === '' || !/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(body)) return null;
  const n = Number(body);
  return Number.isFinite(n) ? { n, percent } : null;
}

const boolValue = (text: string) => (/^(1|true)$/i.test(text.trim()) ? '1' : /^(0|false)$/i.test(text.trim()) ? '0' : text.trim());

export const isOn = (text: string) => boolValue(text) === '1';

/** Whether two slot values mean the same for an option of `type` ("0.20" = "0.2", "true" = "1"). */
export function sameSlot(type: OrcaOptionType | undefined, a: string, b: string): boolean {
  if (a === b) return true;
  if (type === 'bool' || type === 'bools') return boolValue(a) === boolValue(b);
  if (type && NUMBER_TYPES.has(type)) {
    const x = readNumber(a);
    const y = readNumber(b);
    return x !== null && y !== null && x.percent === y.percent && Math.abs(x.n - y.n) < 1e-9;
  }
  if (type === 'string' || type === 'strings') return false;
  return a.trim() === b.trim();
}

/** Whether two texts of option `key` mean the same value (one slot equals every slot of the other). */
export function sameText(key: string, a: string, b: string): boolean {
  if (a === b) return true;
  const type = optionType(key);
  const x = slotsOf(key, a);
  const y = slotsOf(key, b);
  if (x.length !== y.length && (LIST_OPTIONS.has(key) || (x.length !== 1 && y.length !== 1))) return false;
  const size = Math.max(x.length, y.length);
  for (let i = 0; i < size; i++) if (!sameSlot(type, slotValue(x, i), slotValue(y, i))) return false;
  return true;
}

/** The override to store for the value `text`: null when it is the base value (no override). */
export function overrideFor(key: string, text: string, base: string): string | null {
  return sameText(key, text, base) ? null : text;
}

/** The control that edits one slot of an option. */
export function controlKind(def: SettingDef): ControlKind {
  switch (def.type) {
    case 'bool':
    case 'bools':
      return 'bool';
    case 'enum':
    case 'enums':
      return def.openEnum ? 'suggest' : 'enum';
    case 'float':
    case 'floats':
    case 'int':
    case 'ints':
    case 'percent':
    case 'percents':
      return def.openEnum && def.enumValues?.length ? 'suggest' : 'number';
    case 'floatOrPercent':
    case 'floatsOrPercents':
      return def.openEnum && def.enumValues?.length ? 'suggest' : 'floatOrPercent';
    case 'point':
      return 'point';
    case 'points':
      return def.slots === 'list' ? 'text' : 'point';
    case 'string':
    case 'strings':
      if (def.gui === 'color') return 'color';
      if (def.multiline) return 'code';
      if (def.openEnum && def.enumValues?.length) return 'suggest';
      return 'text';
    default:
      return 'text';
  }
}
