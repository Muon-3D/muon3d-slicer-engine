// Reads OrcaSlicer's settings tab layout (pages -> groups -> lines -> options, in order) out of the
// build functions of src/slic3r/GUI/Tab.cpp. Every statement is matched against the closed set of
// shapes below; a statement that touches the layout (a page, group, line or option call, an Option
// or Line variable) in any other shape fails the run with file:line, so an Orca change the
// generator does not understand can never be read as a smaller or different layout. Statements
// that do not touch the layout (config set-up, callbacks, page bookkeeping) are skipped.
//
// Shapes (spacing as squash() writes it):
//   page:      [auto|PageShp] page=add_options_page(L("Quality"),"icon"[,true])      (or page_name)
//   group:     [auto|ConfigOptionsGroupShp] g=page->new_optgroup(L("Seam")[,L"icon"][,15][,true])
//   line:      g->append_single_option_line("key"[,"wiki#anchor"][,0|extruder_idx])
//              [Option|auto] o=g->get_option("key"[,idx]);  o.opt.label|tooltip|full_width|is_code|
//              multiline|height=…;  g->append_single_option_line(o[,"wiki"])
//   lines of several options:
//              [Line] l=[Line]{L("label"),L("tooltip")|""|g->get_option("k").opt.tooltip};
//              l.label_path="…";  l.append_option(g->get_option("k"[,idx])|o);  g->append_line(l)
//   widget:    create_line_with_widget(g.get(),"key","wiki",<lambda>)
//   filament overrides:
//              for(const std::string opt_key:{"filament_…",…}) append_retraction_option(g,opt_key,idx)
//              for(…) append_ironing_option(opt_key,idx)        (the helper lambdas defined before)
//   machine limits (normal + silent column):
//              append_option_line(g,"key","wiki");  const std::vector<std::string> v{…};
//              for(const std::string&a:v){append_option_line(g,["prefix"+]a,"wiki");}
//   extruder retraction/z-hop: for(const PublishablePrinterOption&opt:publishable_printer_…_options())
//              g->append_single_option_line(opt.key,opt.icon,extruder_idx)   (lists from PublishSettings.cpp)
//   the extruder page loop, add_filament_overrides_page(), the synthetic "extruders_count" option
//   (ConfigOptionDef def; def.…=…; Option o(def,"extruders_count")), and the Motion ability page
//   insertion with its G-code flavour condition (build_unregular_pages).
// Known conditions: `wxGetApp().getAgent() != nullptr` (desktop network agents: the options of
// its branch are reported as excluded, an else branch is walked), `m_use_silent_mode` (the
// Normal/Silent legend row), `from_initial_build`.
// Any other statement, loop or condition is skipped only when it cannot touch the layout: it uses
// a page or options group only through a callback or display member (m_on_change, label_width,
// …), names no option key outside config reads (m_config->option("key")), and has no layout call
// inside a callback either. Such code after a `return` (even a conditional one) fails too: whether
// it runs is not known.
import {
  CppParseError,
  IDENT,
  STRINGS,
  TEXT,
  functionBody,
  lineOf,
  literalValue,
  literalsIn,
  parseStatements,
  replaceLambdas,
  squash,
  type CppFile,
  type Stmt,
} from './cpp.ts';

export interface ParsedOption {
  key: string;
  /** The vector slot the row edits: a number, or 'extruder' (the page's extruder, Extruder pages). */
  index?: number | 'extruder';
  /** Set on the Option in Tab.cpp for this row only. */
  label?: string;
  tooltip?: string;
  fullWidth?: boolean;
  code?: boolean;
  multiline?: boolean;
  height?: number;
}

export interface ParsedLine {
  /**
   * single: append_single_option_line; multi: a Line of several options; widget: a custom
   * control; override: a filament "Setting Overrides" row; machineLimit: a normal/silent pair.
   */
  kind: 'single' | 'multi' | 'widget' | 'override' | 'machineLimit';
  label?: string;
  tooltip?: string;
  /** The line's tooltip is this option's tooltip. */
  tooltipOf?: string;
  options: ParsedOption[];
  /** Override rows: the preset whose `key without "filament_"` an unset (nil) value falls back to. */
  overrideOf?: 'machine' | 'process';
  line: number;
}

