// Port of the configuration half of OrcaSlicer's CLI::run (src/OrcaSlicer.cpp on branch
// muon3d-wasm; "OS:<line>" below refers to that file). Blocks marked "copied" follow the CLI line
// by line, with the substitutions listed in engine/research/headless-entry.md §1.4; everything
// that only matters for 3MF input, machine switching or command-line options the engine never
// passes is left out, and each such omission is named where it happens. Keeping the structure of
// the original makes it possible to diff this file against a newer CLI when the fork moves.
#include "cli_config.hpp"

#include <libslic3r/libslic3r.h>
#include <libslic3r/Config.hpp>
#include <libslic3r/FilamentMixer.hpp>
#include <libslic3r/FlushVolCalc.hpp>
#include <libslic3r/Preset.hpp>
#include <libslic3r/PrintConfig.hpp>
#include <libslic3r/Utils.hpp>

#include <boost/filesystem.hpp>
#include <boost/nowide/fstream.hpp>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <map>
#include <set>

using namespace Slic3r;

namespace muon {
namespace {

[[noreturn]] void fail(int code, std::string message) { throw JobFailure(code, std::move(message)); }

void write_text_file(const std::string &path, const std::string &text)
{
    boost::nowide::ofstream out(path, std::ios::binary | std::ios::trunc);
    out.write(text.data(), std::streamsize(text.size()));
    out.close();
    if (!out)
        fail(ENGINE_INTERNAL_ERROR, "Could not write " + path + " to the engine's virtual file system.");
}

// ---------------------------------------------------------------------------------------------
// GUI helpers the CLI borrows (the engine has no slic3r/GUI), re-implemented verbatim.
// ---------------------------------------------------------------------------------------------

// src/slic3r/GUI/GUI_Utils.hpp:438-444
int hex_digit_to_int(const char c)
{
    return (c >= '0' && c <= '9') ? int(c - '0') :
           (c >= 'A' && c <= 'F') ? int(c - 'A') + 10 :
           (c >= 'a' && c <= 'f') ? int(c - 'a') + 10 : -1;
}

// src/slic3r/GUI/BitmapCache.cpp:543-556 (BitmapCache::parse_color4)
bool parse_color4(const std::string &scolor, unsigned char *rgba_out)
{
    rgba_out[0] = rgba_out[1] = rgba_out[2] = 0;
    rgba_out[3] = 255;
    if ((scolor.size() != 7 && scolor.size() != 9) || scolor.front() != '#')
        return false;
    const char *c = scolor.data() + 1;
    for (size_t i = 0; i < scolor.size() / 2; ++i) {
        int digit1 = hex_digit_to_int(*c++);
        int digit2 = hex_digit_to_int(*c++);
        if (digit1 == -1 || digit2 == -1)
            return false;
        rgba_out[i] = (unsigned char) (digit1 * 16 + digit2);
    }
    return true;
}

// src/slic3r/GUI/Plater.cpp:1034-1095 (GUI::get_min_flush_volumes), logging removed.
std::vector<int> get_min_flush_volumes(const DynamicPrintConfig &full_config, size_t nozzle_id)
{
    std::vector<int> extra_flush_volumes;

    const ConfigOptionFloatsNullable *nozzle_volume_opt = full_config.option<ConfigOptionFloatsNullable>("nozzle_volume");
    int nozzle_volume_val = nozzle_volume_opt ? (int) nozzle_volume_opt->get_at(nozzle_id) : 0;

    const ConfigOptionInt *enable_long_retraction_when_cut_opt = full_config.option<ConfigOptionInt>("enable_long_retraction_when_cut");
    int machine_enabled_level = 0;
    if (enable_long_retraction_when_cut_opt)
        machine_enabled_level = enable_long_retraction_when_cut_opt->value;
    const ConfigOptionBools *long_retractions_when_cut_opt = full_config.option<ConfigOptionBools>("long_retractions_when_cut");
    bool machine_activated = false;
    if (long_retractions_when_cut_opt)
        machine_activated = long_retractions_when_cut_opt->values[nozzle_id] == 1;

    size_t filament_size = full_config.option<ConfigOptionFloats>("filament_diameter")->values.size();
    std::vector<double> filament_retraction_distance_when_cut(filament_size, 18.0f), printer_retraction_distance_when_cut(filament_size, 18.0f);
    std::vector<unsigned char> filament_long_retractions_when_cut(filament_size, 0);
    const ConfigOptionFloats *filament_retraction_distances_when_cut_opt = full_config.option<ConfigOptionFloats>("filament_retraction_distances_when_cut");
    if (filament_retraction_distances_when_cut_opt)
        filament_retraction_distance_when_cut = filament_retraction_distances_when_cut_opt->values;

    const ConfigOptionFloats *printer_retraction_distance_when_cut_opt = full_config.option<ConfigOptionFloats>("retraction_distances_when_cut");
    if (printer_retraction_distance_when_cut_opt)
        printer_retraction_distance_when_cut = printer_retraction_distance_when_cut_opt->values;

    const ConfigOptionBools *filament_long_retractions_when_cut_opt = full_config.option<ConfigOptionBools>("filament_long_retractions_when_cut");
    if (filament_long_retractions_when_cut_opt)
        filament_long_retractions_when_cut = filament_long_retractions_when_cut_opt->values;

    for (size_t idx = 0; idx < filament_size; ++idx) {
        int extra_flush_volume = nozzle_volume_val;
        int retract_length = machine_enabled_level && machine_activated ? printer_retraction_distance_when_cut[nozzle_id] : 0;

        unsigned char filament_activated = filament_long_retractions_when_cut[idx];
        double filament_retract_length = filament_retraction_distance_when_cut[idx];

        if (filament_activated == 0)
            retract_length = 0;
        else if (filament_activated == 1 && machine_enabled_level == LongRectrationLevel::EnableFilament) {
            if (!std::isnan(filament_retract_length))
                retract_length = (int) filament_retraction_distance_when_cut[idx];
            else
                retract_length = printer_retraction_distance_when_cut[nozzle_id];
        }

        extra_flush_volume -= PI * 1.75 * 1.75 / 4 * retract_length;
        extra_flush_volumes.emplace_back(extra_flush_volume);
    }
    return extra_flush_volumes;
}

// ---------------------------------------------------------------------------------------------
// Copied CLI helpers
// ---------------------------------------------------------------------------------------------

// OS:590-649 (load_default_gcodes_to_config): creates the G-code keys a preset leaves out, so they
// end up empty in the full config instead of taking FullPrintConfig's defaults. Logging removed.
void load_default_gcodes_to_config(DynamicPrintConfig &config, Preset::Type type)
{
    if (config.size() == 0)
        return;
    if (type == Preset::TYPE_PRINTER) {
        config.option<ConfigOptionString>("change_filament_gcode", true);
        config.option<ConfigOptionString>("layer_change_gcode", true);
        config.option<ConfigOptionString>("machine_end_gcode", true);
        config.option<ConfigOptionString>("machine_pause_gcode", true);
        config.option<ConfigOptionString>("machine_start_gcode", true);
        config.option<ConfigOptionString>("template_custom_gcode", true);
        config.option<ConfigOptionString>("printing_by_object_gcode", true);
        config.option<ConfigOptionString>("before_layer_change_gcode", true);
        config.option<ConfigOptionString>("time_lapse_gcode", true);
        config.option<ConfigOptionString>("wrapping_detection_gcode", true);
    } else if (type == Preset::TYPE_FILAMENT) {
        std::vector<std::string> &filament_start_gcodes = config.option<ConfigOptionStrings>("filament_start_gcode", true)->values;
        if (filament_start_gcodes.empty())
            filament_start_gcodes.resize(1, std::string());
        std::vector<std::string> &filament_end_gcodes = config.option<ConfigOptionStrings>("filament_end_gcode", true)->values;
        if (filament_end_gcodes.empty())
            filament_end_gcodes.resize(1, std::string());
    }
}

// OS:3060-3121 (the update_full_config lambda), for the only way the CLI calls it with new
// presets: update_all = true, so the "keep the user's different keys" branch never runs.
int update_full_config(DynamicPrintConfig &full_config, const DynamicPrintConfig &config)
{
    for (const t_config_option_key &opt_key : config.keys()) {
        const ConfigOption *source_opt = config.option(opt_key);
        if (source_opt == nullptr)
            return CLI_CONFIG_FILE_ERROR;
        if (opt_key == "compatible_prints" || opt_key == "compatible_printers" || opt_key == "model_id" || opt_key == "inherits" ||
            opt_key == "dev_model_name" || opt_key == "name" || opt_key == "from" || opt_key == "type" || opt_key == "version" ||
            opt_key == "setting_id" || opt_key == "instantiation")
            continue;
        ConfigOption *dest_opt = full_config.option(opt_key, true);
        if (dest_opt == nullptr)
            return CLI_CONFIG_FILE_ERROR;
        dest_opt->set(source_opt);
    }
    return 0;
}

// OS:3180-3243: a newly loaded printer gets its machine_max_* limits lowered to the "CLI safe"
// values in resources/profiles/BBL/cli_config.json (only Bambu Lab A1, A1 mini and A2L have
// entries). The file comes from the engine's /resources; without it the CLI also skips this.
void apply_cli_safe_machine_limits(DynamicPrintConfig &m_print_config, const std::string &printer_model)
{
    const std::string cli_config_file = resources_dir() + "/profiles/BBL/cli_config.json";
    if (!boost::filesystem::exists(boost::filesystem::path(cli_config_file)))
        return;
    try {
        nlohmann::json            root_json;
        boost::nowide::ifstream ifs(cli_config_file);
        ifs >> root_json;
        ifs.close();
        if (!root_json.contains("printer"))
            return;
        nlohmann::json printer_json = root_json["printer"];
        if (printer_model.empty() || !printer_json.contains(printer_model))
            return;
        nlohmann::json printer_model_json = printer_json[printer_model];
        if (!printer_model_json.contains("machine_limits"))
            return;
        auto printer_params = printer_model_json["machine_limits"].get<std::map<std::string, std::string>>();
        for (auto param_iter = printer_params.begin(); param_iter != printer_params.end(); param_iter++) {
            std::string key = param_iter->first;
            // replace "cli_safe" with "machine_max"
            key.replace(0, 8, "machine_max");
            ConfigOptionFloats *option = m_print_config.option<ConfigOptionFloats>(key);
            if (!option)
                continue;
            unsigned int      array_count = option->size();
            ConfigOptionFloats new_option;
            new_option.deserialize(param_iter->second);
            unsigned int new_array_count = new_option.size();
            for (unsigned int index = 0; index < array_count; index++) {
                if ((index < new_array_count) && new_option.values[index] != 0.f && (new_option.values[index] < option->values[index]))
                    option->values[index] = new_option.values[index];
            }
        }
    } catch (const std::exception &) {
        // The CLI logs and carries on (OS:3238-3241).
    }
}

// ---------------------------------------------------------------------------------------------
// Preset loading (OS:2210-2284 load_config_file, plus the per-type bookkeeping after it)
// ---------------------------------------------------------------------------------------------

struct LoadedPreset {
    DynamicPrintConfig config;
    std::string        type;
    std::string        name;
    std::string        from;
    std::string        filament_id;
};

LoadedPreset load_config_file(const std::string &json_text, const std::string &file, const std::string &expected_type)
{
    write_text_file(file, json_text);

    LoadedPreset preset;
    const std::string what = "The " + expected_type + " preset";
    std::map<std::string, std::string> key_values;
    std::string                        reason;
    try {
        preset.config.load_from_json(file, ForwardCompatibilitySubstitutionRule::Enable, key_values, reason);
    } catch (const std::exception &ex) {
        fail(CLI_CONFIG_FILE_ERROR, what + " could not be loaded: " + ex.what());
    }
    if (!reason.empty())
        fail(CLI_CONFIG_FILE_ERROR, what + " could not be parsed: " + reason);

    preset.name = key_values[BBL_JSON_KEY_NAME];
    const std::string label = what + " \"" + preset.name + "\"";
    if (auto it = key_values.find(BBL_JSON_KEY_FROM); it != key_values.end())
        preset.from = it->second;
    if (preset.from != "system" && preset.from != "User" && preset.from != "user")
        fail(CLI_CONFIG_FILE_ERROR, label + " has from = \"" + preset.from + "\"; only system and user presets can be sliced.");

    // The CLI probes a missing type, and resolves `inherits`, through a PresetBundle built from
    // the vendor profiles. The engine has no profile tree, so presets must arrive flattened.
    auto type_it = key_values.find(BBL_JSON_KEY_TYPE);
    if (type_it == key_values.end())
        fail(CLI_CONFIG_FILE_ERROR, label + " has no \"type\"; pass flattened presets with type, name and from set.");
    preset.type = type_it->second;
    if (const auto *inherits = preset.config.option<ConfigOptionString>(BBL_JSON_KEY_INHERITS); inherits && !inherits->value.empty())
        fail(CLI_CONFIG_FILE_ERROR, label + " still inherits from \"" + inherits->value + "\"; pass flattened presets.");
    // The CLI sorts --load-settings files by their type and rejects duplicates; the engine's
    // slots are fixed, so a preset in the wrong slot is the same kind of error.
    if (preset.type != expected_type)
        fail(CLI_CONFIG_FILE_ERROR, what + " \"" + preset.name + "\" is of type \"" + preset.type + "\".");

    if (preset.type == "filament")
        if (auto it = key_values.find(BBL_JSON_KEY_FILAMENT_ID); it != key_values.end())
            preset.filament_id = it->second;

    preset.config.normalize_fdm();
    return preset;
}

PrinterTechnology get_printer_technology(const DynamicConfig &config)
{
    const ConfigOptionEnum<PrinterTechnology> *opt = config.option<ConfigOptionEnum<PrinterTechnology>>("printer_technology");
    return (opt == nullptr) ? ptUnknown : opt->value;
}

} // namespace

PreparedConfig prepare_config(const std::string              &machine_json,
                              const std::string              &process_json,
                              const std::vector<std::string> &filament_jsons,
                              const std::string              &work_dir)
{
    PreparedConfig      prepared;
    DynamicPrintConfig &m_print_config = prepared.print_config;
    DynamicPrintConfig &m_extra_config = prepared.extra_config;

    // ---- OS:1374-1380: the command-line options. The engine passes none, so the extra config
    // holds only these two defaults (no CLI option key exists in print_config_def).
    m_extra_config.set_key_value("has_filament_switcher", new ConfigOptionBool(false));
    m_extra_config.set_key_value("enable_filament_dynamic_map", new ConfigOptionBool(false));
    m_extra_config.normalize_fdm();

    // ---- OS:2287-2370: machine and process presets.
    LoadedPreset machine = load_config_file(machine_json, work_dir + "/machine.json", "machine");
    LoadedPreset process = load_config_file(process_json, work_dir + "/process.json", "process");

    PrinterTechnology printer_technology = ptUnknown;
    for (const DynamicPrintConfig *config : {&machine.config, &process.config}) {
        PrinterTechnology other_printer_technology = get_printer_technology(*config);
        if (printer_technology == ptUnknown)
            printer_technology = other_printer_technology;
        if ((printer_technology != other_printer_technology) && (other_printer_technology != ptUnknown))
            fail(CLI_INVALID_PRINTER_TECH, "The presets are for different printer technologies.");
    }

    const std::string new_printer_name             = machine.name;
    const bool        new_printer_config_is_system = machine.from == "system";
    const std::string new_printer_system_name      = new_printer_config_is_system ?
                                                         new_printer_name :
                                                         machine.config.option<ConfigOptionString>("inherits", true)->value;
    machine.config.set("printer_settings_id", new_printer_name, true);
    // printer_model_id (OS:2310-2323) only feeds 3MF export.
    const std::string printer_model = machine.config.option<ConfigOptionString>("printer_model", true)->value;

    const std::string new_process_name             = process.name;
    const bool        new_process_config_is_system = process.from == "system";
    const std::string new_process_system_name      = new_process_config_is_system ?
                                                         new_process_name :
                                                         process.config.option<ConfigOptionString>("inherits", true)->value;
    process.config.set("print_settings_id", new_process_name, true);
    std::vector<std::string> new_print_compatible_printers = process.config.option<ConfigOptionStrings>("compatible_printers", true)->values;
    std::string              different_process_setting;
    // The CLI reads values[0] unchecked (OS:2346); an empty list would be undefined behaviour there.
    if (const auto *diff = process.config.option<ConfigOptionStrings>("different_settings_to_system"); diff && !diff->values.empty())
        different_process_setting = diff->values[0];

    // ---- OS:2376-2475: filaments, one per slot (use_first_fila_as_default is off without 3MF).
    const int                       load_filament_count = int(filament_jsons.size());
    std::vector<int>                load_filaments_index;
    std::vector<DynamicPrintConfig> load_filaments_config;
    std::vector<std::string>        load_filaments_id, load_filaments_name, load_filaments_inherit;
    for (int index = 0; index < load_filament_count; index++) {
        LoadedPreset filament = load_config_file(filament_jsons[size_t(index)],
                                                 work_dir + "/filament_" + std::to_string(index + 1) + ".json", "filament");
        PrinterTechnology other_printer_technology = get_printer_technology(filament.config);
        if (printer_technology == ptUnknown)
            printer_technology = other_printer_technology;
        if ((printer_technology != other_printer_technology) && (other_printer_technology != ptUnknown))
            fail(CLI_INVALID_PRINTER_TECH, "The filament preset \"" + filament.name + "\" is for a different printer technology.");
        std::string inherits;
        if (filament.from == "User" || filament.from == "user")
            inherits = filament.config.option<ConfigOptionString>("inherits", true)->value;
        load_filaments_inherit.push_back(inherits);
        load_filaments_id.push_back(filament.filament_id);
        load_filaments_name.push_back(filament.name);
        load_filaments_config.push_back(std::move(filament.config));
        load_filaments_index.push_back(index + 1);
    }
    const int filament_count = load_filament_count; // OS:2535

    // ---- OS:2837-2966: "new process + new printer" compatibility check.
    if (!is_compatible_with_printer(process.config, Preset::TYPE_PRINT, machine.config, new_printer_system_name))
        fail(CLI_PROCESS_NOT_COMPATIBLE,
             "The process preset \"" + new_process_name + "\" is not compatible with the printer \"" + new_printer_name + "\".");

    // cli_different_settings (OS:2164-2208) diffs a user preset against its system parent through
    // a PresetBundle. Flattened presets have no parent (inherits is empty, checked above), and the
    // CLI returns "" for an empty parent name, so every different_settings_to_system column the
    // CLI would compute here is empty.

    // ---- OS:3125-3131
    std::vector<std::string> &different_settings = m_print_config.option<ConfigOptionStrings>("different_settings_to_system", true)->values;
    std::vector<std::string> &inherits_group     = m_print_config.option<ConfigOptionStrings>("inherits_group", true)->values;
    inherits_group.resize(filament_count + 2, std::string());
    different_settings.resize(filament_count + 2, std::string());
    if (!different_process_setting.empty())
        different_settings[0] = different_process_setting;

    // ---- OS:3134-3257: machine settings into the print config (new printer: update all keys).
    {
        different_settings[filament_count + 1] = std::string();
        inherits_group[filament_count + 1]     = new_printer_config_is_system ? std::string() : new_printer_system_name;

        load_default_gcodes_to_config(machine.config, Preset::TYPE_PRINTER);
        int ret = update_full_config(m_print_config, machine.config);
        // new_printer_name != current_printer_name (empty without a 3MF): printer safety limits.
        apply_cli_safe_machine_limits(m_print_config, printer_model);
        if (ret)
            fail(ret, "The printer preset \"" + new_printer_name + "\" could not be merged into the print config.");
    }
    int new_extruder_count = 1, new_printer_variant_count = 1;
    if (m_print_config.option<ConfigOptionFloats>("nozzle_diameter")) {
        new_extruder_count        = int(m_print_config.option<ConfigOptionFloats>("nozzle_diameter")->values.size());
        new_printer_variant_count = int(m_print_config.option<ConfigOptionStrings>("printer_extruder_variant", true)->values.size());
    }

    // ---- OS:3265-3338: process settings into the print config.
    {
        std::vector<std::string> &print_compatible_printers = m_print_config.option<ConfigOptionStrings>("print_compatible_printers", true)->values;
        different_settings[0] = different_process_setting; // "" when the preset carries none (see above)
        inherits_group[0]     = new_process_config_is_system ? std::string() : new_process_system_name;
        print_compatible_printers = std::move(new_print_compatible_printers);

        load_default_gcodes_to_config(process.config, Preset::TYPE_PRINT);
        int ret = update_full_config(m_print_config, process.config);
        if (ret)
            fail(ret, "The process preset \"" + new_process_name + "\" could not be merged into the print config.");
    }

    // ---- OS:3340-3366: nozzle volume types (no --nozzle-volume-type option). The extruder
    // variant strings computed there only feed machine switching (3MF), which never happens here.
    const int                     current_extruder_count = 1;
    std::vector<NozzleVolumeType> new_nozzle_volume_type(size_t(new_extruder_count), nvtStandard);
    std::vector<NozzleVolumeType> current_nozzle_volume_type(size_t(current_extruder_count), nvtStandard);

    // ---- OS:3432-3683: filament settings into the print config. Copied; the branches for
    // `load_filament_count == 0` (3MF re-slicing with the project's own filaments) are left out
    // because the block only runs with loaded filaments here.
    if (load_filament_count > 0) {
        std::vector<int> old_start_indice(filament_count, 0);
        std::vector<int> old_variant_counts(filament_count, 1), new_variant_counts;

        ConfigOptionInts *filament_self_index_opt    = m_print_config.option<ConfigOptionInts>("filament_self_index");
        bool              need_regenerate_self_index = !filament_self_index_opt;
        if (filament_self_index_opt) {
            // A stale filament_self_index (it can come from the process preset) must stay within
            // filament_count, or the walk below overruns old_start_indice (OS:3445-3460).
            int max_self_index = 0, min_self_index = 1;
            for (int v : filament_self_index_opt->values) {
                max_self_index = std::max(max_self_index, v);
                min_self_index = std::min(min_self_index, v);
            }
            if (max_self_index > filament_count || min_self_index < 1)
                need_regenerate_self_index = true;
        }
        if (need_regenerate_self_index) {
            filament_self_index_opt                = m_print_config.option<ConfigOptionInts>("filament_self_index", true);
            std::vector<int> &filament_self_indice = filament_self_index_opt->values;
            filament_self_indice.resize(filament_count);
            for (int index = 0; index < filament_count; index++)
                filament_self_indice[index] = index + 1;
        }

        std::vector<int> old_self_indice      = filament_self_index_opt->values;
        int              old_self_indice_size = int(old_self_indice.size());
        int              k = -1, current_filament = 0;
        for (int i = 0; i < old_self_indice_size; i++) {
            if (old_self_indice[i] > current_filament) {
                current_filament      = old_self_indice[i];
                old_start_indice[++k] = i;
                old_variant_counts[k] = 1;
            } else {
                old_variant_counts[k] = old_variant_counts[k] + 1;
            }
        }
        new_variant_counts = old_variant_counts;
        for (int index = 0; index < int(load_filaments_config.size()); index++) {
            DynamicPrintConfig &config         = load_filaments_config[index];
            int                 filament_index = load_filaments_index[index];

            load_default_gcodes_to_config(config, Preset::TYPE_FILAMENT);

            {
                ConfigOptionStrings *opt_filament_settings  = static_cast<ConfigOptionStrings *>(m_print_config.option("filament_settings_id", true));
                std::string         &filament_name          = load_filaments_name[index];
                ConfigOptionString  *filament_name_setting  = new ConfigOptionString(filament_name);
                if (int(opt_filament_settings->size()) < filament_count)
                    opt_filament_settings->resize(filament_count, filament_name_setting);
                opt_filament_settings->set_at(filament_name_setting, filament_index - 1, 0);
                delete filament_name_setting; // the CLI leaks it; resize/set_at only copy from it
                config.erase("filament_settings_id");

                different_settings[filament_index] = std::string(); // cli_different_settings: no parent
                inherits_group[filament_index]     = load_filaments_inherit[index];
            }

            // add filament_id
            std::string         &filament_id         = load_filaments_id[index];
            ConfigOptionStrings *opt_filament_ids    = static_cast<ConfigOptionStrings *>(m_print_config.option("filament_ids", true));
            ConfigOptionString  *filament_id_setting = new ConfigOptionString(filament_id);
            if (int(opt_filament_ids->size()) < filament_count)
                opt_filament_ids->resize(filament_count, filament_id_setting);
            opt_filament_ids->set_at(filament_id_setting, filament_index - 1, 0);
            delete filament_id_setting;

            // compute the variant index logic
            ConfigOptionStrings *curr_variant_opt = m_print_config.option<ConfigOptionStrings>("filament_extruder_variant");
            if (!curr_variant_opt) {
                curr_variant_opt                         = m_print_config.option<ConfigOptionStrings>("filament_extruder_variant", true);
                std::vector<std::string> &filament_variants = curr_variant_opt->values;
                filament_variants.resize(filament_count, get_extruder_variant_string(etDirectDrive, nvtStandard));
            }
            const ConfigOptionStrings *new_variant_opt = dynamic_cast<const ConfigOptionStrings *>(config.option("filament_extruder_variant", true));

            // new_variant_indice is only read by the "keep user's different keys" branch, which
            // needs load_filament_count == 0; computed anyway to keep the copy recognisable.
            std::vector<int> new_variant_indice;
            int              new_variant_count = int(new_variant_opt->size()), old_variant_count = old_variant_counts[filament_index - 1];
            new_variant_indice.resize(new_variant_count, -1);
            for (int i = 0; i < new_variant_count; i++) {
                for (int j = old_start_indice[filament_index - 1]; j < old_start_indice[filament_index - 1] + old_variant_count; j++) {
                    if (curr_variant_opt->values[j] == new_variant_opt->values[i]) {
                        new_variant_indice[i] = j;
                        break;
                    }
                }
            }

            // loop through options and apply them
            for (const t_config_option_key &opt_key : config.keys()) {
                const ConfigOption *source_opt = config.option(opt_key);
                if (source_opt == nullptr)
                    fail(CLI_CONFIG_FILE_ERROR, "Can not find " + opt_key + " in the filament preset \"" + load_filaments_name[index] + "\".");

                if (source_opt->is_scalar()) {
                    if (opt_key == "compatible_printers_condition") {
                        ConfigOption        *opt         = m_print_config.option("compatible_machine_expression_group", true);
                        ConfigOptionStrings *opt_vec_dst = static_cast<ConfigOptionStrings *>(opt);
                        if (opt_vec_dst->size() == 0) {
                            ConfigOptionString empty;
                            opt_vec_dst->resize(filament_count + 2, &empty);
                        }
                        opt_vec_dst->set_at(source_opt, filament_index, 0);
                    } else if (opt_key == "compatible_prints_condition") {
                        ConfigOption        *opt         = m_print_config.option("compatible_process_expression_group", true);
                        ConfigOptionStrings *opt_vec_dst = static_cast<ConfigOptionStrings *>(opt);
                        if (opt_vec_dst->size() == 0) {
                            ConfigOptionString empty;
                            opt_vec_dst->resize(filament_count, &empty);
                        }
                        opt_vec_dst->set_at(source_opt, filament_index - 1, 0);
                    } else {
                        // skip the scalar values
                        continue;
                    }
                } else {
                    if (opt_key == "compatible_prints" || opt_key == "compatible_printers" || opt_key == "model_id" || opt_key == "dev_model_name" ||
                        opt_key == "filament_settings_id")
                        continue;
                    ConfigOption *opt = m_print_config.option(opt_key, true);
                    if (opt == nullptr)
                        fail(CLI_CONFIG_FILE_ERROR,
                             "Can not create option " + opt_key + " from the filament preset \"" + load_filaments_name[index] + "\".");
                    ConfigOptionVectorBase       *opt_vec_dst = static_cast<ConfigOptionVectorBase *>(opt);
                    const ConfigOptionVectorBase *opt_vec_src = static_cast<const ConfigOptionVectorBase *>(source_opt);
                    if (filament_options_with_variant.find(opt_key) != filament_options_with_variant.end()) {
                        std::vector<int> temp_variant_indice;
                        temp_variant_indice.resize(new_variant_count, -1);
                        opt_vec_dst->set_with_restore_2(opt_vec_src, temp_variant_indice, old_start_indice[filament_index - 1], old_variant_count, true);

                        if (opt_key == "filament_extruder_variant")
                            new_variant_counts[filament_index - 1] = int(opt_vec_src->size());
                    } else {
                        opt_vec_dst->set_at(opt_vec_src, filament_index - 1, 0);
                    }
                }
            }

            // update the old index
            if (old_variant_count != new_variant_count) {
                for (int i = index + 1; i < filament_count; i++)
                    old_start_indice[i] += new_variant_count - old_variant_count;
            }
        }

        if (m_print_config.option<ConfigOptionStrings>("filament_extruder_variant")) {
            std::vector<int> &filament_self_indice = m_print_config.option<ConfigOptionInts>("filament_self_index", true)->values;
            int               index_size           = int(m_print_config.option<ConfigOptionStrings>("filament_extruder_variant")->size());
            filament_self_indice.resize(index_size, 1);
            int k2 = 0;
            for (int i = 0; i < filament_count; i++) {
                for (int j = 0; j < new_variant_counts[i]; j++)
                    filament_self_indice[k2++] = i + 1;
            }
        }
    }

    // ---- OS:3685-3862: flush volume matrix. Copied; there is no --filament-colour option, so the
    // CLI's `selected_filament_colors` is always empty and the colour-override code is left out.
    {
        ConfigOptionStrings *project_filament_colors_option = m_print_config.option<ConfigOptionStrings>("filament_colour");
        if (project_filament_colors_option &&
            (!m_print_config.option<ConfigOptionFloats>("flush_volumes_matrix") || (current_extruder_count != new_extruder_count) ||
             (new_nozzle_volume_type != current_nozzle_volume_type))) {
            std::vector<std::string> &project_filament_colors = project_filament_colors_option->values;
            size_t                    project_filament_count  = project_filament_colors.size();
            if (project_filament_count > 0) {
                ConfigOptionBools     *filament_is_support = m_print_config.option<ConfigOptionBools>("filament_is_support", true);
                const std::vector<int> min_flush_volumes   = get_min_flush_volumes(m_print_config, 0);

                if (filament_is_support->size() != project_filament_count)
                    fail(CLI_CONFIG_FILE_ERROR, "filament_is_support has " + std::to_string(filament_is_support->size()) +
                                                    " values but filament_colour has " + std::to_string(project_filament_count) + ".");

                std::vector<double> &flush_vol_matrix = m_print_config.option<ConfigOptionFloats>("flush_volumes_matrix", true)->values;
                flush_vol_matrix.resize(project_filament_count * project_filament_count * new_extruder_count, 0.f);

                // set multiplier to 1?
                std::vector<double> &flush_multipliers = m_print_config.option<ConfigOptionFloats>("flush_multiplier", true)->values;
                flush_multipliers.resize(new_extruder_count, 1.f);

                std::vector<int> nozzle_flush_dataset(new_extruder_count, 0);
                {
                    std::vector<int> nozzle_flush_dataset_full = m_print_config.option<ConfigOptionIntsNullable>("nozzle_flush_dataset", true)->values;
                    if (m_print_config.has("printer_extruder_variant"))
                        nozzle_flush_dataset_full.resize(new_printer_variant_count, 0);
                    else
                        nozzle_flush_dataset_full.resize(1, 0);

                    std::vector<int> extruders;
                    if (m_print_config.has("extruder_type"))
                        extruders = m_print_config.option<ConfigOptionEnumsGeneric>("extruder_type")->values;
                    else
                        extruders.resize(1, int(ExtruderType::etDirectDrive));

                    std::vector<int> volume_types;
                    if (m_print_config.has("nozzle_volume_type"))
                        volume_types = m_print_config.option<ConfigOptionEnumsGeneric>("nozzle_volume_type")->values; // get volume type from 3mf
                    else
                        volume_types.resize(1, int(NozzleVolumeType::nvtStandard));

                    for (int eidx = 0; eidx < new_extruder_count; ++eidx) {
                        int index = 0;
                        if (m_print_config.has("printer_extruder_id") && m_print_config.has("printer_extruder_variant"))
                            index = m_print_config.get_index_for_extruder(eidx + 1, "printer_extruder_id", ExtruderType(extruders[eidx]),
                                                                          NozzleVolumeType(volume_types[eidx]), "printer_extruder_variant");
                        nozzle_flush_dataset[eidx] = nozzle_flush_dataset_full[index];
                    }
                }

                // A mixed slot never reaches a nozzle, so its row and column stay empty, as in the GUI.
                const ConfigOptionBools *is_mixed_opt = m_extra_config.option<ConfigOptionBools>("filament_is_mixed");
                if (!is_mixed_opt)
                    is_mixed_opt = m_print_config.option<ConfigOptionBools>("filament_is_mixed");
                auto is_mixed_slot = [is_mixed_opt](int idx) {
                    return is_mixed_opt && idx < static_cast<int>(is_mixed_opt->values.size()) && is_mixed_opt->values[idx];
                };

                for (size_t nozzle_id = 0; nozzle_id < size_t(new_extruder_count); ++nozzle_id) {
                    std::vector<double> flush_vol_mtx = get_flush_volumes_matrix(flush_vol_matrix, nozzle_id, new_extruder_count);
                    for (int from_idx = 0; from_idx < int(project_filament_count); from_idx++) {
                        const std::string &from_color  = project_filament_colors[from_idx];
                        unsigned char      from_rgb[4] = {};
                        parse_color4(from_color, from_rgb);
                        bool is_from_support = filament_is_support->get_at(from_idx);
                        for (int to_idx = 0; to_idx < int(project_filament_count); to_idx++) {
                            bool is_to_support = filament_is_support->get_at(to_idx);
                            if (from_idx == to_idx || is_mixed_slot(from_idx) || is_mixed_slot(to_idx)) {
                                flush_vol_mtx[project_filament_count * from_idx + to_idx] = 0.f;
                            } else {
                                int flushing_volume = 0;
                                if (is_to_support) {
                                    flushing_volume = Slic3r::g_flush_volume_to_support;
                                } else {
                                    const std::string &to_color  = project_filament_colors[to_idx];
                                    unsigned char      to_rgb[4] = {};
                                    parse_color4(to_color, to_rgb);

                                    Slic3r::FlushVolCalculator calculator(min_flush_volumes[from_idx], Slic3r::g_max_flush_volume,
                                                                          nozzle_flush_dataset[nozzle_id]);
                                    flushing_volume = calculator.calc_flush_vol(from_rgb[3], from_rgb[0], from_rgb[1], from_rgb[2], to_rgb[3],
                                                                                to_rgb[0], to_rgb[1], to_rgb[2]);
                                    if (is_from_support)
                                        flushing_volume = std::max(Slic3r::g_min_flush_volume_from_support, flushing_volume);
                                }
                                flush_vol_mtx[project_filament_count * from_idx + to_idx] = flushing_volume;
                            }
                        }
                        set_flush_volumes_matrix(flush_vol_matrix, flush_vol_mtx, nozzle_id, new_extruder_count);
                    }
                }
            }
        }
    }

    // OS:3866: printer_technology defaults to FFF. OS:3869-3887 merges the per-file Models; the
    // engine builds a single Model directly (slice_job.cpp).
    if (printer_technology == ptUnknown)
        printer_technology = ptFFF;

    // ---- OS:3990-4057: command-line options override the loaded files, then normalise. No option
    // on the (empty) command line is also in m_extra_config, so no override bookkeeping happens.
    m_print_config.apply(m_extra_config, true);
    m_print_config.normalize_fdm();

    // ---- OS:4059-4073: a mixed slot needs a filament of its own.
    if (const auto *is_mixed_opt = m_print_config.option<ConfigOptionBools>("filament_is_mixed")) {
        const auto &is_mixed = is_mixed_opt->values;
        for (size_t slot = static_cast<size_t>(std::max(filament_count, 0)); slot < is_mixed.size(); ++slot) {
            if (!is_mixed[slot])
                continue;
            fail(CLI_MIXED_FILAMENT_INVALID, "Mixed filament slot " + std::to_string(slot + 1) + " has no filament of its own; only " +
                                                 std::to_string(filament_count) + " filaments are loaded.");
        }
    }

    m_print_config.option<ConfigOptionEnum<PrinterTechnology>>("printer_technology", true)->value = printer_technology;

    // ---- OS:4079-4101: synchronise with the full FFF defaults (this is where e.g. curr_bed_type
    // falls back to Cool Plate when no preset sets it).
    if (printer_technology != ptFFF)
        fail(CLI_INVALID_PRINTER_TECH, "Only FDM printers can be sliced.");
    {
        FullPrintConfig fff_print_config;
        fff_print_config.apply(m_print_config, true);
        m_print_config.apply(fff_print_config, true);
    }

    // ---- OS:4103-4110
    std::map<std::string, std::string> validity = m_print_config.validate(true);
    if (!validity.empty()) {
        std::string message = "Invalid setting values:";
        for (const auto &[key, reason] : validity)
            message += " " + key + ": " + reason + ";";
        message.pop_back();
        message += ".";
        fail(CLI_INVALID_VALUES_IN_3MF, message);
    }

    // ---- OS:4112-4122: these lookups create the options when absent (no other effect here; the
    // prime-tower-after-mapping logic below them needs a 3MF).
    m_print_config.option<ConfigOptionBool>("enable_wrapping_detection", true);
    m_print_config.opt<ConfigOptionPoints>("wrapping_exclude_area", true);

    prepared.printer_name        = new_printer_name;
    prepared.printer_system_name = new_printer_system_name;
    prepared.extruder_count      = new_extruder_count;
    prepared.filament_count      = filament_count;
    return prepared;
}

} // namespace muon
