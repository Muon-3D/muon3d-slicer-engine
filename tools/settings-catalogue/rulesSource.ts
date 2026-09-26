// Reads OrcaSlicer's C++ sources for the settings rules port (rules.ts): the fingerprint of each
// ported function, which detects Orca changing a rule, and a literal parse of the option
// definitions in PrintConfig.cpp, which the rules tests check keys, enum values and defaults against.
//
// Node-only (node:crypto, node:fs). Used by rules.test.ts and the settings generator; never
// imported by the app. Run it to refresh rules.ts after re-porting (see the end of this file):
//   node web/src/settings/rulesSource.ts          report what is out of date
//   node web/src/settings/rulesSource.ts --write  rewrite READ and RULES_PORTED_FROM in rules.ts
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The engine's Orca tree, the one rules.ts is ported from ($ORCA_WASM_ROOT/orca). */
export const ORCA_ENGINE_ROOT = `${process.env.ORCA_WASM_ROOT ?? '~/OrcaWasm'}/orca`;

/** C++ source with comments removed; strings and line breaks are kept. */
export function stripCppComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      // A digit separator (1'000) is not a character literal.
      if (c === "'" && /[0-9A-Fa-f]/.test(src[i - 1] ?? '') && /[0-9A-Fa-f]/.test(src[i + 1] ?? '')) {
        out += c;
        i++;
        continue;
      }
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, '');
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Index just past the bracket that closes the one at `open` (strings skipped; comments already stripped). */
function matchBracket(src: string, open: number): number {
  const opening = src[open];
  const closing = opening === '{' ? '}' : opening === '(' ? ')' : ']';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      i = j;
    } else if (c === opening) depth++;
    else if (c === closing && --depth === 0) return i + 1;
  }
  throw new Error(`unbalanced "${opening}" at offset ${open}`);
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every definition of `name` in `src` (comments stripped), from the name to its closing brace.
 * `name` is `Class::function` or a free function. A member defined inside its class body
 * (`static double f(...) { ... }`) is found by its unqualified name when no qualified one exists.
 */
