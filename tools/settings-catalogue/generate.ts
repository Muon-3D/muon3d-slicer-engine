// Generates the OrcaSlicer settings catalogue: every option the engine's Orca defines, laid out in
// the pages, groups and rows of Orca's settings tabs, with the web slicer's policy on top.
//
//   npm run gen:settings              writes shared/orcaSettings/catalogue.json and optionTypes.ts
//   npm run gen:settings -- --check   fails when those files differ from a fresh run (drift check)
//
// Sources, each read the most robust way:
//   - option definitions (type, labels, tooltip, unit, limits, enum values, default, mode, …) and the
//     key sets libslic3r defines (preset scopes, per-extruder, variant and per-object keys): the
//     built engine's configDefinitions() export (engine/bridge/config_def.cpp), loaded in Node;
//   - the layout: a strict parse of the build functions of src/slic3r/GUI/Tab.cpp (tabParser.ts);
//   - which options and enum values the server's older Orca CLI lacks: its PrintConfig.cpp/.hpp at
//     its build commit (serverDiff.ts);
//   - fingerprints of the Orca functions read, and of those the settings rules port (rules.ts), so
//     a test fails when Orca changes one.
// The output is deterministic (sorted keys, fixed layout) and committed.
//
// Environment:
//   ORCA_WASM_ROOT      the engine workspace (default ~/OrcaWasm)
//   ORCA_SRC            the engine's Orca checkout (default $ORCA_WASM_ROOT/orca)
//   ENGINE_DIR          the built engine (default web/public/engine; the st variant is used)
//   ORCA_SERVER_SRC     the server CLI's Orca checkout (default ../OrcaSlicer/OrcaSlicer)
//   ORCA_SERVER_COMMIT  the commit the server CLI was built from (default 7c5b1764ba)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  LayoutLine,
  LayoutOption,
  LayoutPage,
  LayoutTab,
  OrcaOptionType,
  SettingDef,
  SettingMode,
  SettingScope,
  SettingsCatalogue,
  SlotKind,
} from '../../shared/orcaSettings/types.ts';
import { RULES_PORTED_FROM } from '../../web/src/settings/rules.ts';
import { cppFunctionHash, parseEnumKeyMaps, ruleSourceHashes } from '../../web/src/settings/rulesSource.ts';
import { lineOf, literalsIn, prepareCpp, replaceLambdas, functionBody, type CppFile } from './cpp.ts';
import { HIDDEN_REASONS, noteFor, policyKeys, readOnlyReason, widgetFor } from './policy.ts';
import { readServerOrca, type ServerOrca } from './serverDiff.ts';
import {
  parseBuildFunction,
  parsePublishableLists,
  type ParsedFunction,
  type ParsedLine,
  type ParsedOption,
  type ParsedPage,
  type ParserInput,
  type SyntheticOption,
} from './tabParser.ts';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CATALOGUE_PATH = path.join(repoRoot, 'shared/orcaSettings/catalogue.json');
export const OPTION_TYPES_PATH = path.join(repoRoot, 'shared/orcaSettings/optionTypes.ts');

export const TAB_CPP = 'src/slic3r/GUI/Tab.cpp';
export const PUBLISH_CPP = 'src/libslic3r/PublishSettings.cpp';

/** The Tab.cpp functions the layout is read from (their fingerprints go into `sources`). */
export const LAYOUT_FUNCTIONS = {
  process: 'TabPrint::build',
  filament: 'TabFilament::build',
  filamentOverrides: 'TabFilament::add_filament_overrides_page',
  printer: 'TabPrinter::build_fff',
  printerUnregular: 'TabPrinter::build_unregular_pages',
  printerKinematics: 'TabPrinter::build_kinematics_page',
  printerLimitLine: 'TabPrinter::append_option_line',
  plate: 'TabPrintPlate::build',
} as const;

/**
 * Orca inserts the printer pages at run time (build_unregular_pages); this is the order it ends
 * up with for the Marlin-like flavours that have the Motion ability page.
 */
const PRINTER_PAGE_ORDER = ['Basic information', 'Machine G-code', 'Multimaterial', 'Extruder', 'Motion ability', 'Notes'];

