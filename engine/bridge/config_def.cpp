// configDefinitions(): see config_def.hpp. Every value comes from libslic3r itself, so labels,
// limits, enums and defaults are exactly what the engine slices with, in Orca's own text encoding
// (the default of a scalar is serialize(), of a vector the array of vserialize(), as
// ConfigBase::save_to_json writes presets). SLA options are left out.
#include "config_def.hpp"

#include <libslic3r/libslic3r.h> // also brings libslic3r_version.h (SoftFever_VERSION)
#include <libslic3r/Config.hpp>
#include <libslic3r/Preset.hpp>
#include <libslic3r/PrintConfig.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cfloat>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <set>
#include <string>
#include <vector>

// Set by the build (engine/cmake/Engine.cmake), as for version().
#ifndef ORCA_ENGINE_COMMIT
#define ORCA_ENGINE_COMMIT "unknown"
#endif

using namespace Slic3r;
using json = nlohmann::json;

namespace muon {
namespace {

// Bump when the shape changes (web/src/engine/configDefinitions.ts CONFIG_DEFINITIONS_FORMAT).
constexpr int FORMAT = 1;

const char *type_name(ConfigOptionType type)
{
    switch (type) {
    case coFloat: return "float";
    case coFloats: return "floats";
    case coInt: return "int";
    case coInts: return "ints";
    case coString: return "string";
    case coStrings: return "strings";
    case coPercent: return "percent";
    case coPercents: return "percents";
    case coFloatOrPercent: return "floatOrPercent";
    case coFloatsOrPercents: return "floatsOrPercents";
    case coPoint: return "point";
    case coPoints: return "points";
    case coPoint3: return "point3";
    case coBool: return "bool";
    case coBools: return "bools";
    case coEnum: return "enum";
    case coEnums: return "enums";
    case coPointsGroups: return "pointsGroups";
    case coIntsGroups: return "intsGroups";
    default: return "none";
    }
}

const char *mode_name(ConfigOptionMode mode)
{
    switch (mode) {
    case comSimple: return "simple";
    case comAdvanced: return "advanced";
    case comExpert: return "expert";
    default: return "develop";
    }
}

const char *gui_type_name(ConfigOptionDef::GUIType type)
{
    using GUIType = ConfigOptionDef::GUIType;
    switch (type) {
    case GUIType::i_enum_open: return "i_enum_open";
    case GUIType::f_enum_open: return "f_enum_open";
    case GUIType::color: return "color";
    case GUIType::select_open: return "select_open";
    case GUIType::slider: return "slider";
    case GUIType::legend: return "legend";
    case GUIType::one_string: return "one_string";
    case GUIType::plugin_picker: return "plugin_picker";
    case GUIType::plugin_config: return "plugin_config";
    case GUIType::printer_agent_select: return "printer_agent_select";
    default: return "";
    }
}

// A float limit as the shortest decimal that reads back as the same float (0.1f is 0.1, not
// 0.10000000149011612), so the JSON shows the number Orca's source wrote.
double shortest(float value)
{
    char text[32];
    for (int digits = 1; digits <= 9; ++digits) {
        std::snprintf(text, sizeof text, "%.*g", digits, double(value));
        if (std::strtof(text, nullptr) == value)
            return std::strtod(text, nullptr);
    }
    return double(value);
}

template<typename Keys> json sorted_keys(const Keys &keys)
{
    std::set<std::string> sorted(keys.begin(), keys.end());
    return json(std::vector<std::string>(sorted.begin(), sorted.end()));
}

// The option's default as a preset holds it: ConfigOptionDef::create_default_option (Config.cpp:299)
// gives enums the option's names, which the stored default lacks (a ConfigOptionEnumsGeneric made
// without a keys_map serializes every value as ""). Done here because that function leaks a clone
// for enums.
std::unique_ptr<ConfigOption> default_option(const ConfigOptionDef &def)
{
    std::unique_ptr<ConfigOption> value(def.default_value->clone());
    if (value->type() == coEnum)
        return std::make_unique<ConfigOptionEnumGeneric>(def.enum_keys_map, value->getInt());
    if (auto *enums = dynamic_cast<ConfigOptionEnumsGeneric *>(value.get()))
        enums->keys_map = def.enum_keys_map;
    else if (auto *nullable_enums = dynamic_cast<ConfigOptionEnumsGenericNullable *>(value.get()))
        nullable_enums->keys_map = def.enum_keys_map;
    return value;
}

// ConfigBase::save_to_json's encoding of one value (Config.cpp:1545-1565).
json encoded_default(const std::string &key, const ConfigOption &value)
{
    if (value.is_vector())
        return json(static_cast<const ConfigOptionVectorBase &>(value).vserialize());
    if (value.type() == coString && key != "bed_custom_texture" && key != "bed_custom_model")
        return json(static_cast<const ConfigOptionString &>(value).value);
    return json(value.serialize());
}

json option_json(const std::string &key, const ConfigOptionDef &def)
{
    json o = json::object();
    o["type"]       = type_name(def.type);
    o["technology"] = def.printer_technology == ptFFF ? "fff" : "any";
    if (def.nullable)
        o["nullable"] = true;
    o["label"]     = def.label;
    o["fullLabel"] = def.full_label;
    o["tooltip"]   = def.tooltip;
    o["sidetext"]  = def.sidetext;
    o["category"]  = def.category;
    o["mode"]      = mode_name(def.mode);
    // Orca's "no limit" is ±FLT_MAX.
    if (def.min > -FLT_MAX)
        o["min"] = shortest(def.min);
    if (def.max < FLT_MAX)
        o["max"] = shortest(def.max);
    o["maxLiteral"] = def.max_literal;
    o["ratioOver"]  = def.ratio_over;
    o["enumValues"] = def.enum_values;
    o["enumLabels"] = def.enum_labels;
    if (def.enum_keys_map != nullptr) {
        // Every name deserialize() accepts (the combo box may list fewer), with its C++ value.
        json keys = json::object();
        for (const auto &[name, number] : *def.enum_keys_map)
            keys[name] = number;
        o["enumKeys"] = std::move(keys);
    }
    o["guiType"]  = gui_type_name(def.gui_type);
    o["guiFlags"] = def.gui_flags;
    if (!def.plugin_type.empty())
        o["pluginType"] = def.plugin_type;
    o["multiline"] = def.multiline;
    o["fullWidth"] = def.full_width;
    o["isCode"]    = def.is_code;
    o["readonly"]  = def.readonly;
    if (def.height >= 0)
        o["height"] = def.height;
    if (def.width >= 0)
        o["width"] = def.width;
    o["aliases"]  = def.aliases;
    o["shortcut"] = def.shortcut;
    o["cli"]      = def.cli != ConfigOptionDef::nocli;
    if (def.default_value) {
        try {
            o["default"] = encoded_default(key, *default_option(def));
        } catch (const std::exception &) {
            // A default Orca cannot write back as text (none today): left out.
        }
    }
    return o;
}

} // namespace

std::string config_definitions_json()
{
    try {
        json options = json::object();
        for (const auto &[key, def] : print_config_def.options) {
            if (def.printer_technology == ptSLA)
                continue;
            options[key] = option_json(key, def);
        }

        json out = json::object();
        out["format"]      = FORMAT;
        out["orcaVersion"] = SoftFever_VERSION;
        out["orcaCommit"]  = ORCA_ENGINE_COMMIT;
        out["options"]     = std::move(options);
        // Which preset stores each key (Preset.cpp). "machine" is the whole printer preset: its own
        // keys, the machine limits and the per-nozzle keys.
        out["presetKeys"] = {
            {"process", sorted_keys(Preset::print_options())},
            {"filament", sorted_keys(Preset::filament_options())},
            {"machine", sorted_keys(Preset::printer_options())},
            {"machineLimits", sorted_keys(Preset::machine_limits_options())},
        };
        // Vectors with one entry per nozzle, and the retraction keys filament presets override.
        out["extruderKeys"]         = sorted_keys(print_config_def.extruder_option_keys());
        out["extruderRetractKeys"]  = sorted_keys(print_config_def.extruder_retract_keys());
        out["filamentOverrideKeys"] = sorted_keys(filament_extruder_override_keys);
        // Vectors with one entry per extruder variant (PrintConfig.cpp print_options_with_variant, …).
        out["variantKeys"] = {
            {"print", sorted_keys(print_options_with_variant)},
            {"filament", sorted_keys(filament_options_with_variant)},
            {"printer1", sorted_keys(printer_options_with_variant_1)},
            {"printer2", sorted_keys(printer_options_with_variant_2)},
        };
        // What an object (PrintObjectConfig) and a part or modifier (PrintRegionConfig) can override.
        out["objectKeys"] = sorted_keys(PrintObjectConfig().keys());
        out["regionKeys"] = sorted_keys(PrintRegionConfig().keys());
        return out.dump(-1, ' ', false, json::error_handler_t::replace);
    } catch (const std::exception &ex) {
        return json{{"error", std::string("The option definitions could not be written: ") + ex.what()}}.dump(-1, ' ', false,
                                                                                                           json::error_handler_t::replace);
    }
}

} // namespace muon
