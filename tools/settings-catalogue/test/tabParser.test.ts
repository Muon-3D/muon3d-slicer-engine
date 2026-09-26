// The settings generator's Tab.cpp parser (scripts/orca-settings/tabParser.ts, cpp.ts) on small
// C++ fixtures, one per statement shape it knows, and the shapes it must refuse. It lives here so
// `npm test` and the type check cover the generator.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CppParseError,
  functionBody,
  literalValue,
  parseStatements,
  prepareCpp,
  replaceLambdas,
  squash,
} from '../../scripts/orca-settings/cpp.ts';
import { parseBuildFunction, parsePublishableLists, type ParsedFunction } from '../../scripts/orca-settings/tabParser.ts';

const FLAVOURS = new Map([
  ['GCodeFlavor', new Map([['gcfMarlinFirmware', 'marlin2'], ['gcfKlipper', 'klipper'], ['gcfRepRapFirmware', 'reprapfirmware']])],
]);

/** The option keys the fixtures treat as Orca's. */
const OPTION_KEYS = new Set(['layer_height', 'wall_loops', 'curr_bed_type', 'machine_start_gcode', 'gcode_flavor', 'nozzle_diameter']);

/** Parses `body` as the body of TabTest::build (other functions may come before it in `extra`). */
function parse(body: string, extra = ''): ParsedFunction {
  const tab = prepareCpp('Tab.cpp', `${extra}\nvoid TabTest::build()\n{\n${body}\n}\n`);
  return parseBuildFunction(
    {
      tab,
      publishable: { publishable_printer_z_hop_options: ['z_hop_types', 'z_hop'] },
      enumKeys: FLAVOURS,
      constants: { MAXIMUM_EXTRUDER_NUMBER: 64 },
      isOptionKey: (key) => OPTION_KEYS.has(key),
    },
    'TabTest::build',
  );
}

/** The error message a body fails with. */
function failure(body: string, extra = ''): string {
  try {
    parse(body, extra);
  } catch (err) {
    assert.ok(err instanceof CppParseError, String(err));
    return err.message;
  }
  return assert.fail('expected the parse to fail');
}

const keysOf = (f: ParsedFunction) => f.pages.flatMap((p) => p.groups.flatMap((g) => g.lines.flatMap((l) => l.options.map((o) => o.key))));

describe('C++ source helpers', () => {
  it('blanks comments and #if 0 code but keeps every line in place', () => {
    const file = prepareCpp('x.cpp', 'a(); // "b"\r\n/* c\n d */ e();\n#if 0\nf();\n#else\ng();\n#endif\n#if 1\nh();\n#else\ni();\n#endif\n');
    assert.deepEqual(file.text.split('\n'), ['a(); ', '', ' e();', '', '', '', 'g();', '', '', 'h();', '', '', '', '']);
  });

  it('squashes spacing outside literals only', () => {
    assert.equal(squash('auto  page = add_options_page( L("A  b"),\n "icon" );'), 'auto page=add_options_page(L("A  b"),"icon");');
    assert.equal(squash('const std::string &axis : axes'), 'const std::string&axis:axes');
  });

  it('replaces lambdas, not subscripts', () => {
    assert.equal(squash(replaceLambdas('g->m_on_change = [this, &t = g->title](int k) { g->append_line(x); };')), 'g->m_on_change=LAMBDA;');
    assert.equal(replaceLambdas('auto f = [this] { return 1; };'), 'auto f = LAMBDA;');
    assert.equal(replaceLambdas('m_pages[i]->title(); v[0](1);'), 'm_pages[i]->title(); v[0](1);');
  });

  it('resolves adjacent and escaped literals', () => {
    assert.equal(literalValue('L("a" "b\\n\\"c\\"")'), 'ab\n"c"');
  });

  it('splits statements, if/else and loops', () => {
    const file = prepareCpp('x.cpp', 'void F::f() { a(); if (x) { b(); } else c(); for (;;) d(); { e(); } }');
    const body = functionBody(file, 'F::f');
    const stmts = parseStatements(file, body.start, body.end);
    assert.deepEqual(stmts.map((s) => s.kind), ['simple', 'if', 'loop', 'block']);
    const branch = stmts[1];
    assert.ok(branch.kind === 'if' && branch.then.length === 1 && branch.otherwise.length === 1);
  });

  it('finds exactly one definition', () => {
    const file = prepareCpp('x.cpp', 'void A::f() { A::f(); }\nvoid A::g() {}\nvoid A::g() {}\n');
    assert.match(functionBody(file, 'A::f').definition, /^A::f\(\) \{ A::f\(\); \}$/);
    assert.throws(() => functionBody(file, 'A::g'), /A::g is defined 2 times/);
    assert.throws(() => functionBody(file, 'A::h'), /A::h is not defined/);
  });

  it('reads the publishable option lists', () => {
    const file = prepareCpp(
      'PublishSettings.cpp',
      'const std::vector<PublishablePrinterOption>& publishable_printer_z_hop_options()\r\n{\r\n    static const std::vector<PublishablePrinterOption> options = {\r\n        { "z_hop", "wiki#a" },\r\n        { "travel_slope", "wiki#b" },\r\n    };\r\n    return options;\r\n}\r\n',
    );
    assert.deepEqual(parsePublishableLists(file), { publishable_printer_z_hop_options: ['z_hop', 'travel_slope'] });
  });
});

