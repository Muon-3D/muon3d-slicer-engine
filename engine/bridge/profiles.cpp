// See profiles.hpp. Everything that decides a value is Orca's own code; this file only moves the files
// into the virtual file system, calls Orca, and writes down what came out.
#include "profiles.hpp"

#include "job.hpp"
#include "log_capture.hpp"
#include "model_input.hpp"

#include <libslic3r/AppConfig.hpp>
#include <libslic3r/Config.hpp>
#include <libslic3r/Preset.hpp>
#include <libslic3r/PresetBundle.hpp>
#include <libslic3r/PrintConfig.hpp>
#include <libslic3r/Utils.hpp>

#include <boost/algorithm/string/predicate.hpp>
#include <boost/filesystem.hpp>
#include <boost/nowide/fstream.hpp>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <cstring>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>

using namespace Slic3r;
using json  = nlohmann::json;
using ojson = nlohmann::ordered_json;
namespace fs = boost::filesystem;

namespace muon {
namespace {

[[noreturn]] void bad_request(const std::string &message) { throw JobFailure(ENGINE_BAD_REQUEST, message); }

json parse_request(const std::string &text, const char *op)
{
    json request = json::parse(text, nullptr, /* allow_exceptions */ false);
    if (!request.is_object())
        bad_request(std::string(op) + ": the request is not a JSON object.");
    return request;
}

void write_text_file(const fs::path &path, const std::string &text)
{
    boost::system::error_code ec;
    fs::create_directories(path.parent_path(), ec);
    boost::nowide::ofstream out(path.string(), std::ios::binary | std::ios::trunc);
    out.write(text.data(), std::streamsize(text.size()));
    out.close();
    if (!out)
        throw JobFailure(ENGINE_INTERNAL_ERROR, "Could not write " + path.string() + " to the engine's virtual file system.");
}

// Slic3r::data_dir() is process-wide: set for one call, then put back.
class DataDirScope {
public:
    explicit DataDirScope(const std::string &dir) : m_saved(data_dir()) { set_data_dir(dir); }
    ~DataDirScope() { set_data_dir(m_saved); }

private:
    std::string m_saved;
};

// ---------------------------------------------------------------------------------------------
// Preset types
// ---------------------------------------------------------------------------------------------

bool preset_type(const std::string &name, Preset::Type &type)
{
    if (name == "machine")
        type = Preset::TYPE_PRINTER;
    else if (name == "process")
        type = Preset::TYPE_PRINT;
    else if (name == "filament")
        type = Preset::TYPE_FILAMENT;
    else
        return false;
    return true;
}

const char *type_name(Preset::Type type)
{
    switch (type) {
    case Preset::TYPE_PRINTER: return "machine";
    case Preset::TYPE_PRINT: return "process";
    default: return "filament";
    }
}

// The settings a preset of `type` can hold: the keys of that type's default preset, which is what
// Preset::remove_invalid_keys checks a vendor preset against (its parent's config, whose keys are its
// root's, the type's default preset or, for printers, default_preset_for the root's technology).
const DynamicPrintConfig &type_defaults(Preset::Type type, const DynamicPrintConfig &config)
{
    static const PresetBundle *defaults = new PresetBundle(); // never freed: the defaults are immutable
    switch (type) {
    case Preset::TYPE_PRINTER: return defaults->printers.default_preset_for(config).config;
    case Preset::TYPE_PRINT: return defaults->prints.default_preset().config;
    default: return defaults->filaments.default_preset().config;
    }
}

// ---------------------------------------------------------------------------------------------
// profiles.normalize
// ---------------------------------------------------------------------------------------------

// The keys ConfigBase::load_from_json keeps out of the config (compared without case, as it does);
// `inherits` too, since vendor presets are loaded with load_inherits_to_config = false.
const char *const k_metadata_keys[] = {BBL_JSON_KEY_VERSION, BBL_JSON_KEY_NAME,          BBL_JSON_KEY_URL,
                                       BBL_JSON_KEY_TYPE,    BBL_JSON_KEY_SETTING_ID,    BBL_JSON_KEY_FILAMENT_ID,
                                       BBL_JSON_KEY_FROM,    BBL_JSON_KEY_DESCRIPTION,   BBL_JSON_KEY_INSTANTIATION,
                                       BBL_JSON_KEY_INHERITS, ORCA_JSON_KEY_RENAMED_FROM};

bool is_metadata_key(const std::string &key)
{
    for (const char *m : k_metadata_keys)
        if (boost::iequals(key, m))
            return true;
    return false;
}

// A value ConfigBase::load_from_json reads (Config.cpp, parse_str_arr): a string, or an array whose
// elements are all of one JSON type, each a string or itself such an array.
bool readable_value(const json &value)
{
    if (value.is_string())
        return true;
    if (!value.is_array())
        return false;
    const char *type = nullptr;
    for (const json &element : value) {
        if (type == nullptr)
            type = element.type_name();
        else if (std::strcmp(type, element.type_name()) != 0)
            return false;
        if (!(element.is_string() || (element.is_array() && readable_value(element))))
            return false;
    }
    return true;
}

// The option key Orca stores a file key under: PrintConfigDef::handle_legacy, then an alias
// (set_deserialize_raw). Empty: Orca ignores the key.
std::string stored_key(const std::string &key, const json &value)
{
    t_config_option_key opt_key = key;
    std::string         text    = value.is_string() ? value.get<std::string>() : std::string();
    PrintConfigDef::handle_legacy(opt_key, text);
    if (opt_key.empty() || print_config_def.get(opt_key) != nullptr)
        return opt_key;
    for (const auto &[name, def] : print_config_def.options)
        for (const t_config_option_key &alias : def.aliases)
            if (alias == opt_key)
                return name;
    return std::string();
}

ojson normalize_one(const json &item, const std::string &work_dir)
{
    ojson out;
    if (!item.is_object() || !item.contains("type") || !item["type"].is_string() || !item.contains("config") || !item["config"].is_object()) {
        out["error"] = "Each preset must be { type, config }.";
        return out;
    }
    Preset::Type type;
    if (!preset_type(item["type"].get<std::string>(), type)) {
        out["error"] = "\"type\" must be machine, process or filament.";
        return out;
    }
    const json &input = item["config"];

    std::vector<std::string>                         dropped;
    std::vector<std::pair<std::string, std::string>> renamed;
    std::set<std::string>                            named; // option keys the file names, as Orca stores them
    json                                             readable = json::object();
    for (auto it = input.begin(); it != input.end(); ++it) {
        const std::string &key = it.key();
        if (!readable_value(it.value())) {
            // Orca skips such a value with a log line (or, for an array it cannot read, stops reading
            // the file there); either way it is not loaded.
            dropped.push_back(key);
            continue;
        }
        readable[key] = it.value();
        if (boost::iequals(key, BBL_JSON_KEY_IS_CUSTOM)) {
            dropped.push_back(key);
            continue;
        }
        if (is_metadata_key(key))
            continue;
        const std::string stored = stored_key(key, it.value());
        if (stored.empty())
            dropped.push_back(key);
        else {
            if (stored != key)
                renamed.emplace_back(key, stored);
            named.insert(stored);
        }
    }

    const std::string file = work_dir + "/preset.json";
    write_text_file(file, readable.dump());
    DynamicPrintConfig                 config;
    ConfigSubstitutionContext          substitutions(ForwardCompatibilitySubstitutionRule::Enable);
    std::map<std::string, std::string> key_values;
    std::string                        reason;
    try {
        config.load_from_json(file, substitutions, /* load_inherits_to_config */ false, key_values, reason);
    } catch (const std::bad_alloc &) {
        throw;
    } catch (const std::exception &ex) {
        reason = ex.what();
    }
    if (!reason.empty()) {
        out["error"] = "Orca could not read the preset: " + reason;
        return out;
    }

    // Preset::remove_invalid_keys, as PresetBundle::load_vendor_preset runs it.
    const DynamicPrintConfig &defaults = type_defaults(type, config);
    std::vector<std::string>  misplaced;
    for (const std::string &key : config.keys())
        if (!defaults.has(key)) {
            misplaced.push_back(key);
            config.erase(key);
        }

    // The settings in Orca's own text, as it saves presets.
    std::ostringstream saved_text;
    config.save_to_json(saved_text, std::string(), std::string(), std::string());
    json saved = json::parse(saved_text.str());
    for (const char *header : {BBL_JSON_KEY_VERSION, BBL_JSON_KEY_NAME, BBL_JSON_KEY_FROM})
        saved.erase(header);

    ojson normalized = ojson::object();
    for (auto it = input.begin(); it != input.end(); ++it)
        if (is_metadata_key(it.key()) && readable.contains(it.key()))
            normalized[it.key()] = it.value();
    std::vector<std::string> added;
    for (auto it = saved.begin(); it != saved.end(); ++it) {
        normalized[it.key()] = it.value();
        if (named.count(it.key()) == 0)
            added.push_back(it.key());
    }

    ojson substituted = ojson::array();
    for (const ConfigSubstitution &s : substitutions.substitutions)
        substituted.push_back({{"key", s.opt_def ? s.opt_def->opt_key : std::string()},
                               {"value", s.old_value},
                               {"replacement", s.new_value ? s.new_value->serialize() : std::string()}});

    out["config"]      = std::move(normalized);
    out["renamed"]     = renamed;
    out["dropped"]     = dropped;
    out["misplaced"]   = misplaced;
    out["substituted"] = std::move(substituted);
    out["added"]       = added;
    return out;
}

// ---------------------------------------------------------------------------------------------
// Vendor folders
// ---------------------------------------------------------------------------------------------

struct Folder {
    std::string id;
    const json *index = nullptr;
    const json *files = nullptr;
};

bool safe_segment(const std::string &s) { return !s.empty() && s != "." && s != ".." && s.find_first_of("/\\:") == std::string::npos && s.find('\0') == std::string::npos; }

// "machine/Muon3D M1 0.4 nozzle.json": relative, '/'-separated, no empty, "." or ".." segment.
bool safe_relative_path(const std::string &path)
{
    if (path.empty() || path.front() == '/' || path.find('\\') != std::string::npos || path.find(':') != std::string::npos)
        return false;
    size_t start = 0;
    while (true) {
        const size_t end     = path.find('/', start);
        const std::string s  = path.substr(start, end == std::string::npos ? std::string::npos : end - start);
        if (s.empty() || s == "." || s == ".." || s.find('\0') != std::string::npos)
            return false;
        if (end == std::string::npos)
            return true;
        start = end + 1;
    }
}

Folder parse_folder(const json &value, const char *what)
{
    const std::string where = std::string("\"") + what + "\"";
    if (!value.is_object())
        bad_request(where + " must be a profile folder: { id, index, files }.");
    Folder folder;
    if (!value.contains("id") || !value["id"].is_string() || !safe_segment(value["id"].get<std::string>()))
        bad_request(where + ".id must be the vendor's folder name, e.g. \"Muon3D\".");
    folder.id = value["id"].get<std::string>();
    if (!value.contains("index") || !value["index"].is_object())
        bad_request(where + ".index must be the vendor's index file (" + folder.id + ".json) as an object.");
    if (!value.contains("files") || !value["files"].is_object())
        bad_request(where + ".files must map each sub_path of the index to its file's content.");
    folder.index = &value["index"];
    folder.files = &value["files"];
    for (auto it = folder.files->begin(); it != folder.files->end(); ++it) {
        if (!safe_relative_path(it.key()))
            bad_request(where + ".files has an unusable path \"" + it.key() + "\" (relative, '/'-separated, no \"..\").");
        if (!it.value().is_object())
            bad_request(where + ".files[\"" + it.key() + "\"] must be the file's JSON object.");
    }
    return folder;
}

void write_folder(const fs::path &root, const Folder &folder)
{
    write_text_file(root / (folder.id + ".json"), folder.index->dump());
    for (auto it = folder.files->begin(); it != folder.files->end(); ++it)
        write_text_file(root / folder.id / it.key(), it.value().dump());
}

// The folders of a request: the vendor and, unless the vendor is the library itself, the library.
std::vector<Folder> request_folders(const json &request)
{
    std::vector<Folder> folders;
    if (!request.contains("vendor"))
        bad_request("\"vendor\" is missing: the profile folder to load.");
    folders.push_back(parse_folder(request["vendor"], "vendor"));
    if (request.contains("library") && !request["library"].is_null()) {
        Folder library = parse_folder(request["library"], "library");
        if (library.id != PresetBundle::ORCA_FILAMENT_LIBRARY)
            bad_request(std::string("\"library\".id must be ") + PresetBundle::ORCA_FILAMENT_LIBRARY + ".");
        if (folders.front().id != library.id)
            folders.push_back(library);
    }
    return folders;
}

std::vector<std::string> error_lines(const LogCapture &capture, int level)
{
    std::vector<std::string> out;
    for (const LogLine &line : capture.lines())
        if (line.level == level || (level == 1 && line.level == 0))
            out.push_back(line.message);
    return out;
}

// ---------------------------------------------------------------------------------------------
// profiles.resolve
// ---------------------------------------------------------------------------------------------

bool is_vendor_system(const Preset &preset) { return !preset.is_default && preset.is_system && preset.vendor != nullptr; }

std::string resolve(const json &request)
{
    const std::vector<Folder> folders = request_folders(request);
    const std::string         vendor  = folders.front().id;

    // Which presets: all of the vendor's, or the ones named.
    std::map<Preset::Type, std::set<std::string>> wanted;
    const bool                                   all = !request.contains("presets") || request["presets"].is_null();
    if (!all) {
        if (!request["presets"].is_array())
            bad_request("\"presets\" must list { type, name }.");
        for (const json &p : request["presets"]) {
            Preset::Type type;
            if (!p.is_object() || !p.contains("type") || !p["type"].is_string() || !preset_type(p["type"].get<std::string>(), type) ||
                !p.contains("name") || !p["name"].is_string())
                bad_request("\"presets\" must list { type: machine | process | filament, name }.");
            wanted[type].insert(p["name"].get<std::string>());
        }
    }
    bool                  compatibility = false;
    std::set<std::string> compatibility_printers;
    if (request.contains("compatibility")) {
        const json &c = request["compatibility"];
        if (c.is_boolean())
            compatibility = c.get<bool>();
        else if (c.is_array()) {
            compatibility = true;
            for (const json &name : c) {
                if (!name.is_string())
                    bad_request("\"compatibility\" must be true or list printer names.");
                compatibility_printers.insert(name.get<std::string>());
            }
        } else if (!c.is_null())
            bad_request("\"compatibility\" must be true or list printer names.");
    }

    JobDirGuard       job_dir(make_job_dir("profiles"));
    const fs::path    root(job_dir.path());
    for (const Folder &folder : folders)
        write_folder(root / PRESET_SYSTEM_DIR, folder);
    fs::create_directories(root / PRESET_USER_DIR / DEFAULT_USER_FOLDER_NAME);

    DataDirScope data_dir_scope(root.string());
    LogCapture   capture(1);
    PresetBundle bundle;
    AppConfig    app_config;
    app_config.set("preset_folder", DEFAULT_USER_FOLDER_NAME);
    std::string errors;
    // The desktop app's load (GUI_App: EnableSystemSilent); read_only: no vendor caches are written.
    bundle.load_presets(app_config, ForwardCompatibilitySubstitutionRule::EnableSystemSilent, PresetBundle::PresetPreferences(), &errors, true);

    std::string out = "{\"presets\":[";
    bool        first = true;
    std::map<Preset::Type, std::set<std::string>> found;
    auto collect = [&](PresetCollection &collection) {
        const Preset::Type type = collection.type();
        for (const Preset &preset : collection.get_presets()) {
            if (!is_vendor_system(preset))
                continue;
            if (all ? preset.vendor->id != vendor : wanted[type].count(preset.name) == 0)
                continue;
            found[type].insert(preset.name);
            std::ostringstream config;
            preset.config.save_to_json(config, preset.name, "system", preset.version.to_string());
            json entry = {{"type", type_name(type)},     {"name", preset.name},
                          {"vendor", preset.vendor->id}, {"alias", preset.alias},
                          {"renamedFrom", preset.renamed_from}, {"settingId", preset.setting_id}};
            if (type == Preset::TYPE_FILAMENT)
                entry["filamentId"] = preset.filament_id;
            std::string text = entry.dump();
            text.pop_back(); // '}'
            std::string config_text = config.str();
            while (!config_text.empty() && (config_text.back() == '\n' || config_text.back() == '\r'))
                config_text.pop_back();
            out += (first ? "" : ",") + text + ",\"config\":" + config_text + "}";
            first = false;
        }
    };
    collect(bundle.printers);
    collect(bundle.prints);
    collect(bundle.filaments);
    out += "]";

    json missing = json::array();
    for (const auto &[type, names] : wanted)
        for (const std::string &name : names)
            if (found[type].count(name) == 0)
                missing.push_back({{"type", type_name(type)}, {"name", name}});
    out += ",\"missing\":" + missing.dump();

    if (compatibility) {
        std::vector<const Preset *> printers;
        for (const Preset &printer : bundle.printers.get_presets())
            if (is_vendor_system(printer) && printer.vendor->id == vendor &&
                (compatibility_printers.empty() || compatibility_printers.count(printer.name) != 0))
                printers.push_back(&printer);
        json list = json::array();
        for (const Preset *printer : printers) {
            const PresetWithVendorProfile active = bundle.printers.get_preset_with_vendor_profile(*printer);
            json processes = json::array(), filaments = json::array();
            for (const Preset &p : bundle.prints.get_presets())
                if (is_vendor_system(p) && is_compatible_with_printer(bundle.prints.get_preset_with_vendor_profile(p), active))
                    processes.push_back(p.name);
            for (const Preset &f : bundle.filaments.get_presets())
                if (is_vendor_system(f) && is_compatible_with_printer(bundle.filaments.get_preset_with_vendor_profile(f), active))
                    filaments.push_back(f.name);
            list.push_back({{"printer", printer->name}, {"processes", processes}, {"filaments", filaments}});
        }
        out += ",\"compatibility\":" + list.dump();

        // Filaments limited to some processes (compatible_prints, compatible_prints_condition), which
        // Orca checks against the selected process on top of the printer check.
        json restricted = json::array();
        if (!printers.empty()) {
            const PresetWithVendorProfile active = bundle.printers.get_preset_with_vendor_profile(*printers.front());
            for (const Preset &f : bundle.filaments.get_presets()) {
                if (!is_vendor_system(f))
                    continue;
                const auto *prints    = f.config.option<ConfigOptionStrings>("compatible_prints");
                const auto *condition = f.config.option<ConfigOptionString>("compatible_prints_condition");
                if ((prints == nullptr || prints->values.empty()) && (condition == nullptr || condition->value.empty()))
                    continue;
                json processes = json::array();
                const PresetWithVendorProfile filament = bundle.filaments.get_preset_with_vendor_profile(f);
                for (const Preset &p : bundle.prints.get_presets())
                    if (is_vendor_system(p) && is_compatible_with_print(filament, bundle.prints.get_preset_with_vendor_profile(p), active))
                        processes.push_back(p.name);
                restricted.push_back({{"filament", f.name}, {"processes", processes}});
            }
        }
        out += ",\"printRestricted\":" + restricted.dump();
    }

    // The root every chain starts from: each type's default preset (for printers, the FFF one).
    auto default_text = [](const Preset &preset) {
        std::ostringstream text;
        preset.config.save_to_json(text, preset.name, "default", std::string());
        std::string t = text.str();
        while (!t.empty() && std::isspace(static_cast<unsigned char>(t.back())))
            t.pop_back();
        return t;
    };
    out += ",\"defaults\":{\"machine\":" + default_text(bundle.printers.default_preset()) + ",\"process\":" +
           default_text(bundle.prints.default_preset()) + ",\"filament\":" + default_text(bundle.filaments.default_preset()) + "}";

    json error_list = error_lines(capture, 1);
    if (!errors.empty() && error_list.empty())
        error_list.push_back(errors);
    out += ",\"errors\":" + error_list.dump() + "}";
    return out;
}

// ---------------------------------------------------------------------------------------------
// profiles.validate
// ---------------------------------------------------------------------------------------------

std::string validate(const json &request)
{
    if (!request.contains("vendors") || !request["vendors"].is_array() || request["vendors"].empty())
        bad_request("profiles.validate needs { vendors: [profile folders] }: every vendor to load, the filament library among them.");
    std::vector<Folder> folders;
    std::set<std::string> ids;
    for (const json &value : request["vendors"]) {
        folders.push_back(parse_folder(value, "vendors[]"));
        if (!ids.insert(folders.back().id).second)
            bad_request("\"vendors\" lists " + folders.back().id + " twice.");
    }
    std::string only;
    if (request.contains("vendor") && !request["vendor"].is_null()) {
        if (!request["vendor"].is_string() || ids.count(request["vendor"].get<std::string>()) == 0)
            bad_request("\"vendor\" must name one of \"vendors\" (the vendor to validate; absent: all).");
        only = request["vendor"].get<std::string>();
    }
    bool check_subtypes = true;
    if (request.contains("checkFilamentSubtypes")) {
        if (!request["checkFilamentSubtypes"].is_boolean())
            bad_request("\"checkFilamentSubtypes\" must be true or false.");
        check_subtypes = request["checkFilamentSubtypes"].get<bool>();
    }

    JobDirGuard    job_dir(make_job_dir("validate"));
    const fs::path root(job_dir.path());
    // Validation mode reads the vendors from data_dir() itself (OrcaSlicer_profile_validator -p).
    for (const Folder &folder : folders)
        write_folder(root, folder);
    fs::create_directories(root / PRESET_USER_DIR / DEFAULT_USER_FOLDER_NAME);

    DataDirScope data_dir_scope(root.string());
    LogCapture   capture(2);
    PresetBundle bundle;
    bundle.set_is_validation_mode(true);
    bundle.set_vendor_to_validate(only);
    bundle.set_default_suppressed(true);
    AppConfig app_config;
    app_config.set("preset_folder", DEFAULT_USER_FOLDER_NAME);

    bool        ok = true;
    std::string failure;
    try {
        bundle.load_presets(app_config, ForwardCompatibilitySubstitutionRule::Disable);
    } catch (const std::bad_alloc &) {
        throw;
    } catch (const std::exception &ex) {
        ok      = false;
        failure = ex.what();
    }
    if (ok && bundle.has_errors(check_subtypes))
        ok = false;

    json counts = json::object();
    for (const PresetCollection *collection : {static_cast<const PresetCollection *>(&bundle.printers), static_cast<const PresetCollection *>(&bundle.prints),
                                              static_cast<const PresetCollection *>(&bundle.filaments)})
        for (const Preset &preset : collection->get_presets())
            if (is_vendor_system(preset)) {
                json &c = counts[preset.vendor->id];
                if (c.is_null())
                    c = {{"machine", 0}, {"process", 0}, {"filament", 0}};
                c[type_name(collection->type())] = c[type_name(collection->type())].get<int>() + 1;
            }
    json errors = error_lines(capture, 1);
    if (!failure.empty())
        errors.push_back(failure);
    json out = {{"ok", ok}, {"errors", errors}, {"warnings", error_lines(capture, 2)}, {"counts", counts}};
    return out.dump();
}

} // namespace

std::string profiles_normalize(const std::string &request_text)
{
    const json request = parse_request(request_text, "profiles.normalize");
    if (!request.contains("presets") || !request["presets"].is_array())
        bad_request("profiles.normalize needs { presets: [{ type, config }] }.");
    JobDirGuard job_dir(make_job_dir("normalize"));
    ojson       results = ojson::array();
    // A log line per unreadable value would only repeat what the report says.
    LogCapture quiet(0, 0);
    for (const json &item : request["presets"])
        results.push_back(normalize_one(item, job_dir.path()));
    ojson out;
    out["presets"] = std::move(results);
    return out.dump();
}

std::string profiles_resolve(const std::string &request_text) { return resolve(parse_request(request_text, "profiles.resolve")); }

std::string profiles_validate(const std::string &request_text) { return validate(parse_request(request_text, "profiles.validate")); }

} // namespace muon
