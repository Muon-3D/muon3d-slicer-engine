// Test helper: setting overrides as text (Orca's serialized form of a value) turned into the JSON shape
// a flattened preset stores, by the option's type; used by test/settingsOverrides.e2e.test.ts to check
// that overrides of every kind of option reach the engine's G-code.
//
// Provenance: copied on 2026-09-27 from the Muon3D Slicer app (shared/overrides.ts: applyOverrides,
// presetValueText, pinProcessToPrinterName and what they use). It is Muon 3D Technologies' own code;
// this copy is part of the engine repository and licensed like it (AGPL-3.0-only). Changed here: the
// option types come from the committed settings catalogue (data/settings-catalogue.json) instead of
// the app's generated table, and the app's policy (keys it refuses to override) is left out.
//
// What an override means, by option type:
//   - a scalar option (float, int, percent, "mm or %", bool, enum, point, string): the text;
//   - a vector per extruder, filament or variant: comma-separated slots, "0.4,0.6"; one slot means
//     every slot (Orca sizes these vectors to the extruder/filament count);
//   - a list (a polygon of points "0x0,200x0,...", a list of names): exactly the entries given;
//   - point groups: groups separated by "#";
//   - text lists (strings) with a text per slot: the text of one slot as it is (so G-code with ";"
//     comments stays whole), or Orca's quoted list when it starts with a double quote and reads as
//     one ("a";"b"); a list of names, and the few options Orca edits as one text (gui_flags
//     "serialized"), are always Orca's ";" list (A;"B C", and "" for one empty entry);
//   - bools are written "1"/"0" ("true"/"false" are read too), and "nil" leaves a slot of a
//     nullable option unset (the filament "Setting Overrides" then use the printer's value).
import { readFileSync } from 'node:fs';
import type { Config as FlatConfig, ConfigValue } from '../../packages/protocol/src/data.ts';
import type { OrcaOptionType, SettingsCatalogue } from '../../packages/protocol/src/catalogue.ts';

const catalogue = JSON.parse(readFileSync(new URL('../../data/settings-catalogue.json', import.meta.url), 'utf8')) as SettingsCatalogue;
const REAL_OPTIONS = Object.entries(catalogue.options).filter(([, def]) => !def.synthetic);
/** Orca's type of every option, by key. */
const OPTION_TYPES: Readonly<Record<string, OrcaOptionType>> = Object.fromEntries(REAL_OPTIONS.map(([key, def]) => [key, def.type]));
/** Vector options whose slots may be "nil" (unset). */
const NULLABLE_OPTIONS: ReadonlySet<string> = new Set(REAL_OPTIONS.filter(([, def]) => def.nullable).map(([key]) => key));
/** Strings options Orca edits as one ";"-separated text (gui_flags "serialized"). */
const SERIALIZED_OPTIONS: ReadonlySet<string> = new Set(REAL_OPTIONS.filter(([, def]) => def.serialized).map(([key]) => key));
/** Vector options whose entries are the value itself (a polygon, a list of names), not one value per slot. */
const LIST_OPTIONS: ReadonlySet<string> = new Set(REAL_OPTIONS.filter(([, def]) => def.slots === 'list').map(([key]) => key));

/** An override that cannot be applied; the message says why. */
export class OverrideError extends Error {}

const SETTING_NAME = /^[A-Za-z0-9_]+$/;
/** The longest override text accepted. */
const MAX_OVERRIDE_LENGTH = 100_000;
/** Keys that identify the preset itself; changing them would make Orca misread the config. */
const PROTECTED_KEYS: ReadonlySet<string> = new Set(['inherits', 'name', 'from', 'type', 'instantiation']);

// ---------------------------------------------------------------------------------------------
// Option types and value text
// ---------------------------------------------------------------------------------------------

/** Orca's type of option `key` in the engine's Orca, or undefined when it defines no such option. */
export function optionType(key: string): OrcaOptionType | undefined {
  return Object.hasOwn(OPTION_TYPES, key) ? OPTION_TYPES[key] : undefined;
}

const COMMA_VECTORS: ReadonlySet<OrcaOptionType> = new Set(['floats', 'ints', 'percents', 'floatsOrPercents', 'bools', 'enums', 'points']);
const GROUP_VECTORS: ReadonlySet<OrcaOptionType> = new Set(['pointsGroups', 'intsGroups']);