const TABS: ReadonlyArray<{ id: SettingScope; title: string }> = [
  { id: 'process', title: 'Process' },
  { id: 'filament', title: 'Filament' },
  { id: 'machine', title: 'Printer' },
];

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/** One option of the engine's configDefinitions() (web/src/engine/configDefinitions.ts has the full shape). */
export interface EngineOption {
  type: OrcaOptionType | 'none';
  nullable?: true;
  label: string;
  fullLabel: string;
  tooltip: string;
  sidetext: string;
  category: string;
  mode: SettingMode;
  min?: number;
  max?: number;
  maxLiteral: number;
  ratioOver: string;
  enumValues: string[];
  enumLabels: string[];
  enumKeys?: Record<string, number>;
  guiType: string;
  guiFlags: string;
  multiline: boolean;
  fullWidth: boolean;
  isCode: boolean;
  readonly: boolean;
  height?: number;
  aliases: string[];
  default?: string | string[];
}

export interface EngineDefinitions {
  format: number;
  orcaVersion: string;
  orcaCommit: string;
  options: Record<string, EngineOption>;
  presetKeys: { process: string[]; filament: string[]; machine: string[]; machineLimits: string[] };
  extruderKeys: string[];
  variantKeys: { print: string[]; filament: string[]; printer1: string[]; printer2: string[] };
  objectKeys: string[];
  regionKeys: string[];
}

export interface GeneratorPaths {
  orcaRoot: string;
  engineDir: string;
  serverRepo: string;
  serverCommit: string;
}

export function defaultPaths(env: NodeJS.ProcessEnv = process.env): GeneratorPaths {
  const wasmRoot = env.ORCA_WASM_ROOT ?? (path.join(os.homedir(), 'OrcaWasm'));
  return {
    orcaRoot: path.resolve(env.ORCA_SRC ?? path.join(wasmRoot, 'orca')),
    engineDir: path.resolve(env.ENGINE_DIR ?? path.join(repoRoot, 'web/public/engine')),
    serverRepo: path.resolve(env.ORCA_SERVER_SRC ?? path.join(repoRoot, '../OrcaSlicer/OrcaSlicer')),
    serverCommit: env.ORCA_SERVER_COMMIT ?? '7c5b1764ba',
  };
}

/** Whether everything the generator reads is on this machine. */
export function sourcesAvailable(paths: GeneratorPaths): boolean {
  return (
    existsSync(path.join(paths.engineDir, 'engine-st.mjs')) &&
    existsSync(path.join(paths.orcaRoot, TAB_CPP)) &&
    existsSync(path.join(paths.serverRepo, '.git'))
  );
}

/** The engine's option definitions (its configDefinitions() export). */
export async function readEngineDefinitions(engineDir: string): Promise<EngineDefinitions> {
  // Imported by URL so the type checker does not pull the browser worker into Node-only code.
  const worker = pathToFileURL(path.join(repoRoot, 'web/src/engine/worker.ts')).href;
  const { loadEngine } = (await import(worker)) as {
    loadEngine(dir: string, variant: 'st'): Promise<{ engine: { configDefinitions?: () => string } }>;
  };
  const { engine } = await loadEngine(pathToFileURL(engineDir + path.sep).href, 'st');
  if (typeof engine.configDefinitions !== 'function') {
    throw new Error(`The engine in ${engineDir} has no configDefinitions(): rebuild it (engine/scripts/build.sh).`);
  }
  const defs = JSON.parse(engine.configDefinitions()) as EngineDefinitions & { error?: string };
  if (defs.error) throw new Error(`configDefinitions(): ${defs.error}`);
  if (defs.format !== 1) throw new Error(`configDefinitions() format ${defs.format}; this generator reads format 1.`);
  return defs;
}

/** Everything read from the Orca sources. */
export interface OrcaSources {
  /** The Orca checkout. */
  root: string;
  tab: CppFile;
  /** Raw texts by path relative to the Orca root, for fingerprints. */
  raw: Record<string, string>;
  parser: ParserInput;
  commit: string;
  /** is_filament_extruder_override_key (PrintConfig.cpp): the filament options that override the printer's. */
  filamentOverrideKeys: ReadonlySet<string>;
}

/**
 * The keys of is_filament_extruder_override_key (src/libslic3r/PrintConfig.cpp): the
 * filament_extruder_override_keys list plus filament_retract_length_nc, which it names itself.
 */