export interface ParsedGroup {
  title: string;
  lines: ParsedLine[];
  line: number;
}

export interface FlavourCondition {
  /** An enum option, e.g. gcode_flavor. */
  key: string;
  /** Its values (Orca keys) that make the condition true. */
  oneOf: string[];
}

export interface ParsedPage {
  title: string;
  groups: ParsedGroup[];
  line: number;
  /** Built once per extruder (the "Extruder" page). */
  repeat?: 'extruder';
}

/** The "extruders_count" field Tab.cpp builds from its own ConfigOptionDef. */
export interface SyntheticOption {
  key: string;
  type: string;
  label: string;
  tooltip: string;
  mode: string;
  min?: number;
  max?: number;
  line: number;
}

export interface ParsedFunction {
  pages: ParsedPage[];
  synthetic: SyntheticOption[];
  /** Options placed only under a condition the web slicer never meets, with the reason. */
  excluded: Array<{ key: string; reason: string; line: number }>;
  /** build_unregular_pages: the Motion ability page exists only when this holds. */
  kinematicsWhen?: FlavourCondition;
  /** build_fff: it calls build_unregular_pages(true) at the end. */
  buildsUnregularPages?: boolean;
}

export interface ParserInput {
  /** Tab.cpp, prepared (prepareCpp). */
  tab: CppFile;
  /** PublishSettings.cpp lists by function name: publishable_printer_retraction_options -> keys. */
  publishable: Readonly<Record<string, readonly string[]>>;
  /** Orca enum key maps (s_keys_map_<Enum>: C++ constant without namespace -> key). */
  enumKeys: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Numeric constants outside Tab.cpp the code uses (MAXIMUM_EXTRUDER_NUMBER). */
  constants: Readonly<Record<string, number>>;
  /**
   * Whether a text is an Orca option key. A statement the parser does not recognise that names
   * one (outside config reads) fails the run: it may place the option in a new way.
   */
  isOptionKey?: (key: string) => boolean;
}

/** Words that mean a statement builds layout; such a statement must match a known shape. */
const LAYOUT_WORDS =
  /\b(?:add_options_page|new_optgroup|append_single_option_line|append_option_line|append_option|append_line|append_separator|get_option|create_line_with_widget|create_single_option_line|append_retraction_option|append_ironing_option|add_filament_overrides_page|build_kinematics_page|build_unregular_pages|publishable_printer_\w+|Option|Line)\b/;