describe('Tab.cpp layout shapes', () => {
  it('reads pages, groups and single-option rows; skips comments, #if 0 code and non-layout code', () => {
    const f = parse(`
      if (m_presets == nullptr) m_presets = &m_preset_bundle->prints;
      load_initial_data();
      auto page = add_options_page(L("Quality"), "icon"); // icon
          auto optgroup = page->new_optgroup(L("Layer height"), L"param_layer_height");
          optgroup->append_single_option_line("layer_height", "quality#layer-height");
          // optgroup->append_single_option_line("commented_out");
      #if 0
          optgroup->append_single_option_line("disabled");
      #endif
          optgroup->hide_labels();
      page = add_options_page(L("Speed"), "icon");
          optgroup = page->new_optgroup(L("First layer speed"), L"param_speed_first", 15);
          optgroup->append_single_option_line("initial_layer_speed", "speed#initial", 0);
    `);
    assert.deepEqual(
      f.pages.map((p) => [p.title, p.groups.map((g) => [g.title, g.lines.map((l) => [l.kind, l.options])])]),
      [
        ['Quality', [['Layer height', [['single', [{ key: 'layer_height' }]]]]]],
        ['Speed', [['First layer speed', [['single', [{ key: 'initial_layer_speed', index: 0 }]]]]]],
      ],
    );
    assert.equal(f.pages[0].groups[0].lines[0].line, 9, 'source line numbers are Orca\'s');
  });

  it('reads option variables and the properties set on them', () => {
    const f = parse(`
      const int gcode_field_height = 15;
      auto page = add_options_page(L("Others"), "icon");
      auto optgroup = page->new_optgroup(L("G-code"), L"param_gcode", 0);
      optgroup->m_on_change = [this, optgroup](const t_config_option_key& opt_key, const boost::any& value) {
          if (opt_key == "machine_start_gcode") update_dirty();
      };
      Option option = optgroup->get_option("machine_start_gcode");
      option.opt.full_width = true;
      option.opt.is_code = true;
      option.opt.height = gcode_field_height;
      optgroup->append_single_option_line(option, "wiki");
      option = optgroup->get_option("filename_format");
      option.opt.multiline = true;
      option.opt.tooltip = L("A " "tip");
      optgroup->append_single_option_line(option);
    `);
    assert.deepEqual(f.pages[0].groups[0].lines.map((l) => l.options), [
      [{ key: 'machine_start_gcode', fullWidth: true, code: true, height: 15 }],
      [{ key: 'filename_format', multiline: true, tooltip: 'A tip' }],
    ]);
  });

  it('reads lines of several options, relabelled options and tooltips of other options', () => {
    const f = parse(`
      auto page = add_options_page(L("Filament"), "icon");
      auto optgroup = page->new_optgroup(L("Temperature"), L"param_temp");
      Line line = { L("Chamber temperature"), L("Target and minimal") };
      line.label_path = "wiki#chamber";
      Option target = optgroup->get_option("chamber_temperature");
      target.opt.label = L("Target");
      line.append_option(target);
      line.append_option(optgroup->get_option("chamber_minimal_temperature", 0));
      optgroup->append_line(line);
      optgroup->append_separator();
      line = Line{ L("Fan speed-up time"), optgroup->get_option("fan_speedup_time").opt.tooltip };
      line.append_option(optgroup->get_option("fan_speedup_time"));
      optgroup->append_line(line);
      Line empty_tip = {L("Resonance"), L""};
      empty_tip.append_option(optgroup->get_option("min_resonance_avoidance_speed"));
      optgroup->append_line(empty_tip);
    `);
    const lines = f.pages[0].groups[0].lines;
    assert.deepEqual(lines.map((l) => ({ kind: l.kind, label: l.label, tooltip: l.tooltip, tooltipOf: l.tooltipOf, options: l.options })), [
      {
        kind: 'multi', label: 'Chamber temperature', tooltip: 'Target and minimal', tooltipOf: undefined,
        options: [{ key: 'chamber_temperature', label: 'Target' }, { key: 'chamber_minimal_temperature', index: 0 }],
      },
      { kind: 'multi', label: 'Fan speed-up time', tooltip: undefined, tooltipOf: 'fan_speedup_time', options: [{ key: 'fan_speedup_time' }] },
      { kind: 'multi', label: 'Resonance', tooltip: undefined, tooltipOf: undefined, options: [{ key: 'min_resonance_avoidance_speed' }] },
    ]);
  });

  it('reads custom widget rows without reading the widget code', () => {
    const f = parse(`
      auto page = add_options_page(L("Basic information"), "icon");
      auto optgroup = page->new_optgroup(L("Printable space"), "param_printable_space");
      create_line_with_widget(optgroup.get(), "printable_area", "wiki", [this](wxWindow* parent) {
          Line line = { "", "" };
          optgroup->append_line(line);
          return create_bed_shape_widget(parent);
      });
    `);
    assert.deepEqual(f.pages[0].groups[0].lines.map((l) => [l.kind, l.options]), [['widget', [{ key: 'printable_area' }]]]);
  });

  it('reads the filament override rows, inlining add_filament_overrides_page', () => {
    const overrides = `
      void TabFilament::add_filament_overrides_page()
      {
          PageShp page = add_options_page(L("Setting Overrides"), "icon");
          const int extruder_idx = 0;
          auto append_retraction_option = [this](ConfigOptionsGroupShp optgroup, const std::string& opt_key, int opt_index) {
              Line line {"",""};
              line = optgroup->create_single_option_line(optgroup->get_option(opt_key, opt_index));
              optgroup->append_line(line);
          };
          ConfigOptionsGroupShp retraction_optgroup = page->new_optgroup(L("Retraction"), L"param_retraction");
          for (const std::string opt_key : { "filament_retraction_length",
                                             // "filament_seam_gap"
                                             "filament_z_hop" })
              append_retraction_option(retraction_optgroup, opt_key, extruder_idx);
          ConfigOptionsGroupShp ironing_optgroup = page->new_optgroup(L("Ironing"), L"param_ironing");
          auto append_ironing_option = [this, ironing_optgroup](const std::string& opt_key, int opt_index) {
              ironing_optgroup->append_line(line);
          };
          for (const std::string opt_key : { "filament_ironing_flow" })
              append_ironing_option(opt_key, extruder_idx);
      }`;
    const f = parse(
      `
      auto page = add_options_page(L("Cooling"), "icon");
      auto optgroup = page->new_optgroup(L("Fan"), "param_fan");
      optgroup->append_single_option_line("fan_min_speed");
      add_filament_overrides_page();
      page = add_options_page(L("Advanced"), "icon");
      optgroup = page->new_optgroup(L("G-code"), "param_gcode");
      optgroup->append_single_option_line("filament_start_gcode");
    `,
      overrides,
    );
    assert.deepEqual(f.pages.map((p) => p.title), ['Cooling', 'Setting Overrides', 'Advanced']);
    assert.deepEqual(
      f.pages[1].groups.map((g) => [g.title, g.lines.map((l) => [l.kind, l.overrideOf, l.options])]),
      [
        ['Retraction', [
          ['override', 'machine', [{ key: 'filament_retraction_length', index: 0 }]],
          ['override', 'machine', [{ key: 'filament_z_hop', index: 0 }]],
        ]],
        ['Ironing', [['override', 'process', [{ key: 'filament_ironing_flow', index: 0 }]]]],
      ],
    );
    assert.deepEqual(keysOf(f).at(-1), 'filament_start_gcode', 'the caller\'s page and group come back after the inline page');
  });

  it('reads machine limit rows from loops and single calls', () => {
    const f = parse(`
      auto page = add_options_page(L("Motion ability"), "icon", true);
      if (m_use_silent_mode) {
          auto optgroup = page->new_optgroup("");
          auto line = Line{ "", "" };
          ConfigOptionDef def;
          def.type = coString;
          auto option = Option(def, "full_power_legend");
          line.append_option(option);
          optgroup->append_line(line);
      }
      const std::vector<std::string> speed_axes{ "machine_max_speed_x", "machine_max_speed_y" };
      auto optgroup = page->new_optgroup(L("Speed limitation"), "param_speed");
          for (const std::string &speed_axis : speed_axes) {
              append_option_line(optgroup, speed_axis, "wiki");
          }
      const std::vector<std::string> axes{ "x", "e" };
      optgroup = page->new_optgroup(L("Jerk limitation"), "param_jerk");
          append_option_line(optgroup, "machine_max_junction_deviation", "wiki");
          for (const std::string &axis : axes) {
              append_option_line(optgroup, "machine_max_jerk_" + axis, "wiki");
          }
      return page;
    `);
    assert.deepEqual(f.pages[0].groups.map((g) => g.title), ['Speed limitation', 'Jerk limitation'], 'the silent-mode legend is not a group');
    assert.deepEqual(
      f.pages[0].groups.flatMap((g) => g.lines.map((l) => `${l.kind}:${l.options[0].key}:${l.options[0].index}`)),
      [
        'machineLimit:machine_max_speed_x:0', 'machineLimit:machine_max_speed_y:0', 'machineLimit:machine_max_junction_deviation:0',
        'machineLimit:machine_max_jerk_x:0', 'machineLimit:machine_max_jerk_e:0',
      ],
    );
  });

  it('reads the extruder page loop, the publishable lists and the synthetic extruder count', () => {
    const f = parse(`
      if (from_initial_build) {
          auto page = add_options_page(L("Multimaterial"), "icon", true);
          auto optgroup = page->new_optgroup(L("Setup"), "param_multi_material");
          ConfigOptionDef def;
          def.type    = coInt, def.set_default_value(new ConfigOptionInt((int) m_extruders_count));
          def.label   = L("Extruders");
          def.tooltip = L("Number of extruders of the printer.");
          def.min     = 1;
          def.max     = MAXIMUM_EXTRUDER_NUMBER;
          def.mode    = comAdvanced;
          Option option(def, "extruders_count");
          optgroup->append_single_option_line(option, "wiki");
          m_pages.insert(m_pages.end() - n_after_single_extruder_MM, page);
      }
      for (auto extruder_idx = m_extruders_count_old; extruder_idx < m_extruders_count; ++extruder_idx) {
          const wxString& page_name = (m_extruders_count > 1) ? wxString::Format("Extruder %d", int(extruder_idx + 1)) : wxString::Format("Extruder");
          auto page = add_options_page(page_name, "icon", true);
          auto optgroup = page->new_optgroup(L("Basic information"), L"param_information", -1, true);
          optgroup->append_single_option_line("nozzle_diameter", "wiki", extruder_idx);
          optgroup = page->new_optgroup(L("Z-Hop"), L"param_z_hop");
          for (const PublishablePrinterOption& opt : publishable_printer_z_hop_options())
              optgroup->append_single_option_line(opt.key, opt.icon, extruder_idx);
      }
    `);
    assert.deepEqual(f.pages.map((p) => [p.title, p.repeat]), [['Multimaterial', undefined], ['Extruder', 'extruder']]);
    assert.deepEqual(f.synthetic.map(({ line: _line, ...s }) => s), [
      { key: 'extruders_count', type: 'int', label: 'Extruders', tooltip: 'Number of extruders of the printer.', mode: 'advanced', min: 1, max: 64 },
    ]);
    assert.deepEqual(
      f.pages[1].groups.flatMap((g) => g.lines.map((l) => [l.options[0].key, l.options[0].index])),
      [['nozzle_diameter', 'extruder'], ['z_hop_types', 'extruder'], ['z_hop', 'extruder']],
    );
  });

  it('reads the Motion ability page condition from the G-code flavour test', () => {
    const f = parse(`
      auto flavor = m_config->option<ConfigOptionEnum<GCodeFlavor>>("gcode_flavor")->value;
      bool is_marlin_flavor = (flavor == gcfMarlinFirmware || flavor == gcfKlipper);
      if (existed_page < n_before_extruders && (is_marlin_flavor || from_initial_build)) {
          auto page = build_kinematics_page();
          if (from_initial_build && !is_marlin_flavor)
              page->clear();
          else
              m_pages.insert(m_pages.begin() + n_before_extruders, page);
      }
      if (is_marlin_flavor)
          n_before_extruders++;
    `);
    assert.deepEqual(f.kinematicsWhen, { key: 'gcode_flavor', oneOf: ['marlin2', 'klipper'] });
  });

  it('reports the options of the desktop-only printer agent block as excluded', () => {
    const f = parse(`
      auto page = add_options_page(L("Basic information"), "icon");
      auto optgroup = page->new_optgroup(L("Advanced"), L"param_advanced");
      if (wxGetApp().getAgent() != nullptr)
      {
          option = optgroup->get_option("printer_agent");
          option.opt.gui_type = ConfigOptionDef::GUIType::printer_agent_select;
          optgroup->append_single_option_line(option);
      }
      optgroup->append_single_option_line("use_3mf");
      build_unregular_pages(true);
    `);
    assert.deepEqual(keysOf(f), ['use_3mf']);
    assert.deepEqual(f.excluded.map((e) => e.key), ['printer_agent']);
    assert.equal(f.buildsUnregularPages, true);
  });

  it('places the layout of the printer agent else branch (what shows without an agent)', () => {
    const f = parse(`
      auto page = add_options_page(L("Basic information"), "icon");
      auto optgroup = page->new_optgroup(L("Advanced"), L"param_advanced");
      if (wxGetApp().getAgent() != nullptr) {
          optgroup->append_single_option_line("printer_agent");
      } else {
          optgroup->append_single_option_line("print_host");
      }
    `);
    assert.deepEqual(keysOf(f), ['print_host']);
    assert.deepEqual(f.excluded.map((e) => e.key), ['printer_agent']);
    // A shape the else branch does not know still fails.
    assert.match(
      failure(`
        auto page = add_options_page(L("P"), "icon");
        auto optgroup = page->new_optgroup(L("G"), "icon");
        if (wxGetApp().getAgent() != nullptr) optgroup->append_single_option_line("printer_agent");
        else add_fancy_row(optgroup);`),
      /^Tab\.cpp:8: unrecognised statement using "optgroup": add_fancy_row\(optgroup\)$/,
    );
  });

  it('accepts a return that no layout follows', () => {
    const f = parse(`
      auto page = add_options_page(L("P"), "icon");
      auto optgroup = page->new_optgroup(L("G"), "icon");
      optgroup->append_single_option_line("layer_height");
      if (from_initial_build && m_printer_technology == ptSLA)
          return; // next part of code is no needed to execute at this moment
      rebuild_page_tree();
      reload_config();`);
    assert.deepEqual(keysOf(f), ['layer_height']);
  });

  it('skips the plate dialog bookkeeping', () => {
    const f = parse(`
      m_config->option("curr_bed_type", true);
      if (m_preset_bundle->project_config.has("curr_bed_type")) {
          BedType global_bed_type = m_preset_bundle->project_config.opt_enum<BedType>("curr_bed_type");
      }
      auto page = add_options_page(L("Plate Settings"), "empty");
      auto optgroup = page->new_optgroup("");
      optgroup->append_single_option_line("curr_bed_type");
      for (auto& line : const_cast<std::vector<Line>&>(optgroup->get_lines())) {
          line.undo_to_sys = true;
      }
      optgroup->have_sys_config = [this] { m_back_to_sys = true; return true; };
    `);
    assert.deepEqual(f.pages[0].groups.map((g) => [g.title, g.lines.length]), [['', 1]]);
  });
});