const isVector = (type: OrcaOptionType) => COMMA_VECTORS.has(type) || GROUP_VECTORS.has(type) || type === 'strings';
/** The option is a list whose entries are the value (a polygon, names), not one value per slot. */
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
  return entries
    .map((s) => (/[ \t;\\"\r\n]/.test(s) || (entries.length === 1 && s === '') ? `"${escapeCString(s)}"` : s))
    .join(';');
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
 * The slot values the override text `text` holds for option `key` (see the top of this file). A
 * scalar option, and a key Orca does not define, hold one value: the text. Throws OverrideError
 * when the text cannot be read as the option's type: points that are not "XxY", a broken list of
 * names or serialized list, or "nil" for an option that cannot be left unset.
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

/** The override text for slot values of option `key`: the inverse of overrideSlots. */
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

/**
 * The preset JSON value the override text `text` gives option `key`, next to the preset's own
 * value `base`:
 *  - a vector with one slot per extruder, filament or variant: one value fills every slot the
 *    base has (at least one), several replace them; a preset that stores the option as a plain
 *    string (an older profile) keeps that shape for a single value;
 *  - a list (points, names): exactly the entries given;
 *  - a scalar: the text (in every slot when the preset stores it as an array);
 *  - a key the engine's Orca does not define (an older CLI's option): as a scalar.
 */
export function overrideValue(key: string, text: string, base: ConfigValue | undefined): ConfigValue {
  const type = optionType(key);
  const fill = (value: string) => new Array<string>(Math.max(Array.isArray(base) ? base.length : 1, 1)).fill(value);
  if (!type || !isVector(type)) {
    const [value] = overrideSlots(key, text);
    return Array.isArray(base) ? fill(value) : value;
  }
  const slots = overrideSlots(key, text);
  if (isList(key)) return slots;
  if (slots.length !== 1) return slots;
  // A text list stays an array: Orca would split a plain string at its ";".
  return typeof base === 'string' && type !== 'strings' ? slots[0] : fill(slots[0]);
}

/** The override text that reproduces the preset JSON value `value` of option `key`. */
export function presetValueText(key: string, value: ConfigValue): string {
  if (Array.isArray(value)) return overrideText(key, value);
  // A plain string in a preset is Orca's serialized text of the whole option; only a text list
  // reads differently here (one slot's text unless quoted).
  return optionType(key) === 'strings' ? overrideText(key, unescapeStrings(value) ?? [value]) : value;
}

// ---------------------------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------------------------

/**
 * Returns a copy of `config` with overrides applied: each value trimmed and converted to the
 * preset's JSON shape by the option's type (overrideValue). Throws OverrideError for names that
 * are not settings, protected keys, non-text, oversized or unreadable values.
 */
export function applyOverrides(config: FlatConfig, overrides: Record<string, string> | undefined): FlatConfig {
  const result = structuredClone(config);
  for (const [key, raw] of Object.entries(overrides ?? {})) {
    if (!SETTING_NAME.test(key) || key === '__proto__') throw new OverrideError(`Unknown setting name "${key}".`);
    if (PROTECTED_KEYS.has(key)) throw new OverrideError(`The setting "${key}" cannot be overridden.`);
    // Request bodies are JSON, so guard against numbers/booleans/objects sneaking in.
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      throw new OverrideError(`The value for "${key}" must be text.`);
    }
    const value = String(raw).trim();
    if (value.length > MAX_OVERRIDE_LENGTH) {
      throw new OverrideError(`The value for "${key}" is too long (the limit is ${MAX_OVERRIDE_LENGTH} characters).`);
    }
    result[key] = overrideValue(key, value, Object.hasOwn(config, key) ? config[key] : undefined);
  }
  return result;
}

/** True when a list setting has a non-empty entry; a plain string is a ";"-separated list (like Orca's). */
function hasPrinterList(value: FlatConfig[string] | undefined): boolean {
  const list = Array.isArray(value) ? value : (value ?? '').split(';');
  return list.some((entry) => entry.trim() !== '');
}

/**
 * The process config to slice next to the printer called `printerName` (the machine config's
 * `name`). The Orca CLI only matches compatible_printers against that name and ignores
 * compatible_printers_condition (clearing the condition does not help): a process that suits
 * the printer through its condition alone, like Prusa's "@CORE One" processes, fails with exit
 * code -17. Such a process gets the printer's name as its list; an explicit list is left alone
 * (the same object is returned). Whether the process suits the printer at all is the caller's
 * check (the server's catalog only offers compatible processes).
 */
export function pinProcessToPrinterName(processConfig: FlatConfig, printerName: string): FlatConfig {
  if (hasPrinterList(processConfig.compatible_printers)) return processConfig;
  return { ...processConfig, compatible_printers: [printerName] };
}