export function findCppDefinitions(src: string, name: string): string[] {
  const code = stripCppComments(src.replace(/\r\n?/g, '\n'));
  const search = (text: string): string[] => {
    const found: string[] = [];
    const re = new RegExp(`(?<![\\w:.>])${escapeRe(text)}\\s*\\(`, 'g');
    for (let m = re.exec(code); m; m = re.exec(code)) {
      const paren = m.index + m[0].length - 1;
      const afterParams = matchBracket(code, paren);
      // A definition continues with qualifiers or an initializer list, then its body.
      const tail = /^\s*(?:const\s*|noexcept\s*|override\s*|final\s*|->\s*[\w:<>]+\s*)*(:[^;{]*)?\{/.exec(code.slice(afterParams));
      if (!tail) continue;
      // Not a call inside an expression: the text before the name must end a declaration
      // (a type, `static`, `inline`, a template closer, or a line start).
      const before = code.slice(Math.max(0, m.index - 200), m.index);
      if (!/(^|[\n;{}])\s*(template\s*<[^>]*>\s*)?([\w:<>,*&\s]+\s+[*&]?|)$/.test(before)) continue;
      if (/\b(return|else|new|throw|case)\s+$/.test(before)) continue;
      const bodyOpen = afterParams + tail[0].length - 1;
      found.push(code.slice(m.index, matchBracket(code, bodyOpen)));
      re.lastIndex = matchBracket(code, bodyOpen);
    }
    return found;
  };
  const qualified = search(name);
  if (qualified.length || !name.includes('::')) return qualified;
  return search(name.slice(name.lastIndexOf('::') + 2));
}

/** The text a rule fingerprint is taken of: comments dropped, every whitespace run one space. */
export function normaliseCpp(text: string): string {
  return stripCppComments(text.replace(/\r\n?/g, '\n')).replace(/\s+/g, ' ').trim();
}

/**
 * Fingerprint of a ported Orca function, in the format rules.ts `RULES_PORTED_FROM` stores:
 * `sha256:` + the hex SHA-256 of normaliseCpp() of every definition of `name` in `src`, joined
 * with "\n" (overloads in file order). Comment and formatting edits do not change it.
 */
export function cppFunctionHash(src: string, name: string): string {
  const defs = findCppDefinitions(src, name);
  if (!defs.length) throw new Error(`${name} is not defined in this file`);
  return `sha256:${createHash('sha256').update(defs.map(normaliseCpp).join('\n')).digest('hex')}`;
}

/**
 * Fingerprints of the given `<file relative to the Orca root>#<function>` ids against an Orca
 * checkout. The settings generator stores the result as `schema.orca.ruleSources`; rules.test.ts
 * compares it with RULES_PORTED_FROM. A function that cannot be found maps to `missing`.
 */
export function ruleSourceHashes(orcaRoot: string, ids: readonly string[]): Record<string, string> {
  const files = new Map<string, string>();
  const out: Record<string, string> = {};
  for (const id of ids) {
    const [file, name] = id.split('#');
    if (!files.has(file)) files.set(file, fs.readFileSync(`${orcaRoot}/${file}`, 'utf8'));
    try {
      out[id] = cppFunctionHash(files.get(file)!, name);
    } catch {
      out[id] = 'missing';
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Option definitions (a literal parse of PrintConfigDef, enough for checking the rules; the app's
// catalogue comes from the engine's configDefinitions() export instead)
// ---------------------------------------------------------------------------------------------

export interface OrcaDefinition {
  key: string;
  /** Orca's ConfigOptionType without the `co` prefix, lower camel case: float, floats, enum, ... */
  type: string;
  nullable: boolean;
  /** The values the combo box lists (def->enum_values). */
  enumValues: string[];
  /** Every name the option's enum accepts (its s_keys_map_*), a superset of enumValues; [] if not an enum. */
  enumKeys: string[];
  /** The default in Orca's text form (first slot for a vector), or undefined when not a plain literal. */
  default?: string;
  /** The default as written in C++, for messages. */
  defaultRaw?: string;
}

/**
 * `s_keys_map_<Enum>` tables of a PrintConfig.cpp: enum name -> (C++ constant without its
 * namespace -> Orca key), e.g. InfillPattern -> ipGyroid -> "gyroid".
 */
export function parseEnumKeyMaps(printConfigCpp: string): Map<string, Map<string, string>> {
  return enumKeyMaps(stripCppComments(printConfigCpp.replace(/\r\n?/g, '\n')));
}

function enumKeyMaps(src: string): Map<string, Map<string, string>> {
  const maps = new Map<string, Map<string, string>>();
  for (const m of src.matchAll(/s_keys_map_(\w+)\s*(?:=\s*)?\{/g)) {
    const open = m.index + m[0].length - 1;
    const table = src.slice(open, matchBracket(src, open));
    const entries = new Map<string, string>();
    for (const e of table.matchAll(/\{\s*"([^"]*)"\s*,\s*(?:int\()?\s*([\w:]+)\s*\)?\s*\}/g)) {
      entries.set(e[2].replace(/.*::/, ''), e[1]);
    }
    if (!maps.has(m[1])) maps.set(m[1], entries);
  }
  return maps;
}

function numberText(literal: string): string | undefined {
  const t = literal.trim().replace(/(?<=\d|\.)[fF]$/, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return undefined;
  return String(Number(t));
}

/** The first element of a `{a, b}` / `({a, b})` / `(a)` initializer. */
function firstElement(init: string): string {
  let t = init.trim();
  while (/^[({]/.test(t) && matchBracket(t, 0) === t.length) t = t.slice(1, -1).trim();
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '"') {
      i++;
      while (i < t.length && t[i] !== '"') i += t[i] === '\\' ? 2 : 1;
    } else if ('({['.includes(c)) depth++;
    else if (')}]'.includes(c)) depth--;
    else if (c === ',' && depth === 0) return t.slice(0, i).trim();
  }
  return t;
}

function unquote(text: string): string | undefined {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(text.trim());
  return m ? m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : undefined;
}

/** Values of the few macros PrintConfigDef uses as defaults (PrintConfigConstants.hpp). */
const DEFAULT_MACROS: Record<string, string> = {
  INITIAL_LAYER_HEIGHT: '0.2',
  INITIAL_RAFT_LAYERS: '0',
  INITIAL_REDUCE_CROSSING_WALL: 'false',
};

function defaultText(cls: string, init: string, enums: Map<string, Map<string, string>>): string | undefined {
  const type = cls.replace(/^ConfigOption/, '').replace(/Nullable$/, '');
  const enumMatch = /^Enum<(\w+)>$/.exec(type);
  const args = init.trim().slice(1, -1).trim();
  if (enumMatch) return enums.get(enumMatch[1])?.get(args.replace(/.*::/, ''));
  if (args === '') return /^Strings?$/.test(type) ? '' : undefined;
  const first = firstElement(init);
  if (/::nil_value\(\)$/.test(first)) return 'nil';
  const scalar = DEFAULT_MACROS[first] ?? first;
  switch (type) {
    case 'Float':
    case 'Int':
    case 'Floats':
    case 'Ints':
      return numberText(scalar);
    case 'Percent':
    case 'Percents': {
      const n = numberText(scalar);
      return n === undefined ? undefined : `${n}%`;
    }
    case 'Bool':
    case 'Bools':
      return scalar === 'true' || scalar === '1' ? '1' : scalar === 'false' || scalar === '0' ? '0' : undefined;
    case 'FloatOrPercent':
    case 'FloatsOrPercents': {
      // FloatOrPercent(0, false) or {FloatOrPercent(50, true)}
      const pair = type === 'FloatOrPercent' ? args : first.replace(/^FloatOrPercent\s*/, '').slice(1, -1);
      const m = /^\s*([^,]+),\s*(true|false)\s*$/.exec(pair);
      const n = m ? numberText(m[1]) : undefined;
      return n === undefined ? undefined : m![2] === 'true' ? `${n}%` : n;
    }
    case 'String':
    case 'Strings':
      return unquote(first);
    case 'EnumsGeneric': {
      const constant = firstElement(init).trim();
      const [enumName, value] = constant.includes('::') ? constant.split('::') : ['', constant];
      if (enumName) return enums.get(enumName)?.get(value);
      for (const table of enums.values()) if (table.has(value)) return table.get(value);
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Option definitions of a PrintConfig.cpp (engine Orca), keyed by option name. */
export function parseOrcaDefinitions(printConfigCpp: string): Map<string, OrcaDefinition> {
  const src = stripCppComments(printConfigCpp.replace(/\r\n?/g, '\n'));
  const enums = enumKeyMaps(src);
  const start = src.indexOf('void PrintConfigDef::init_common_params()');
  const end = src.indexOf('void PrintConfigDef::init_sla_params()');
  const body = src.slice(start, end < 0 ? undefined : end);
  const hits = [...body.matchAll(/this->add(_nullable)?\(\s*"([^"]+)"\s*,\s*co(\w+)\s*\)/g)];
  const defs = new Map<string, OrcaDefinition>();
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const block = body.slice(h.index, i + 1 < hits.length ? hits[i + 1].index : body.length);
    const type = h[3][0].toLowerCase() + h[3].slice(1);
    const enumValues = [...block.matchAll(/enum_values\.(?:push_back|emplace_back)\(\s*"([^"]*)"\s*\)/g)].map((m) => m[1]);
    const list = /enum_values\s*=\s*\{([^}]*)\}/.exec(block);
    if (list) enumValues.push(...[...list[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]));
    // The enum type: from enum_keys_map (&ConfigOptionEnum<T>::get_enum_values() or &s_keys_map_T),
    // else from the default's ConfigOptionEnum<T>.
    const enumType = /enum_keys_map\s*=\s*&\s*(?:ConfigOptionEnum<(\w+)>::get_enum_values\(\)|s_keys_map_(\w+))/.exec(block) ??
      /ConfigOptionEnum<(\w+)>/.exec(block);
    const enumKeys = enumType ? [...(enums.get(enumType[1] ?? enumType[2])?.values() ?? [])] : [];
    const dv = /set_default_value\(\s*new\s+(ConfigOption[\w<>]+)\s*/.exec(block);
    let def: string | undefined;
    let raw: string | undefined;
    if (dv) {
      const open = dv.index + dv[0].length;
      if ('({'.includes(block[open])) {
        const init = block.slice(open, matchBracket(block, open));
        raw = `${dv[1]}${init}`;
        def = defaultText(dv[1], init, enums);
      }
    }
    const nullable = !!h[1] || /def->nullable\s*=\s*true/.test(block) || /Nullable\b/.test(dv?.[1] ?? '');
    defs.set(h[2], { key: h[2], type, nullable, enumValues, enumKeys, default: def, defaultRaw: raw });
  }
  // The machine limits of each axis are made in a loop over `axes` rows { "x", {speed...},
  // {acceleration...}, {jerk...} }: this->add("machine_max_speed_" + axis.name, coFloats) with the
  // default new ConfigOptionFloats(axis.max_feedrate), and so on.
  const axisStruct = /struct\s+AxisDefault\s*\{([^}]*)\}/.exec(body);
  const axisRows = /std::vector<AxisDefault>\s+axes\s*\{/.exec(body);
  if (axisStruct && axisRows) {
    const fields = [...axisStruct[1].matchAll(/\b(\w+)\s*;/g)].map((m) => m[1]);
    const open = axisRows.index + axisRows[0].length - 1;
    const rowsText = body.slice(open + 1, matchBracket(body, open) - 1);
    const rows: string[][] = [];
    for (let i = rowsText.indexOf('{'); i >= 0; i = rowsText.indexOf('{', i)) {
      const end = matchBracket(rowsText, i);
      const row = rowsText.slice(i + 1, end - 1);
      const cells: string[] = [];
      for (let depth = 0, from = 0, j = 0; j <= row.length; j++) {
        const ch = row[j];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        if (j === row.length || (ch === ',' && depth === 0)) {
          cells.push(row.slice(from, j).trim());
          from = j + 1;
        }
      }
      rows.push(cells);
      i = end;
    }
    const adds = [...body.matchAll(/this->add\(\s*"(\w+)"\s*\+\s*axis\.name\s*,\s*co(\w+)\s*\)/g)];
    for (let a = 0; a < adds.length; a++) {
      const block = body.slice(adds[a].index, a + 1 < adds.length ? adds[a + 1].index : body.indexOf('}', adds[a].index));
      const column = fields.indexOf(/new\s+ConfigOption\w+\(\s*axis\.(\w+)\s*\)/.exec(block)?.[1] ?? '');
      const type = adds[a][2][0].toLowerCase() + adds[a][2].slice(1);
      for (const row of rows) {
        const name = unquote(row[0]) ?? '';
        const cell = column >= 0 ? row[column] : undefined;
        const fallback = cell ? numberText(firstElement(cell)) : undefined;
        defs.set(adds[a][1] + name, { key: adds[a][1] + name, type, nullable: false, enumValues: [], enumKeys: [], default: fallback, defaultRaw: cell });
      }
    }
  }
  // The filament "Setting Overrides" are made in a loop over filament_extruder_override_keys: each
  // copies the printer option without the prefix, made nullable, with every slot nil.
  const overrides = /filament_extruder_override_keys\s*=\s*\{([^}]*)\}/.exec(src);
  for (const m of overrides ? overrides[1].matchAll(/"(\w+)"/g) : []) {
    const base = defs.get(m[1].replace(/^filament_/, ''));
    if (base && !defs.has(m[1])) defs.set(m[1], { ...base, key: m[1], nullable: true, default: 'nil', defaultRaw: 'nil' });
  }
  return defs;
}

// ---------------------------------------------------------------------------------------------
// rules.ts bookkeeping: the keys it reads (its READ table) and its RULES_PORTED_FROM map
// ---------------------------------------------------------------------------------------------

/** The rules port this file maintains. */
export const RULES_TS = fileURLToPath(new URL('./rules.ts', import.meta.url));

/** The option types rules.ts reads (its OrcaKind). */
export const READABLE_TYPES: readonly string[] = [
  'float', 'floats', 'int', 'ints', 'bool', 'bools', 'percent', 'percents',
  'floatOrPercent', 'floatsOrPercents', 'enum', 'enums', 'string', 'strings',
];

/**
 * The option keys rules.ts reads: the first argument of every `c.num / bool / is / oneOf / text /
 * slots / isNil / withSlot('key', ...)` call, and every key of a `readKeys([...])` list (the keys
 * it reads in a loop). Sorted.
 */
export function rulesReadKeys(rulesTs: string): string[] {
  const code = stripCppComments(rulesTs.replace(/\r\n?/g, '\n'));
  const keys = new Set<string>();
  for (const m of code.matchAll(/\bc\.(?:num|bool|is|oneOf|text|slots|isNil|withSlot)\(\s*'([^']+)'/g)) keys.add(m[1]);
  for (const m of code.matchAll(/\breadKeys\(\s*\[([^\]]*)\]/g)) {
    for (const k of m[1].matchAll(/'([^']+)'/g)) keys.add(k[1]);
  }
  return [...keys].sort();
}

/** One READ entry: the key, Orca's option type and its default (slot 0 of a vector) in Orca's text. */
export type ReadEntry = readonly [key: string, type: string, fallback: string];

/**
 * READ entries for `keys` from the parsed definitions. Throws, naming each key, when a key is not
 * an Orca option, has a type the rules cannot read, or has a default the parser cannot evaluate.
 */
export function readTableEntries(keys: readonly string[], defs: ReadonlyMap<string, OrcaDefinition>): ReadEntry[] {
  const problems: string[] = [];
  const entries: ReadEntry[] = [];
  for (const key of keys) {
    const def = defs.get(key);
    if (!def) problems.push(`${key}: not an option in PrintConfig.cpp`);
    else if (!READABLE_TYPES.includes(def.type)) problems.push(`${key}: type ${def.type} is not readable`);
    else if (def.default === undefined) problems.push(`${key}: cannot evaluate the default ${def.defaultRaw ?? '(none)'}`);
    else entries.push([key, def.type, def.default]);
  }
  if (problems.length) throw new Error(`READ table:\n  ${problems.join('\n  ')}`);
  return entries;
}

const quote = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

/** The lines of rules.ts's READ table for `entries`. */
export function readTableSource(entries: readonly ReadEntry[]): string {
  return entries.map(([key, type, fallback]) => `  ${key}: [${quote(type)}, ${quote(fallback)}],\n`).join('');
}

const READ_MARKER = '// @generated-read-table';

/** The READ table lines as written in rules.ts (between the marker line and the closing `};`). */
export function readTableInRules(rulesTs: string): string {
  const src = rulesTs.replace(/\r\n?/g, '\n');
  const start = src.indexOf(READ_MARKER);
  if (start < 0) throw new Error(`rules.ts has no "${READ_MARKER}" line`);
  const from = src.indexOf('\n', start) + 1;
  return src.slice(from, src.indexOf('};', from));
}

/** RULES_PORTED_FROM as written in rules.ts: id -> fingerprint ('' when not recorded). */
export function portedFromInRules(rulesTs: string): Record<string, string> {
  const src = rulesTs.replace(/\r\n?/g, '\n');
  const start = src.indexOf('export const RULES_PORTED_FROM');
  if (start < 0) throw new Error('rules.ts has no RULES_PORTED_FROM');
  const body = src.slice(start, src.indexOf('};', start));
  return Object.fromEntries([...body.matchAll(/'([^'#]+#[^']+)':\s*'([^']*)'/g)].map((m) => [m[1], m[2]]));
}

/** rules.ts with the READ table and every RULES_PORTED_FROM fingerprint recomputed from `orcaRoot`. */
export function refreshRules(rulesTs: string, orcaRoot: string): { text: string; readChanged: boolean; changedHashes: string[] } {
  const src = rulesTs.replace(/\r\n?/g, '\n');
  const defs = parseOrcaDefinitions(fs.readFileSync(`${orcaRoot}/src/libslic3r/PrintConfig.cpp`, 'utf8'));
  const table = readTableSource(readTableEntries(rulesReadKeys(src), defs));
  const current = readTableInRules(src);
  const from = src.indexOf('\n', src.indexOf(READ_MARKER)) + 1;
  let text = src.slice(0, from) + table + src.slice(from + current.length);
  const recorded = portedFromInRules(text);
  const hashes = ruleSourceHashes(orcaRoot, Object.keys(recorded));
  const changedHashes = Object.keys(recorded).filter((id) => recorded[id] !== hashes[id]);
  for (const id of changedHashes) text = text.replace(new RegExp(`('${escapeRe(id)}':\\s*)'[^']*'`), `$1'${hashes[id]}'`);
  return { text, readChanged: table !== current, changedHashes };
}

function main(write: boolean): void {
  const { text, readChanged, changedHashes } = refreshRules(fs.readFileSync(RULES_TS, 'utf8'), ORCA_ENGINE_ROOT);
  console.log(readChanged ? 'READ table: out of date' : 'READ table: up to date');
  console.log(changedHashes.length ? `Changed Orca functions (re-port them before --write):\n  ${changedHashes.join('\n  ')}` : 'RULES_PORTED_FROM: up to date');
  if (write && (readChanged || changedHashes.length)) {
    fs.writeFileSync(RULES_TS, text);
    console.log(`Wrote ${RULES_TS}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === fs.realpathSync(process.argv[1]).toLowerCase()) {
  main(process.argv.includes('--write'));
}