describe('Tab.cpp statements the parser refuses', () => {
  const head = 'auto page = add_options_page(L("P"), "icon");\nauto optgroup = page->new_optgroup(L("G"), "icon");\n';

  it('names the file and line of an unknown layout statement', () => {
    const message = failure(`${head}optgroup->append_single_option_line(key_for("x"));`);
    assert.match(message, /^Tab\.cpp:6: unrecognised layout statement: optgroup->append_single_option_line\(key_for\("x"\)\)$/);
  });

  it('refuses layout under an unknown condition or in an unknown loop', () => {
    assert.match(failure(`${head}if (is_bbl) optgroup->append_single_option_line("x");`), /unrecognised condition around layout code \(layout statement\): if \(is_bbl\)/);
    assert.match(failure(`${head}for (auto k : keys) optgroup->append_single_option_line(k);`), /unrecognised loop around layout code/);
    assert.match(
      failure(`${head}while (more()) optgroup->append_single_option_line(next());`),
      /^Tab\.cpp:6: unrecognised loop around layout code \(layout statement\): while \(more\(\)\)$/,
    );
    assert.equal(failure(`${head}switch (kind) { case 1: optgroup->append_separator(); }`), 'Tab.cpp:6: "case" is not supported here');
    assert.match(failure(`${head}if (is_bbl) add_fancy_row(optgroup);`), /^Tab\.cpp:6: unrecognised condition around layout code \(statement using "optgroup"\)/);
  });

  it('refuses layout after a return, even a conditional one', () => {
    assert.equal(
      failure(`${head}return;\noptgroup->append_single_option_line("layer_height");`),
      'Tab.cpp:7: layout statement after the return on line 6: optgroup->append_single_option_line("layer_height")',
    );
    assert.match(
      failure(`${head}if (is_sla) { cleanup(); return; }\nauto other = page->new_optgroup(L("H"), "icon");`),
      /^Tab\.cpp:7: layout statement after the return on line 6: auto other=page->new_optgroup/,
    );
    assert.match(failure(`${head}for (auto x : xs) if (x) return;\nadd_wall_row("wall_loops");`), /^Tab\.cpp:7: statement naming the option "wall_loops" after the return on line 6/);
    // A return inside a callback is not the function's.
    const f = parse(`${head}optgroup->m_on_change = [this](const t_config_option_key& k, const boost::any& v) { if (k.empty()) return; update(); };
      optgroup->append_single_option_line("layer_height");`);
    assert.deepEqual(keysOf(f), ['layer_height']);
  });

  it('refuses unknown code that uses a page or group, names an option, or builds layout in a callback', () => {
    assert.equal(
      failure(`${head}append_fancy_option(optgroup, "not_an_option");`),
      'Tab.cpp:6: unrecognised statement using "optgroup": append_fancy_option(optgroup,"not_an_option")',
    );
    assert.match(failure(`${head}optgroup->set_title("x");`), /unrecognised statement using "optgroup": optgroup->set_title/);
    assert.match(failure(`${head}m_pages.push_back(page);`), /unrecognised statement using "page"/);
    assert.equal(failure(`${head}add_wall_row("wall_loops");`), 'Tab.cpp:6: unrecognised statement naming the option "wall_loops": add_wall_row("wall_loops")');
    assert.match(
      failure(`${head}optgroup->m_on_change = [this](const t_config_option_key& k, const boost::any& v) {\n  optgroup->append_single_option_line("layer_height");\n};`),
      /^Tab\.cpp:6: unrecognised layout code in a callback: optgroup->m_on_change=LAMBDA/,
    );
    // Still allowed: callbacks, display members, config reads that name options, page bookkeeping.
    const f = parse(`${head}
      optgroup->label_width = 0;
      optgroup->hide_labels();
      auto fn = [this](const t_config_option_key& k) { edit_custom_gcode(k); };
      optgroup->edit_custom_gcode = fn;
      auto *d = dynamic_cast<const ConfigOptionFloats*>(m_config->option("nozzle_diameter"));
      m_config->set_key_value("curr_bed_type", new ConfigOptionEnum<BedType>(t));
      wxLogMessage("the page and its optgroup are ready");
      m_pages.insert(m_pages.end() - n, page);
      return page;`);
    assert.deepEqual(f.pages.map((p) => p.title), ['P']);
  });

  it('refuses unknown option and line properties, indexes and variables', () => {
    assert.match(failure(`${head}Option o = optgroup->get_option("x");\no.opt.sidetext = "mm";`), /unknown option property "sidetext"/);
    assert.match(failure(`${head}Line l = { L("a"), L("b") };\nl.widget = make_widget;`), /unrecognised layout statement: l\.widget=make_widget/);
    assert.match(failure(`${head}optgroup->append_single_option_line("x", "wiki", some_idx);`), /unknown option index "some_idx"/);
    assert.match(failure(`${head}other->append_single_option_line("x");`), /"other" is not an options group here/);
    assert.match(failure(`${head}optgroup->append_single_option_line(missing);`), /"missing" is not an option here/);
    assert.match(failure(`${head}Line l = { L("a"), L("b") };\noptgroup->append_line(l);`), /line "l" has no options/);
  });

  it('refuses other preprocessor conditionals inside a build function', () => {
    assert.match(failure(`${head}#ifdef __WXMSW__\noptgroup->append_single_option_line("x");\n#endif`), /Tab\.cpp:6: preprocessor directive "#ifdef __WXMSW__" is not supported here/);
  });

  it('refuses a synthetic option without a complete definition', () => {
    assert.match(failure(`${head}ConfigOptionDef def;\ndef.label = L("X");\nOption o(def, "x");`), /the definition of "x" lacks a type, label or mode/);
    assert.match(failure(`${head}ConfigOptionDef def;\ndef.gui_type = legend;`), /unknown ConfigOptionDef field "gui_type"/);
  });

  it('refuses a Motion ability insertion it does not recognise', () => {
    assert.match(
      failure('if (existed_page < n_before_extruders && (is_marlin_flavor || from_initial_build)) { auto page = build_kinematics_page(); }'),
      /unrecognised Motion ability page insertion/,
    );
  });
});