/** Layout calls; one inside a callback of a statement the parser does not recognise fails the run. */
const LAYOUT_CALL =
  /\b(?:add_options_page|new_optgroup|append_single_option_line|append_option_line|append_option|append_line|append_separator|create_line_with_widget|create_single_option_line|append_retraction_option|append_ironing_option|add_filament_overrides_page|build_kinematics_page|build_unregular_pages)\(/;
/** Members of a page or options group that set callbacks or how it looks, not what it holds. */
const NON_LAYOUT_MEMBERS: ReadonlySet<string> = new Set(['m_on_change', 'edit_custom_gcode', 'have_sys_config', 'hide_labels', 'label_width']);
/** A `return` statement in squashed code (callbacks replaced, literals blanked). */
const RETURN = /(?<![\w.>:])return\b/;
/** Config reads and writes (squashed): they name option keys without placing them. */
const CONFIG_ACCESS = new RegExp(`(?:->|\\.)(?:option|has|opt_\\w+|set_key_value)(?:<[^()]*>)?\\(${STRINGS}`, 'g');

const MODES: Record<string, string> = { comSimple: 'simple', comAdvanced: 'advanced', comExpert: 'expert', comDevelop: 'develop' };

const re = (source: string) => new RegExp(`^${source}$`);
const P = {
  page: re(`(?:(?:auto|PageShp) )?(${IDENT})=add_options_page\\((${TEXT}|${IDENT})(?:,${TEXT})?(?:,(?:true|false))?\\)`),
  group: re(`(?:(?:auto|ConfigOptionsGroupShp) )?(${IDENT})=(${IDENT})->new_optgroup\\((${TEXT})(?:,${TEXT})?(?:,-?\\d+)?(?:,(?:true|false))?\\)`),
  single: re(`(${IDENT})->append_single_option_line\\((${STRINGS})(?:,${STRINGS})?(?:,(${IDENT}|\\d+))?\\)`),
  singleVar: re(`(${IDENT})->append_single_option_line\\((${IDENT})(?:,${STRINGS})?\\)`),
  optionVar: re(`(?:(?:Option|auto) )?(${IDENT})=(${IDENT})->get_option\\((${STRINGS})(?:,(${IDENT}|\\d+))?\\)`),
  optionProp: re(`(${IDENT})\\.opt\\.(${IDENT})=(.+)`),
  lineDecl: re(
    `(?:Line )?(${IDENT})=(?:Line)?\\{(${TEXT}),(${TEXT}|(${IDENT})->get_option\\((${STRINGS})\\)\\.opt\\.tooltip)\\}`,
  ),
  lineLabelPath: re(`(${IDENT})\\.label_path=${STRINGS}`),
  lineAppendGet: re(`(${IDENT})\\.append_option\\((${IDENT})->get_option\\((${STRINGS})(?:,(${IDENT}|\\d+))?\\)\\)`),
  lineAppendVar: re(`(${IDENT})\\.append_option\\((${IDENT})\\)`),
  commit: re(`(${IDENT})->append_line\\((${IDENT})\\)`),
  separator: re(`(${IDENT})->append_separator\\(\\)`),
  widget: re(`create_line_with_widget\\((${IDENT})\\.get\\(\\),(${STRINGS}),${STRINGS},LAMBDA\\)`),
  helper: re(`auto (append_retraction_option|append_ironing_option)=\\[([^\\]]*)\\]\\(.*`),
  overridesPage: re('add_filament_overrides_page\\(\\)'),
  vector: re(`(?:const )?std::vector<std::string>(${IDENT})=?\\{(${STRINGS}(?:,${STRINGS})*)\\}`),
  limitLine: re(`append_option_line\\((${IDENT}),(${STRINGS}),${STRINGS}\\)`),
  constInt: re(`const int (${IDENT})=(-?\\d+)`),
  pageName: re(`const wxString&(${IDENT})=\\(m_extruders_count>1\\)\\?wxString::Format\\(${STRINGS},.+\\):wxString::Format\\((${STRINGS})\\)`),
  enumVar: re(`auto (${IDENT})=m_config->option<ConfigOptionEnum<(${IDENT})>>\\((${STRINGS})\\)->value`),
  boolOf: re(`bool (${IDENT})=\\((.+)\\)`),
  defDecl: re('ConfigOptionDef def'),
  defField: re(`def\\.(${IDENT})=(.+)`),
  synthetic: re(`Option (${IDENT})\\(def,(${STRINGS})\\)`),
  unregular: re('build_unregular_pages\\(true\\)'),
  kinematics: re('auto page=build_kinematics_page\\(\\)'),
  pageInsert: re(`m_pages\\.insert\\(m_pages\\.(?:begin|end)\\(\\)[-+\\w]*,(${IDENT})\\)`),
  returnPage: re(`return (${IDENT})`),
};
const LOOPS = {
  extruders: re('auto extruder_idx=m_extruders_count_old;extruder_idx<m_extruders_count;\\+\\+extruder_idx'),
  overrides: re(`const std::string opt_key:\\{(${STRINGS}(?:,${STRINGS})*)\\}`),
  axes: re(`const std::string&(${IDENT}):(${IDENT})`),
  publishable: re('const PublishablePrinterOption&opt:(publishable_printer_\\w+)\\(\\)'),
  plateLines: re(`auto&line:const_cast<std::vector<Line>&>\\((${IDENT})->get_lines\\(\\)\\)`),
};
const BODIES = {
  retraction: re(`append_retraction_option\\((${IDENT}),opt_key,(${IDENT}|\\d+)\\)`),
  ironing: re(`append_ironing_option\\(opt_key,(${IDENT}|\\d+)\\)`),
  axis: re(`append_option_line\\((${IDENT}),(?:(${STRINGS})\\+)?(${IDENT}),${STRINGS}\\)`),
  publishable: re(`(${IDENT})->append_single_option_line\\(opt\\.key,opt\\.icon,(${IDENT}|\\d+)\\)`),
  plateLines: re('line\\.undo_to_sys=true'),
};
const CONDITIONS = {
  agent: 'wxGetApp().getAgent()!=nullptr',
  silentLegend: 'm_use_silent_mode',
  initialBuild: 'from_initial_build',
  kinematics: 'existed_page<n_before_extruders&&(is_marlin_flavor||from_initial_build)',
  kinematicsSkip: 'from_initial_build&&!is_marlin_flavor',
};

/** Walks the statements of one build function. */
class Walker {
  readonly out: ParsedFunction = { pages: [], synthetic: [], excluded: [] };
  private readonly pages = new Map<string, ParsedPage>();
  private readonly groups = new Map<string, ParsedGroup>();
  private readonly options = new Map<string, ParsedOption>();
  private readonly lines = new Map<string, ParsedLine>();
  private readonly constants = new Map<string, number>();
  private readonly vectors = new Map<string, string[]>();
  private readonly pageNames = new Map<string, string>();
  private readonly enumVars = new Map<string, { key: string; enumName: string }>();
  private readonly conditions = new Map<string, FlavourCondition>();
  private readonly helpers = new Map<string, { group?: string }>();
  private def: Partial<SyntheticOption> | null = null;
  /** Inside the extruder page loop: extruder_idx means "this page's extruder". */
  private extruderLoop = false;
  /** Where the function being walked has its first `return` (outside callbacks), once seen. */
  private returned: number | undefined;
  private readonly input: ParserInput;

  constructor(input: ParserInput) {
    this.input = input;
    for (const [name, value] of Object.entries(input.constants)) this.constants.set(name, value);
  }

  private fail(at: number, message: string): never {
    throw new CppParseError(this.input.tab.path, lineOf(this.input.tab.text, at), message);
  }

  private line(at: number): number {
    return lineOf(this.input.tab.text, at);
  }

  walkFunction(name: string): void {
    const body = functionBody(this.input.tab, name);
    const outer = this.returned;
    this.returned = undefined;
    this.walk(parseStatements(this.input.tab, body.start, body.end));
    this.returned = outer;
  }

  private walk(stmts: readonly Stmt[]): void {
    for (const stmt of stmts) {
      if (this.returned !== undefined) {
        const why = this.layoutUse(stmt.text);
        if (why) this.fail(stmt.at, `${why} after the return on line ${this.line(this.returned)}: ${squash(stmt.text).slice(0, 200)}`);
      }
      if (stmt.kind === 'simple') this.simple(stmt.at, stmt.text);
      else if (stmt.kind === 'block') this.walk(stmt.body);
      else if (stmt.kind === 'loop') this.loop(stmt);
      else this.condition(stmt);
      if (this.returned === undefined && RETURN.test(squash(replaceLambdas(stmt.text)).replace(new RegExp(STRINGS, 'g'), '""'))) {
        this.returned = stmt.at;
      }
    }
  }

  private isLayout(text: string): boolean {
    const s = squash(replaceLambdas(text));
    if (LAYOUT_WORDS.test(s)) return true;
    const member = /^(\w+)\./.exec(s);
    return !!member && (member[1] === 'def' || this.lines.has(member[1]) || this.options.has(member[1]));
  }

  private group(at: number, name: string): ParsedGroup {
    return this.groups.get(name) ?? this.fail(at, `"${name}" is not an options group here`);
  }

  private index(at: number, token: string | undefined): number | 'extruder' | undefined {
    if (token === undefined) return undefined;
    if (/^\d+$/.test(token)) return Number(token);
    if (token === 'extruder_idx' && this.extruderLoop) return 'extruder';
    const value = this.constants.get(token);
    return value ?? this.fail(at, `unknown option index "${token}"`);
  }

  private text(at: number, source: string): string {
    if (!new RegExp(`^${TEXT}$`).test(source)) this.fail(at, `expected a text literal, found ${source}`);
    return literalValue(source);
  }

  private number(at: number, source: string): number {
    if (/^-?\d+(\.\d+)?$/.test(source)) return Number(source);
    return this.constants.get(source) ?? this.fail(at, `unknown number "${source}"`);
  }

  private bool(at: number, source: string): boolean {
    if (source === 'true' || source === 'false') return source === 'true';
    return this.fail(at, `expected true or false, found ${source}`);
  }

  private push(at: number, groupName: string, line: Omit<ParsedLine, 'line'>): void {
    this.group(at, groupName).lines.push({ ...line, line: this.line(at) });
  }

  private simple(at: number, raw: string): void {
    const original = squash(raw);
    // Helper lambdas are recognised before lambdas are replaced (their capture list names a group).
    let m = P.helper.exec(original);
    if (m) {
      const group = m[2].split(',').find((c) => this.groups.has(c));
      this.helpers.set(m[1], { group });
      return;
    }
    const s = squash(replaceLambdas(raw));
    if ((m = P.page.exec(s))) {
      const title = new RegExp(`^${IDENT}$`).test(m[2])
        ? (this.pageNames.get(m[2]) ?? this.fail(at, `unknown page name "${m[2]}"`))
        : this.text(at, m[2]);
      const page: ParsedPage = { title, groups: [], line: this.line(at), ...(this.extruderLoop ? { repeat: 'extruder' as const } : {}) };
      this.out.pages.push(page);
      this.pages.set(m[1], page);
    } else if ((m = P.group.exec(s))) {
      const page = this.pages.get(m[2]) ?? this.fail(at, `"${m[2]}" is not a page here`);
      const group: ParsedGroup = { title: this.text(at, m[3]), lines: [], line: this.line(at) };
      page.groups.push(group);
      this.groups.set(m[1], group);
    } else if ((m = P.single.exec(s))) {
      const index = this.index(at, m[3]);
      this.push(at, m[1], { kind: 'single', options: [{ key: literalValue(m[2]), ...(index !== undefined ? { index } : {}) }] });
    } else if ((m = P.singleVar.exec(s))) {
      const option = this.options.get(m[2]) ?? this.fail(at, `"${m[2]}" is not an option here`);
      this.push(at, m[1], { kind: 'single', options: [{ ...option }] });
    } else if ((m = P.optionVar.exec(s))) {
      this.group(at, m[2]);
      const index = this.index(at, m[4]);
      this.options.set(m[1], { key: literalValue(m[3]), ...(index !== undefined ? { index } : {}) });
    } else if ((m = P.optionProp.exec(s))) {
      const option = this.options.get(m[1]) ?? this.fail(at, `"${m[1]}" is not an option here`);
      const [prop, value] = [m[2], m[3]];
      if (prop === 'label') option.label = this.text(at, value);
      else if (prop === 'tooltip') option.tooltip = this.text(at, value);
      else if (prop === 'full_width') option.fullWidth = this.bool(at, value);
      else if (prop === 'is_code') option.code = this.bool(at, value);
      else if (prop === 'multiline') option.multiline = this.bool(at, value);
      else if (prop === 'height') option.height = this.number(at, value);
      else this.fail(at, `unknown option property "${prop}"`);
    } else if ((m = P.lineDecl.exec(s))) {
      const line: ParsedLine = { kind: 'multi', label: this.text(at, m[2]), options: [], line: this.line(at) };
      if (m[4]) {
        this.group(at, m[4]);
        line.tooltipOf = literalValue(m[5]);
      } else {
        const tooltip = this.text(at, m[3]);
        if (tooltip) line.tooltip = tooltip;
      }
      this.lines.set(m[1], line);
    } else if ((m = P.lineLabelPath.exec(s)) && this.lines.has(m[1])) {
      // Orca's wiki link for the row.
    } else if ((m = P.lineAppendGet.exec(s))) {
      const line = this.lines.get(m[1]) ?? this.fail(at, `"${m[1]}" is not a line here`);
      this.group(at, m[2]);
      const index = this.index(at, m[4]);
      line.options.push({ key: literalValue(m[3]), ...(index !== undefined ? { index } : {}) });
    } else if ((m = P.lineAppendVar.exec(s)) && this.lines.has(m[1])) {
      const option = this.options.get(m[2]) ?? this.fail(at, `"${m[2]}" is not an option here`);
      this.lines.get(m[1])!.options.push({ ...option });
    } else if ((m = P.commit.exec(s))) {
      const line = this.lines.get(m[2]) ?? this.fail(at, `"${m[2]}" is not a line here`);
      if (!line.options.length) this.fail(at, `line "${m[2]}" has no options`);
      this.group(at, m[1]).lines.push({ ...line, options: line.options.map((o) => ({ ...o })) });
    } else if ((m = P.separator.exec(s))) {
      this.group(at, m[1]);
    } else if ((m = P.widget.exec(s))) {
      this.push(at, m[1], { kind: 'widget', options: [{ key: literalValue(m[2]) }] });
    } else if (P.overridesPage.test(s)) {
      this.inline('TabFilament::add_filament_overrides_page');
    } else if ((m = P.vector.exec(s))) {
      this.vectors.set(m[1], [...m[2].matchAll(new RegExp(STRINGS, 'g'))].map((v) => literalValue(v[0])));
    } else if ((m = P.limitLine.exec(s))) {
      this.push(at, m[1], { kind: 'machineLimit', options: [{ key: literalValue(m[2]), index: 0 }] });
    } else if ((m = P.constInt.exec(s))) {
      this.constants.set(m[1], Number(m[2]));
    } else if ((m = P.pageName.exec(s))) {
      this.pageNames.set(m[1], literalValue(m[2]));
    } else if ((m = P.enumVar.exec(s))) {
      this.enumVars.set(m[1], { key: literalValue(m[3]), enumName: m[2] });
    } else if ((m = P.boolOf.exec(s)) && this.flavourCondition(m[1], m[2])) {
      // Recorded by flavourCondition.
    } else if (P.defDecl.test(s)) {
      this.def = { line: this.line(at) };
    } else if ((m = P.defField.exec(s))) {
      this.defField(at, m[1], m[2]);
    } else if ((m = P.synthetic.exec(s))) {
      const def = this.def ?? this.fail(at, 'Option(def, …) without a ConfigOptionDef');
      const key = literalValue(m[2]);
      if (!def.type || def.label === undefined || !def.mode) this.fail(at, `the definition of "${key}" lacks a type, label or mode`);
      this.out.synthetic.push({ key, type: def.type, label: def.label, tooltip: def.tooltip ?? '', mode: def.mode, min: def.min, max: def.max, line: def.line! });
      this.options.set(m[1], { key });
    } else if (P.unregular.test(s)) {
      this.out.buildsUnregularPages = true;
    } else if ((m = P.pageInsert.exec(s)) && this.pages.has(m[1])) {
      // Where Orca inserts a printer page at run time; the generator orders those pages itself.
    } else if ((m = P.returnPage.exec(s)) && this.pages.has(m[1])) {
      // build_kinematics_page hands its page to build_unregular_pages.
    } else {
      const why = this.layoutUse(raw);
      if (why) this.fail(at, `unrecognised ${why}: ${s.slice(0, 200)}`);
    }
  }

  /**
   * Why code the parser does not recognise may build layout (the start of an error message), or
   * undefined when it cannot: see the top of this file.
   */
  private layoutUse(raw: string): string | undefined {
    if (this.isLayout(raw)) return 'layout statement';
    if (LAYOUT_CALL.test(squash(raw))) return 'layout code in a callback';
    const s = squash(replaceLambdas(raw));
    const code = s.replace(new RegExp(STRINGS, 'g'), '""');
    for (const name of new Set([...this.groups.keys(), ...this.pages.keys()])) {
      for (const m of code.matchAll(new RegExp(`(?<![\\w.>])${name}\\b(?:->(\\w+))?`, 'g'))) {
        if (!m[1] || !NON_LAYOUT_MEMBERS.has(m[1])) return `statement using "${name}"`;
      }
    }
    const isKey = this.input.isOptionKey;
    const key = isKey && literalsIn(s.replace(CONFIG_ACCESS, '')).find((text) => isKey(text));
    return key ? `statement naming the option "${key}"` : undefined;
  }

  private defField(at: number, field: string, value: string): void {
    const def = this.def ?? this.fail(at, 'def.… without a ConfigOptionDef');
    if (field === 'type') {
      // def.type = coInt, def.set_default_value(...): the default is the live extruder count.
      const type = /^co(\w+?)(?:,def\.set_default_value\(.+\))?$/.exec(value) ?? this.fail(at, `unknown def.type ${value}`);
      def.type = type[1][0].toLowerCase() + type[1].slice(1);
    } else if (field === 'label') def.label = this.text(at, value);
    else if (field === 'tooltip') def.tooltip = this.text(at, value);
    else if (field === 'min') def.min = this.number(at, value);
    else if (field === 'max') def.max = this.number(at, value);
    else if (field === 'mode') def.mode = MODES[value] ?? this.fail(at, `unknown mode ${value}`);
    else this.fail(at, `unknown ConfigOptionDef field "${field}"`);
  }

  /** `bool x = (flavor == gcfA || flavor == gcfB …)` over an enum variable: recorded as a condition. */
  private flavourCondition(name: string, expr: string): boolean {
    const terms = expr.split('||').map((t) => /^(\w+)==(\w+)$/.exec(t));
    if (!terms.length || terms.some((t) => !t || !this.enumVars.has(t[1]))) return false;
    const { key, enumName } = this.enumVars.get(terms[0]![1])!;
    if (terms.some((t) => this.enumVars.get(t![1])!.key !== key)) return false;
    const table = this.input.enumKeys.get(enumName);
    const oneOf = terms.map((t) => table?.get(t![2]));
    if (oneOf.some((v) => v === undefined)) return false;
    this.conditions.set(name, { key, oneOf: oneOf as string[] });
    return true;
  }

  /** Walks another function at this point with its own variables (add_filament_overrides_page). */
  private inline(name: string): void {
    const saved = { pages: new Map(this.pages), groups: new Map(this.groups), options: new Map(this.options), lines: new Map(this.lines) };
    this.walkFunction(name);
    for (const [key, map] of Object.entries(saved)) {
      const live = this[key as keyof typeof saved] as Map<string, unknown>;
      live.clear();
      for (const [k, v] of map) live.set(k, v);
    }
  }

  private loop(stmt: Extract<Stmt, { kind: 'loop' }>): void {
    const head = squash(stmt.head);
    const only = (): string => {
      if (stmt.body.length !== 1 || stmt.body[0].kind !== 'simple') this.fail(stmt.at, `unexpected loop body: ${squash(stmt.text).slice(0, 200)}`);
      return squash(stmt.body[0].text);
    };
    let m: RegExpExecArray | null;
    if (LOOPS.extruders.test(head)) {
      this.extruderLoop = true;
      this.walk(stmt.body);
      this.extruderLoop = false;
    } else if ((m = LOOPS.overrides.exec(head))) {
      const keys = [...m[1].matchAll(new RegExp(STRINGS, 'g'))].map((v) => literalValue(v[0]));
      const body = only();
      let b: RegExpExecArray | null;
      let group: string;
      let overrideOf: 'machine' | 'process';
      let indexToken: string;
      if ((b = BODIES.retraction.exec(body))) {
        if (!this.helpers.has('append_retraction_option')) this.fail(stmt.at, 'append_retraction_option is not defined here');
        [group, indexToken, overrideOf] = [b[1], b[2], 'machine'];
      } else if ((b = BODIES.ironing.exec(body))) {
        group = this.helpers.get('append_ironing_option')?.group ?? this.fail(stmt.at, 'append_ironing_option is not defined here (or captures no group)');
        [indexToken, overrideOf] = [b[1], 'process'];
      } else {
        return this.fail(stmt.at, `unrecognised override loop body: ${body}`);
      }
      const index = this.index(stmt.at, indexToken);
      for (const key of keys) this.push(stmt.at, group, { kind: 'override', overrideOf, options: [{ key, ...(index !== undefined ? { index } : {}) }] });
    } else if ((m = LOOPS.axes.exec(head))) {
      const items = this.vectors.get(m[2]) ?? this.fail(stmt.at, `unknown list "${m[2]}"`);
      const b = BODIES.axis.exec(only());
      if (!b || b[3] !== m[1]) this.fail(stmt.at, `unrecognised machine limit loop: ${squash(stmt.text).slice(0, 200)}`);
      const prefix = b[2] ? literalValue(b[2]) : '';
      for (const item of items) this.push(stmt.at, b[1], { kind: 'machineLimit', options: [{ key: prefix + item, index: 0 }] });
    } else if ((m = LOOPS.publishable.exec(head))) {
      const keys = this.input.publishable[m[1]] ?? this.fail(stmt.at, `unknown list ${m[1]}() (PublishSettings.cpp)`);
      const b = BODIES.publishable.exec(only()) ?? this.fail(stmt.at, `unrecognised ${m[1]} loop body`);
      const index = this.index(stmt.at, b[2]);
      for (const key of keys) this.push(stmt.at, b[1], { kind: 'single', options: [{ key, ...(index !== undefined ? { index } : {}) }] });
    } else if ((m = LOOPS.plateLines.exec(head)) && BODIES.plateLines.test(only())) {
      // TabPrintPlate: every row reverts to the global value.
    } else {
      const why = this.layoutUse(stmt.text);
      const keyword = /^\w+/.exec(stmt.text)![0];
      if (why) this.fail(stmt.at, `unrecognised ${keyword === 'switch' ? 'switch' : 'loop'} around layout code (${why}): ${keyword} (${head})`);
    }
  }

  private condition(stmt: Extract<Stmt, { kind: 'if' }>): void {
    const cond = squash(stmt.cond);
    if (cond === CONDITIONS.agent) {
      // Network printer agents exist only in the desktop app: the web slicer takes the else branch.
      this.walk(stmt.otherwise);
      const s = squash(replaceLambdas(stmt.then.map((t) => t.text).join(';')));
      for (const m of s.matchAll(new RegExp(`(?:get_option|append_single_option_line)\\((${STRINGS})`, 'g'))) {
        this.out.excluded.push({ key: literalValue(m[1]), reason: 'Only OrcaSlicer desktop shows it (network printer agents).', line: this.line(stmt.at) });
      }
    } else if (cond === CONDITIONS.silentLegend) {
      // The "Normal / Silent" column legend of the machine limits: labels, not options.
    } else if (cond === CONDITIONS.initialBuild) {
      if (stmt.otherwise.some((s) => this.layoutUse(s.text))) this.fail(stmt.at, 'unexpected else branch');
      this.walk(stmt.then);
    } else if (cond === CONDITIONS.kinematics) {
      const [first, second] = stmt.then;
      const ok =
        stmt.then.length === 2 && first.kind === 'simple' && P.kinematics.test(squash(first.text)) &&
        second.kind === 'if' && squash(second.cond) === CONDITIONS.kinematicsSkip &&
        second.then.length === 1 && squash(second.then[0].text) === 'page->clear()' && !this.isLayout(second.text.replace(/page->clear\(\)/, ''));
      if (!ok) this.fail(stmt.at, 'unrecognised Motion ability page insertion');
      this.out.kinematicsWhen = this.conditions.get('is_marlin_flavor') ?? this.fail(stmt.at, 'is_marlin_flavor is not a known G-code flavour condition');
    } else {
      const why = this.layoutUse(stmt.text);
      if (why) this.fail(stmt.at, `unrecognised condition around layout code (${why}): if (${cond})`);
    }
  }
}

/** The layout one build function creates (e.g. "TabPrint::build"). */
export function parseBuildFunction(input: ParserInput, name: string): ParsedFunction {
  const walker = new Walker(input);
  walker.walkFunction(name);
  return walker.out;
}

/**
 * The option lists of PublishSettings.cpp's `publishable_printer_*_options()` functions: each
 * `{ "key", "wiki" }` entry's key, in order.
 */
export function parsePublishableLists(file: CppFile): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of file.text.matchAll(/std::vector<PublishablePrinterOption>\s*&\s*(publishable_printer_\w+)\s*\(\s*\)\s*\{/g)) {
    const body = functionBody(file, m[1]);
    const list = /options\s*=\s*\{([\s\S]*)\}\s*;/.exec(file.text.slice(body.start, body.end));
    if (!list) throw new CppParseError(file.path, lineOf(file.text, body.start), `${m[1]}: no option list`);
    out[m[1]] = [...list[1].matchAll(/\{\s*"([^"]+)"\s*,\s*"[^"]*"\s*\}/g)].map((e) => e[1]);
    if (!out[m[1]].length) throw new CppParseError(file.path, lineOf(file.text, body.start), `${m[1]}: empty option list`);
  }
  return out;
}