export function parseFilamentOverrideKeys(printConfigCpp: string): Set<string> {
  const list = /filament_extruder_override_keys\s*=\s*\{([^}]*)\}/.exec(printConfigCpp);
  const fn = /bool is_filament_extruder_override_key\([^)]*\)\s*\{([^}]*)\}/.exec(printConfigCpp);
  if (!list || !fn) throw new Error('src/libslic3r/PrintConfig.cpp: filament_extruder_override_keys or is_filament_extruder_override_key not found');
  const strip = (text: string) => text.replace(/\/\/[^\n]*/g, '');
  const keys = new Set([...strip(list[1]).matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]));
  for (const m of strip(fn[1]).matchAll(/opt_key\s*==\s*"([a-z0-9_]+)"/g)) keys.add(m[1]);
  if (keys.size < 10) throw new Error(`src/libslic3r/PrintConfig.cpp: only ${keys.size} filament override keys found`);
  return keys;
}

export function readOrcaSources(orcaRoot: string): OrcaSources {
  const read = (file: string) => readFileSync(path.join(orcaRoot, file), 'utf8');
  const raw = { [TAB_CPP]: read(TAB_CPP), [PUBLISH_CPP]: read(PUBLISH_CPP) };
  const tab = prepareCpp(TAB_CPP, raw[TAB_CPP]);
  const maxExtruders = /MAXIMUM_EXTRUDER_NUMBER\s*=\s*(\d+)/.exec(read('src/libslic3r/libslic3r.h'));
  if (!maxExtruders) throw new Error('src/libslic3r/libslic3r.h: MAXIMUM_EXTRUDER_NUMBER not found');
  const printConfig = read('src/libslic3r/PrintConfig.cpp');
  const parser: ParserInput = {
    tab,
    publishable: parsePublishableLists(prepareCpp(PUBLISH_CPP, raw[PUBLISH_CPP])),
    enumKeys: parseEnumKeyMaps(printConfig),
    constants: { MAXIMUM_EXTRUDER_NUMBER: Number(maxExtruders[1]) },
  };
  const commit = execFileSync('git', ['-C', orcaRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { root: orcaRoot, tab, raw, parser, commit, filamentOverrideKeys: parseFilamentOverrideKeys(printConfig) };
}

// ---------------------------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------------------------

export interface CatalogueParts {
  defs: EngineDefinitions;
  orca: OrcaSources;
  server: ServerOrca;
  /** RULES_PORTED_FROM's keys (web/src/settings/rules.ts). */
  ruleFunctions: readonly string[];
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untitled';

function layoutOption(o: ParsedOption): LayoutOption {
  const out: LayoutOption = { key: o.key };
  if (o.index !== undefined) out.index = o.index;
  if (o.label !== undefined) out.label = o.label;
  if (o.tooltip !== undefined) out.tooltip = o.tooltip;
  if (o.fullWidth) out.fullWidth = true;
  if (o.code) out.code = true;
  if (o.multiline) out.multiline = true;
  if (o.height !== undefined) out.height = o.height;
  return out;
}

function layoutLine(line: ParsedLine, defs: EngineDefinitions): LayoutLine {
  const out: LayoutLine = { options: line.options.map(layoutOption) };
  if (line.label !== undefined) out.label = line.label;
  const tooltip = line.tooltipOf !== undefined ? defs.options[line.tooltipOf]?.tooltip : line.tooltip;
  if (tooltip) out.tooltip = tooltip;
  if (line.kind === 'widget') out.widget = widgetFor(line.options[0].key);
  if (line.kind === 'override') out.overrideOf = { scope: line.overrideOf!, key: line.options[0].key.replace(/^filament_/, '') };
  if (line.kind === 'machineLimit') out.modeColumns = true;
  return out;
}

function layoutPages(pages: readonly ParsedPage[], defs: EngineDefinitions): LayoutPage[] {
  const groupIds = new Set<string>();
  return pages.map((page) => {
    const id = slug(page.title);
    const out: LayoutPage = {
      id,
      title: page.title,
      groups: page.groups.map((group) => {
        let groupId = `${id}.${slug(group.title)}`;
        for (let n = 2; groupIds.has(groupId); n++) groupId = `${id}.${slug(group.title)}-${n}`;
        groupIds.add(groupId);
        return { id: groupId, title: group.title, lines: group.lines.map((l) => layoutLine(l, defs)) };
      }),
    };
    if (page.repeat) out.repeat = page.repeat;
    return out;
  });
}

const VECTOR_TYPES: ReadonlySet<string> = new Set(['floats', 'ints', 'strings', 'percents', 'floatsOrPercents', 'points', 'bools', 'enums', 'pointsGroups', 'intsGroups']);

/**
 * Vector options libslic3r's key sets (extruder_option_keys, the variant sets, the machine limits)
 * do not classify and that are not filament options, polygons or "serialized" text lists. A new
 * vector option that none of the rules cover fails the run: whether one value fills every slot
 * (per nozzle / variant) or the entries are the value (a list) decides how overrides convert.
 */
const SLOTS_BY_KEY: Readonly<Record<string, SlotKind>> = {
  // The entries are the value.
  compatible_machine_expression_group: 'list',
  compatible_printers: 'list',
  compatible_process_expression_group: 'list',
  compatible_prints: 'list',
  different_settings_to_system: 'list',
  first_layer_print_sequence: 'list',
  flush_volumes_matrix: 'list',
  flush_volumes_vector: 'list',
  inherits_group: 'list',
  other_layers_print_sequence: 'list',
  parallel_printheads_bed_exclude_areas: 'list',
  plugins: 'list',
  preset_names: 'list',
  print_compatible_printers: 'list',
  slicing_pipeline_plugin: 'list',
  upward_compatible_machine: 'list',
  wipe_tower_x: 'list',
  wipe_tower_y: 'list',
  wiping_volumes_extruders: 'list',
  // One per nozzle.
  deretract_speed_extruder_change: 'extruder',
  extruder_ams_count: 'extruder',
  extruder_bed_exclude_volumes: 'extruder',
  extruder_max_nozzle_count: 'extruder',
  extruder_nozzle_count: 'extruder',
  extruder_nozzle_stats: 'extruder',
  extruder_nozzle_volume_type: 'extruder',
  extruder_printable_area: 'extruder',
  extruder_variant_list: 'extruder',
  flush_multiplier: 'extruder',
  flush_multiplier_fast: 'extruder',
  grab_length: 'extruder',
  nozzle_volume_type: 'extruder',
  physical_extruder_map: 'extruder',
  // One per extruder variant, like the other speeds.
  small_support_perimeter_speed: 'variant',
  small_support_perimeter_threshold: 'variant',
};

function vectorSlots(key: string, o: EngineOption, defs: EngineDefinitions, scopes: SettingScope[]): SlotKind | undefined {
  if (!VECTOR_TYPES.has(o.type)) return undefined;
  // The variant sets first: a printer option such as retraction_length is also one of
  // extruder_option_keys, but presets store it per extruder variant (printer_extruder_variant),
  // which is how Orca's tabs index it (get_index_for_extruder).
  const variants = defs.variantKeys;
  if (variants.print.includes(key) || variants.filament.includes(key) || variants.printer1.includes(key) || variants.printer2.includes(key)) return 'variant';
  if (defs.extruderKeys.includes(key)) return 'extruder';
  if (defs.presetKeys.machineLimits.includes(key)) return 'machineLimits';
  if (SLOTS_BY_KEY[key]) return SLOTS_BY_KEY[key];
  if (o.type === 'points' || o.guiFlags === 'serialized') return 'list';
  if (scopes.includes('filament') || key.startsWith('filament_')) return 'filament';
  throw new Error(`${key}: a ${o.type} option no rule classifies; add it to SLOTS_BY_KEY in generate.ts`);
}

function settingDef(key: string, o: EngineOption, defs: EngineDefinitions, server: ServerOrca, filamentOverrideKeys: ReadonlySet<string>): SettingDef {
  if (o.type === 'none') throw new Error(`${key}: option without a type`);
  const scopes = TABS.map((t) => t.id).filter((s) =>
    s === 'machine' ? defs.presetKeys.machine.includes(key) || defs.presetKeys.machineLimits.includes(key) : defs.presetKeys[s].includes(key),
  );
  const out: SettingDef = { type: o.type, label: o.label || o.fullLabel || key, mode: o.mode };
  if (scopes.length) out.scopes = scopes;
  if (o.fullLabel && o.fullLabel !== out.label) out.fullLabel = o.fullLabel;
  if (o.tooltip) out.tooltip = o.tooltip;
  if (o.sidetext) out.unit = o.sidetext;
  if (o.category) out.category = o.category;
  if (o.default !== undefined) out.default = o.default;
  // Orca's default filament preset, which every filament preset is loaded on top of, has each
  // nullable filament override unset (PresetBundle::PresetBundle: "Set all the nullable values to
  // nils"), so a filament preset that does not name one uses the printer's value.
  if (o.nullable && filamentOverrideKeys.has(key)) out.default = ['nil'];
  if (o.min !== undefined) out.min = o.min;
  if (o.max !== undefined) out.max = o.max;
  if (o.type === 'floatOrPercent' || o.type === 'floatsOrPercents') {
    if (o.maxLiteral !== 1) out.maxLiteral = o.maxLiteral;
    if (o.ratioOver) out.ratioOver = o.ratioOver;
  }
  // A value Orca lists but its keys map cannot read (filament_map_mode "Default") is left out:
  // neither the engine nor the CLI accepts it.
  const listed = o.enumValues.flatMap((value, i) => (!o.enumKeys || Object.hasOwn(o.enumKeys, value) ? [i] : []));
  if (listed.length) {
    out.enumValues = listed.map((i) => o.enumValues[i]);
    const labels = o.enumLabels.length === o.enumValues.length ? listed.map((i) => o.enumLabels[i]) : [];
    if (labels.some((l, i) => l !== out.enumValues![i])) out.enumLabels = labels;
  }
  if (o.guiType === 'i_enum_open' || o.guiType === 'f_enum_open' || o.guiType === 'select_open') out.openEnum = true;
  else if (['color', 'one_string', 'slider', 'legend', 'plugin_picker', 'plugin_config'].includes(o.guiType)) out.gui = o.guiType as SettingDef['gui'];
  if (o.guiFlags === 'serialized') out.serialized = true;
  if (o.multiline) out.multiline = true;
  if (o.isCode) out.code = true;
  if (o.fullWidth) out.fullWidth = true;
  if (o.height !== undefined && o.height >= 0) out.height = o.height;
  if (o.readonly) out.orcaReadOnly = true;
  if (o.nullable) out.nullable = true;
  const slots = vectorSlots(key, o, defs, scopes);
  if (slots) out.slots = slots;
  if (defs.objectKeys.includes(key)) out.perObject = 'object';
  else if (defs.regionKeys.includes(key)) out.perObject = 'region';
  if (o.aliases.length) out.aliases = o.aliases;
  if (!server.keys.has(key)) out.engineOnly = true;
  const known = server.enumValues.get(key);
  if (known && out.enumValues) {
    const missing = out.enumValues.filter((v) => !known.has(v));
    if (missing.length) out.engineOnlyValues = missing;
  }
  const reason = readOnlyReason(key);
  if (reason) out.readOnly = reason;
  const note = noteFor(key, reason);
  if (note) out.note = note;
  return out;
}

function syntheticDef(s: SyntheticOption): SettingDef {
  const out: SettingDef = { type: s.type as OrcaOptionType, label: s.label, mode: s.mode as SettingMode, synthetic: true };
  if (s.tooltip) out.tooltip = s.tooltip;
  if (s.min !== undefined) out.min = s.min;
  if (s.max !== undefined) out.max = s.max;
  const reason = readOnlyReason(s.key);
  if (reason) out.readOnly = reason;
  const note = noteFor(s.key, reason);
  if (note) out.note = note;
  return out;
}

/** Every option key a tab (or the plate dialog) places, in order. */
export function* placedKeys(pages: readonly LayoutPage[]): Generator<string> {
  for (const page of pages) for (const group of page.groups) for (const line of group.lines) for (const o of line.options) yield o.key;
}

/**
 * The option keys written as literals in a build function outside config reads (m_config->option,
 * has, opt_*, set_key_value) and callbacks: an independent check that the statement walker placed
 * every key the function mentions.
 */
export function literalKeysIn(file: CppFile, fn: string, isKey: (key: string) => boolean): Map<string, number> {
  const body = functionBody(file, fn);
  const text = replaceLambdas(file.text.slice(body.start, body.end)).replace(
    /(?:->|\.)\s*(?:option|has|opt_\w+|set_key_value)\s*(?:<[^()]*>)?\s*\(\s*"[^"]*"/g,
    '',
  );
  const out = new Map<string, number>();
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const [key] = literalsIn(m[0]);
    if (isKey(key) && !out.has(key)) out.set(key, lineOf(file.text, body.start + (m.index ?? 0)));
  }
  return out;
}

export function buildCatalogue({ defs, orca, server, ruleFunctions }: CatalogueParts): SettingsCatalogue {
  const problems: string[] = [];
  if (defs.orcaCommit !== orca.commit) {
    throw new Error(`The engine was built from Orca ${defs.orcaCommit}, but ${TAB_CPP} is at ${orca.commit}: rebuild the engine or check out its commit.`);
  }
  const parserInput: ParserInput = { ...orca.parser, isOptionKey: (key) => Object.hasOwn(defs.options, key) };
  const parse = (fn: string): ParsedFunction => parseBuildFunction(parserInput, fn);
  const processTab = parse(LAYOUT_FUNCTIONS.process);
  const filamentTab = parse(LAYOUT_FUNCTIONS.filament);
  const fff = parse(LAYOUT_FUNCTIONS.printer);
  const unregular = parse(LAYOUT_FUNCTIONS.printerUnregular);
  const kinematics = parse(LAYOUT_FUNCTIONS.printerKinematics);
  const plate = parse(LAYOUT_FUNCTIONS.plate);
  if (!fff.buildsUnregularPages) problems.push(`${LAYOUT_FUNCTIONS.printer} no longer calls build_unregular_pages(true)`);
  if (!unregular.kinematicsWhen) problems.push(`${LAYOUT_FUNCTIONS.printerUnregular}: no Motion ability page condition`);

  // Printer pages in Orca's run-time order.
  const printerParsed = [...fff.pages, ...unregular.pages, ...kinematics.pages];
  const printerPages = PRINTER_PAGE_ORDER.map((title) => {
    const found = printerParsed.filter((p) => p.title === title);
    if (found.length !== 1) problems.push(`printer page "${title}" found ${found.length} times`);
    return found[0];
  }).filter(Boolean);
  for (const p of printerParsed) if (!PRINTER_PAGE_ORDER.includes(p.title)) problems.push(`new printer page "${p.title}" (${TAB_CPP}:${p.line}): add it to PRINTER_PAGE_ORDER`);

  const all = [processTab, filamentTab, fff, unregular, kinematics, plate];
  const synthetic = all.flatMap((f) => f.synthetic);
  const excluded = all.flatMap((f) => f.excluded);

  const tabs: LayoutTab[] = TABS.map(({ id, title }) => {
    const parsed = id === 'process' ? processTab.pages : id === 'filament' ? filamentTab.pages : printerPages;
    const pages = layoutPages(parsed, defs);
    const motion = pages.find((p) => p.title === 'Motion ability');
    if (id === 'machine' && motion && unregular.kinematicsWhen) motion.when = unregular.kinematicsWhen;
    return { id, title, pages };
  });

  // Options: every engine option, plus the synthetic ones.
  const options: Record<string, SettingDef> = {};
  for (const key of Object.keys(defs.options).sort()) {
    try {
      options[key] = settingDef(key, defs.options[key], defs, server, orca.filamentOverrideKeys);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  for (const s of synthetic) {
    if (options[s.key]) problems.push(`synthetic option "${s.key}" (${TAB_CPP}:${s.line}) is also an Orca option`);
    options[s.key] = syntheticDef(s);
  }
  // A drop-down must be able to show the default (open enums take other values too).
  for (const [key, def] of Object.entries(options)) {
    if ((def.type !== 'enum' && def.type !== 'enums') || def.openEnum || !def.enumValues) continue;
    for (const value of [def.default ?? []].flat()) {
      if (!def.enumValues.includes(value) && !(value === 'nil' && def.nullable)) problems.push(`${key}: the default "${value}" is not one of its values`);
    }
  }

  // Placement checks: defined, in the tab's own scope, once across the tabs.
  const seen = new Map<string, string>();
  for (const tab of tabs) {
    for (const key of placedKeys(tab.pages)) {
      const def = options[key];
      if (!def) problems.push(`${tab.id} tab places "${key}", which has no definition`);
      else if (!def.synthetic && !def.scopes?.includes(tab.id)) problems.push(`${tab.id} tab places "${key}", stored in ${def.scopes?.join('/') ?? 'no preset'}`);
      if (seen.has(key)) problems.push(`"${key}" is placed twice (${seen.get(key)} and ${tab.id})`);
      seen.set(key, tab.id);
    }
    for (const page of tab.pages) {
      for (const group of page.groups) {
        for (const line of group.lines) {
          const target = line.overrideOf;
          if (target && !options[target.key]?.scopes?.includes(target.scope)) problems.push(`override row "${line.options[0].key}": "${target.key}" is not a ${target.scope} option`);
        }
      }
    }
  }
  const plateLines = plate.pages.flatMap((p) => p.groups.flatMap((g) => g.lines.map((l) => layoutLine(l, defs))));
  for (const line of plateLines) for (const o of line.options) if (!options[o.key]) problems.push(`plate places "${o.key}", which has no definition`);

  // Coverage: every option key a build function names is placed or excluded.
  const isKey = (key: string) => Object.hasOwn(defs.options, key) || synthetic.some((s) => s.key === key);
  const placedOrExcluded = new Set([...seen.keys(), ...plateLines.flatMap((l) => l.options.map((o) => o.key)), ...excluded.map((e) => e.key)]);
  for (const fn of Object.values(LAYOUT_FUNCTIONS)) {
    for (const [key, line] of literalKeysIn(orca.tab, fn, isKey)) {
      if (!placedOrExcluded.has(key)) problems.push(`${TAB_CPP}:${line}: ${fn} names "${key}", which the parse did not place`);
    }
  }

  for (const key of policyKeys()) if (!options[key]) problems.push(`policy.ts names "${key}", which is not an Orca option`);

  // "Other": each scope's options no tab places, except the hidden and the excluded ones.
  const excludedKeys = new Set(excluded.map((e) => e.key));
  for (const tab of tabs) {
    const hidden = (key: string) => options[key].readOnly !== undefined && HIDDEN_REASONS.has(options[key].readOnly);
    const keys = Object.keys(options)
      .filter((key) => options[key].scopes?.includes(tab.id) && !seen.has(key) && !hidden(key) && !excludedKeys.has(key))
      .sort();
    if (keys.length) {
      tab.pages.push({
        id: 'other',
        title: 'Other',
        other: true,
        groups: [{ id: 'other.not-in-orca-tabs', title: 'Other settings', lines: keys.map((key) => ({ options: [{ key }] })) }],
      });
    }
  }

  if (problems.length) throw new Error(`The settings catalogue has problems:\n  ${problems.join('\n  ')}`);

  const sources: Record<string, string> = {};
  for (const fn of Object.values(LAYOUT_FUNCTIONS)) sources[`${TAB_CPP}#${fn}`] = cppFunctionHash(orca.raw[TAB_CPP], fn);
  for (const fn of Object.keys(orca.parser.publishable).sort()) sources[`${PUBLISH_CPP}#${fn}`] = cppFunctionHash(orca.raw[PUBLISH_CPP], fn);

  return {
    format: 1,
    orca: { version: defs.orcaVersion, commit: defs.orcaCommit },
    server: { commit: server.commit },
    sources,
    ruleSources: sortedRecord(ruleSourceHashes(orca.root, ruleFunctions)),
    options,
    tabs,
    plate: plateLines,
    excluded: sortedRecord(Object.fromEntries(excluded.map((e) => [e.key, e.reason]))),
  };
}

const sortedRecord = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

/**
 * The catalogue as JSON text: containers indented, each option definition and each layout row on
 * one line, so a review diff shows one line per changed option or row.
 */
export function catalogueJson(catalogue: SettingsCatalogue): string {
  const write = (value: unknown, indent: string, leaf: (v: unknown) => boolean): string => {
    if (value === null || typeof value !== 'object' || leaf(value)) return JSON.stringify(value);
    const inner = `${indent}  `;
    if (Array.isArray(value)) {
      if (!value.length) return '[]';
      return `[\n${value.map((v) => inner + write(v, inner, leaf)).join(',\n')}\n${indent}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return '{}';
    return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${write(v, inner, leaf)}`).join(',\n')}\n${indent}}`;
  };
  const isLine = (v: unknown) => typeof v === 'object' && v !== null && Array.isArray((v as LayoutLine).options);
  const { options, ...rest } = catalogue;
  const body = write({ ...rest, options: {} }, '', isLine);
  const optionLines = Object.entries(options).map(([key, def]) => `    ${JSON.stringify(key)}: ${JSON.stringify(def)}`).join(',\n');
  return `${body.replace('"options": {}', `"options": {\n${optionLines}\n  }`)}\n`;
}

/** shared/orcaSettings/optionTypes.ts: the option types shared/overrides.ts converts values with. */
export function optionTypesSource(catalogue: SettingsCatalogue): string {
  const real = Object.entries(catalogue.options).filter(([, def]) => !def.synthetic);
  const name = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key));
  const list = (keys: string[]) => keys.map((k) => `  '${k}',`).join('\n');
  return `// Generated by \`npm run gen:settings\` (scripts/orca-settings/generate.ts) from the engine's option
// definitions (Orca ${catalogue.orca.commit.slice(0, 10)}): do not edit. The option types of catalogue.json, kept apart so
// shared/overrides.ts can convert override values without loading the whole catalogue.
import type { OrcaOptionType } from './types.ts';

/** Orca's type of every option, by key. Look keys up with Object.hasOwn. */
export const OPTION_TYPES: Readonly<Record<string, OrcaOptionType>> = {
${real.map(([key, def]) => `  ${name(key)}: '${def.type}',`).join('\n')}
};

/** Vector options whose slots may be "nil" (unset). */
export const NULLABLE_OPTIONS: ReadonlySet<string> = new Set([
${list(real.filter(([, d]) => d.nullable).map(([k]) => k))}
]);

/** Strings options Orca edits as one ";"-separated text (gui_flags "serialized"). */
export const SERIALIZED_OPTIONS: ReadonlySet<string> = new Set([
${list(real.filter(([, d]) => d.serialized).map(([k]) => k))}
]);

/** Vector options whose entries are the value itself (a polygon, a list of names), not one value per slot. */
export const LIST_OPTIONS: ReadonlySet<string> = new Set([
${list(real.filter(([, d]) => d.slots === 'list').map(([k]) => k))}
]);
`;
}

/** Reads every source and builds the catalogue and the files it is written to. */
export async function generate(paths: GeneratorPaths = defaultPaths()): Promise<{ catalogue: SettingsCatalogue; files: Record<string, string> }> {
  const defs = await readEngineDefinitions(paths.engineDir);
  const orca = readOrcaSources(paths.orcaRoot);
  const server = readServerOrca(paths.serverRepo, paths.serverCommit);
  const catalogue = buildCatalogue({ defs, orca, server, ruleFunctions: Object.keys(RULES_PORTED_FROM) });
  return { catalogue, files: { [CATALOGUE_PATH]: catalogueJson(catalogue), [OPTION_TYPES_PATH]: optionTypesSource(catalogue) } };
}

async function main(args: string[]): Promise<number> {
  const check = args.includes('--check');
  const { catalogue, files } = await generate();
  let stale = 0;
  for (const [file, text] of Object.entries(files)) {
    const rel = path.relative(repoRoot, file).replace(/\\/g, '/');
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (current === text) {
      console.log(`${rel}: up to date`);
    } else if (check) {
      console.error(`${rel}: out of date (run npm run gen:settings)`);
      stale++;
    } else {
      writeFileSync(file, text);
      console.log(`${rel}: written (${text.length.toLocaleString('en')} characters)`);
    }
  }
  const placed = catalogue.tabs.map((t) => `${t.id} ${[...placedKeys(t.pages.filter((p) => !p.other))].length}`).join(', ');
  const engineOnly = Object.values(catalogue.options).filter((d) => d.engineOnly).length;
  console.log(`${Object.keys(catalogue.options).length} options; placed: ${placed}; ${engineOnly} engine-only; Orca ${catalogue.orca.commit.slice(0, 10)}, server ${catalogue.server.commit.slice(0, 10)}`);
  return stale ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
