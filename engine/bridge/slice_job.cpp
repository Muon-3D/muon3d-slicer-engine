// The plate half of OrcaSlicer's CLI::run ("OS:<line>" = src/OrcaSlicer.cpp on muon3d-wasm), for
// the one plate the web app sends, with objects already placed (the CLI's --arrange 0). The CLI
// gets its Print from the GUI class PartPlate; for plate 1 that amounts to a plain Print with plate
// origin (0,0,0), plate index 0, a plate config of {filament_map_mode = AutoForFlush} and the
// printable area as plate shape (engine/research/headless-entry.md §1.1 step 21), set up below.
//
// Deliberately not ported, with the reason:
//  * the wipe-tower position clamp (OS:6262-6285): objects are never added to the CLI's PartPlate
//    on this path, so its tower estimate is empty and the clamp never changes anything;
//  * --mtcpp/--mstpp limits, skip lists, cached slice data, 3MF export: options the engine never
//    passes;
//  * the manual filament-map branch of the multi-extruder pre-check (OS:6532-6674): the CLI's
//    plate config pins filament_map_mode to AutoForFlush, so only the auto branch can run.
#include "slice_job.hpp"

#include "cli_config.hpp"
#include "model_input.hpp"
#include "toolpaths.hpp"

#include <libslic3r/libslic3r.h>
#include <libslic3r/BuildVolume.hpp>
#include <libslic3r/Exception.hpp>
#include <libslic3r/GCode/GCodeProcessor.hpp>
#include <libslic3r/Layer.hpp>
#include <libslic3r/Model.hpp>
#include <libslic3r/Print.hpp>
#include <libslic3r/PrintConfig.hpp>
#include <libslic3r/Utils.hpp>

#include <boost/filesystem.hpp>

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <iterator>
#include <mutex>
#include <set>

using namespace Slic3r;

namespace muon {
namespace {

using Clock = std::chrono::steady_clock;

double ms_between(Clock::time_point from, Clock::time_point to) { return std::chrono::duration<double, std::milli>(to - from).count(); }

[[noreturn]] void fail(int code, std::string message, std::vector<std::string> objects = {})
{
    throw JobFailure(code, std::move(message), std::move(objects));
}

// Progress the UI sees: 1-3 % preparing, Orca's own 5-80 % while slicing, 80-97 % while the
// G-code is generated (interpolated per layer), 98-99 % while the results are collected.
constexpr int PROGRESS_GCODE_START = 80;
constexpr int PROGRESS_GCODE_END   = 97;

const char *print_step_name(int step)
{
    switch (step) {
    case psWipeTower: return "wipe_tower";
    case psSkirtBrim: return "skirt_brim";
    case psGCodeExport: return "gcode_export";
    case psConflictCheck: return "conflict_check";
    default: return "print";
    }
}

const char *print_object_step_name(int step)
{
    switch (step) {
    case posSlice: return "slice";
    case posPerimeters: return "perimeters";
    case posEstimateCurledExtrusions: return "estimate_curled_extrusions";
    case posPrepareInfill: return "prepare_infill";
    case posInfill: return "infill";
    case posIroning: return "ironing";
    case posContouring: return "contouring";
    case posSupportMaterial: return "support_material";
    case posSimplifyPath: return "simplify_path";
    case posSimplifySupportPath: return "simplify_support_path";
    case posDetectOverhangsForLift: return "detect_overhangs_for_lift";
    case posSimplifyWall: return "simplify_wall";
    case posSimplifyInfill: return "simplify_infill";
    default: return "object";
    }
}

// Stable class of a warning status: the notification type when Orca gives one, else the step.
std::string warning_kind(const PrintBase::SlicingStatus &status)
{
    switch (status.message_type) {
    case PrintStateBase::SlicingExclusionVolumeToolpath: return "exclusion_volume_path";
    case PrintStateBase::SlicingNeedSupportOn: return "need_support_on";
    case PrintStateBase::SlicingEmptyGcodeLayers: return "empty_gcode_layers";
    case PrintStateBase::SlicingGcodeOverlap: return "gcode_overlap";
    case PrintStateBase::SlicingReplaceInitEmptyLayers: return "replace_init_empty_layers";
    default: break;
    }
    if (status.flags & PrintBase::SlicingStatus::UPDATE_PRINT_OBJECT_STEP_WARNINGS)
        return print_object_step_name(status.warning_step);
    return print_step_name(status.warning_step);
}

// src/slic3r/GUI/Plater.cpp:8045-8062 (Plater::get_slice_warning_string): the text the GUI shows
// for GCodeProcessorResult::warnings; empty means the GUI shows nothing.
std::string processor_warning_text(const GCodeProcessorResult::SliceWarning &warning)
{
    if (warning.msg == BED_TEMP_TOO_HIGH_THAN_FILAMENT)
        return "The current heatbed temperature is relatively high. The nozzle may clog when printing this filament in a closed "
               "environment. Please open the front door and/or remove the upper glass.";
    if (warning.msg == NOZZLE_HRC_CHECKER)
        return "The nozzle hardness required by the filament is higher than the default nozzle hardness of the printer. Please "
               "replace the hardened nozzle or filament, otherwise, the nozzle will be worn down or damaged.";
    if (warning.msg == NOT_SUPPORT_TRADITIONAL_TIMELAPSE)
        return "Enabling traditional timelapse photography may cause surface imperfections. It is recommended to change to smooth mode.";
    if (warning.msg == NOT_GENERATE_TIMELAPSE)
        return {};
    if (warning.msg == SMOOTH_TIMELAPSE_WITHOUT_PRIME_TOWER)
        return "Smooth mode for timelapse is enabled, but the prime tower is off, which may cause print defects. Please enable the "
               "prime tower, re-slice and print again.";
    return warning.msg;
}

// Number of layers GCode::process_layers will emit (one per distinct print Z, per object when
// printing object by object), to turn "Generating G-code: layer N" into a percentage.
size_t count_gcode_layers(const Print &print)
{
    const bool by_object = print.config().print_sequence == PrintSequence::ByObject;
    size_t     total     = 0;
    std::vector<coordf_t> zs;
    for (const PrintObject *object : print.objects()) {
        if (by_object)
            zs.clear();
        for (const Layer *layer : object->layers())
            zs.push_back(layer->print_z);
        for (const SupportLayer *layer : object->support_layers())
            zs.push_back(layer->print_z);
        if (by_object) {
            std::sort(zs.begin(), zs.end());
            total += size_t(std::distance(zs.begin(), std::unique(zs.begin(), zs.end(), [](coordf_t a, coordf_t b) { return std::abs(a - b) < EPSILON; })));
        }
    }
    if (!by_object) {
        std::sort(zs.begin(), zs.end());
        total = size_t(std::distance(zs.begin(), std::unique(zs.begin(), zs.end(), [](coordf_t a, coordf_t b) { return std::abs(a - b) < EPSILON; })));
    }
    return total;
}

// Print's status callback target (the CLI's default_status_callback, OS:403). Keeps the progress
// monotonic, turns warning statuses into EngineWarnings (de-duplicated, with the object named),
// remembers the warnings the CLI inspects after Print::process, and forwards cancellation.
// Orca calls it from TBB worker threads too, hence the mutex.
class StatusSink {
public:
    StatusSink(JobReporter &reporter, Print &print) : m_reporter(reporter), m_print(print) {}

    void on_status(const PrintBase::SlicingStatus &status)
    {
        if (m_reporter.cancel_requested())
            m_print.cancel();

        if (status.warning_step != -1) {
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                m_process_warnings.push_back(status);
            }
            // set_done() clears stale warnings with an empty text (PrintBase.hpp:604).
            if (status.text.empty())
                return;
            EngineWarning warning{warning_kind(status), status.text, {}};
            if (status.flags & PrintBase::SlicingStatus::UPDATE_PRINT_OBJECT_STEP_WARNINGS)
                if (std::string name = print_object_name(m_print, status.warning_object_id.id); !name.empty())
                    warning.objects.push_back(std::move(name));
            add_warning(std::move(warning));
            return;
        }
        if (status.percent < 0)
            return;

        int percent = status.percent;
        static const std::string gcode_layer_prefix = "Generating G-code: layer ";
        if (status.text.compare(0, gcode_layer_prefix.size(), gcode_layer_prefix) == 0) {
            const size_t layers = m_gcode_layers.load();
            const long   layer  = std::strtol(status.text.c_str() + gcode_layer_prefix.size(), nullptr, 10);
            if (layers > 0 && layer > 0)
                percent = PROGRESS_GCODE_START +
                          int((PROGRESS_GCODE_END - PROGRESS_GCODE_START) * std::min<size_t>(size_t(layer), layers) / layers);
        }
        progress(std::clamp(percent, 4, PROGRESS_GCODE_END), status.text);
    }

    void progress(int percent, const std::string &message)
    {
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            percent   = std::max(percent, m_percent);
            m_percent = percent;
        }
        m_reporter.progress(percent, message);
    }

    void add_warning(EngineWarning warning)
    {
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            if (!m_seen.emplace(warning.kind, warning.message).second)
                return;
            m_warnings.push_back(warning);
        }
        m_reporter.warning(warning);
    }

    void set_gcode_layers(size_t layers) { m_gcode_layers = layers; }

    // Warning statuses since the last call (the CLI's g_slicing_warnings, cleared after its check).
    std::vector<PrintBase::SlicingStatus> take_process_warnings()
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        return std::exchange(m_process_warnings, {});
    }

    std::vector<EngineWarning> warnings()
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        return m_warnings;
    }

private:
    JobReporter                                    &m_reporter;
    Print                                          &m_print;
    std::mutex                                      m_mutex;
    int                                             m_percent = 0;
    std::atomic<size_t>                             m_gcode_layers{0};
    std::vector<PrintBase::SlicingStatus>           m_process_warnings;
    std::vector<EngineWarning>                      m_warnings;
    std::set<std::pair<std::string, std::string>>   m_seen;
};

// OS:6781-6803: validate() error type -> CLI exit code.
int validation_exit_code(StringExceptionType type)
{
    switch (type) {
    case STRING_EXCEPT_FILAMENT_NOT_MATCH_BED_TYPE: return CLI_FILAMENT_NOT_MATCH_BED_TYPE;
    case STRING_EXCEPT_FILAMENTS_DIFFERENT_TEMP: return CLI_FILAMENTS_DIFFERENT_TEMP;
    case STRING_EXCEPT_OBJECT_COLLISION_IN_SEQ_PRINT: return CLI_OBJECT_COLLISION_IN_SEQ_PRINT;
    case STRING_EXCEPT_OBJECT_COLLISION_IN_LAYER_PRINT: return CLI_OBJECT_COLLISION_IN_LAYER_PRINT;
    default: return CLI_VALIDATE_ERROR;
    }
}

// The first setting Orca cannot write back as text. A preset value such as "1e400" loads as
// infinity, and ConfigOptionFloats::serialize throws "Serializing invalid number", naming nothing,
// only when the G-code's config block is written at the end of the export (-100, as in the CLI).
std::string unserializable_setting(const DynamicPrintConfig &config)
{
    for (const std::string &key : config.keys()) {
        try {
            if (const ConfigOption *option = config.option(key))
                option->serialize();
        } catch (const std::exception &) {
            return key;
        }
    }
    return {};
}

std::vector<std::string> names_of(const ObjectBase *object)
{
    std::string name = object_name(object);
    return name.empty() ? std::vector<std::string>{} : std::vector<std::string>{std::move(name)};
}

// OS:6340-6680 for pre-placed objects: partly outside objects fail the plate (-52), and on a
// multi-extruder printer a single-filament object that no extruder can reach fails it too (-66).
// Fully outside objects are skipped silently by the CLI; the engine says so in a warning.
void pre_check(Model &model, const BuildVolume &build_volume, int extruder_count, StatusSink &sink)
{
    std::vector<std::string>   partly_outside, fully_outside;
    std::vector<std::set<int>> unprintable_filament_ids(size_t(std::max(extruder_count, 1)));
    for (ModelObject *model_object : model.objects) {
        for (ModelInstance *instance : model_object->instances) {
            instance->use_loaded_id_for_label = true;
            if (instance->print_volume_state == ModelInstancePVS_Partly_Outside) {
                partly_outside.push_back(model_object->name);
                continue;
            }
            if (instance->print_volume_state == ModelInstancePVS_Fully_Outside) {
                fully_outside.push_back(model_object->name);
                continue;
            }
            if (instance->print_volume_state != ModelInstancePVS_Inside || extruder_count <= 1)
                continue;
            const Transform3d &inst_matrix = instance->get_transformation().get_matrix();
            std::set<int>      object_filaments;
            for (const ModelVolume *vol : model_object->volumes) {
                std::vector<int> filaments = vol->get_extruders();
                object_filaments.insert(filaments.begin(), filaments.end());
            }
            for (const ModelVolume *vol : model_object->volumes) {
                if (!vol->is_model_part())
                    continue;
                BoundingBoxf3     bbox = vol->get_convex_hull().transformed_bounding_box(inst_matrix * vol->get_matrix());
                std::vector<bool> inside_extruders;
                if (build_volume.check_volume_bbox_state_with_extruder_areas(bbox, inside_extruders) == BuildVolume::ObjectState::Limited &&
                    object_filaments.size() == 1) {
                    for (size_t j = 0; j < inside_extruders.size() && j < unprintable_filament_ids.size(); ++j)
                        if (!inside_extruders[j]) {
                            std::vector<int> filaments = vol->get_extruders();
                            unprintable_filament_ids[j].insert(filaments.begin(), filaments.end());
                        }
                }
            }
        }
    }
    if (!partly_outside.empty())
        fail(CLI_OBJECTS_PARTLY_INSIDE, "Some objects are located over the boundary of the heated bed.", partly_outside);

    // OS:6500-6530, auto filament mapping: a filament no extruder can print.
    if (extruder_count > 1) {
        std::vector<int> conflict_filaments;
        for (size_t e = 0; e < unprintable_filament_ids.size(); ++e) {
            if (unprintable_filament_ids[e].empty()) {
                conflict_filaments.clear();
                break;
            }
            std::vector<int> ids(unprintable_filament_ids[e].begin(), unprintable_filament_ids[e].end());
            if (e == 0) {
                conflict_filaments = std::move(ids);
            } else {
                std::vector<int> common;
                std::set_intersection(conflict_filaments.begin(), conflict_filaments.end(), ids.begin(), ids.end(), std::back_inserter(common));
                conflict_filaments = std::move(common);
            }
        }
        if (!conflict_filaments.empty())
            fail(CLI_FILAMENT_CAN_NOT_MAP, "Some filaments cannot be mapped to correct extruders for multi-extruder Printer.");
    }

    for (const std::string &name : fully_outside)
        sink.add_warning({"object_outside", "The object \"" + name + "\" is outside the printable area and was not sliced.", {name}});
}

} // namespace

SliceResult run_slice(SliceRequest request, JobReporter &reporter)
{
    const Clock::time_point started = Clock::now();
    JobDirGuard             job_dir(make_job_dir("slice"));
    SliceResult             out;

    reporter.progress(1, "Loading presets");
    PreparedConfig prepared;
    try {
        prepared = prepare_config(request.machine_json, request.process_json, request.filament_jsons, job_dir.path());
    } catch (const JobFailure &) {
        throw;
    } catch (const std::bad_alloc &) {
        throw;
    } catch (const std::exception &ex) {
        // e.g. ConfigurationError from a value Orca cannot deserialise; the CLI reports those as -5.
        fail(CLI_CONFIG_FILE_ERROR, std::string("The presets could not be combined: ") + ex.what());
    }
    DynamicPrintConfig &m_print_config = prepared.print_config;

    reporter.progress(2, "Loading objects");
    Model model;
    boost::filesystem::create_directories(job_dir.path() + "/in");
    size_t label_id = 0;
    for (size_t i = 0; i < request.objects.size(); ++i) {
        ModelObject *object = load_object(model, request.objects[i], job_dir.path() + "/in/" + std::to_string(i + 1) + ".stl");
        std::vector<float>().swap(request.objects[i].positions); // the Model has its own copy now
        // Bambu Lab G-code names objects by ModelInstance::get_labeled_id() ("; model label id:",
        // M624 skip-object ids). pre_check sets use_loaded_id_for_label as the CLI does (OS:6348),
        // but an STL has no loaded_id, so the label would be the process-wide ObjectID: new values
        // for every job in a long-lived engine. Number the instances 1..n, as a 3MF would.
        for (ModelInstance *instance : object->instances)
            instance->loaded_id = ++label_id;
    }

    // ---- The plate (PartPlateList::init / PartPlate::set_print / set_index / init, PP:195,3115,3328).
    Print print;
    print.set_plate_origin(Vec3d::Zero());
    print.set_plate_index(0);
    DynamicPrintConfig plate_config;
    plate_config.option<ConfigOptionEnum<FilamentMapMode>>("filament_map_mode", true)->value = fmmAutoForFlush;

    StatusSink sink(reporter, print);
    sink.progress(3, "Checking the plate");

    // ---- OS:6331-6339
    const BuildVolume build_volume = plate_build_volume(m_print_config);
    if (model.update_print_volume_state(build_volume) == 0) {
        std::vector<std::string> names;
        for (const ModelObject *object : model.objects)
            names.push_back(object->name);
        fail(CLI_NO_SUITABLE_OBJECTS, "Nothing to be sliced: the plate is empty or no object is fully inside the printable area.", names);
    }
    pre_check(model, build_volume, prepared.extruder_count, sink);

    // ---- OS:6688-6749: this plate's print config.
    const int          new_extruder_count = prepared.extruder_count;
    const int          filament_count     = prepared.filament_count;
    DynamicPrintConfig new_print_config   = m_print_config;
    new_print_config.apply(plate_config);
    new_print_config.apply(prepared.extra_config, true);
    if (new_extruder_count > 1) {
        FilamentMapMode map_mode = fmmAutoForFlush;
        if (new_print_config.option<ConfigOptionEnum<FilamentMapMode>>("filament_map_mode"))
            map_mode = new_print_config.option<ConfigOptionEnum<FilamentMapMode>>("filament_map_mode")->value;
        if (map_mode < fmmManual) {
            // set default params for auto map
            std::vector<std::string>                     extruder_ams_count(new_extruder_count, "");
            std::vector<std::vector<DynamicPrintConfig>> extruder_filament_info(new_extruder_count, std::vector<DynamicPrintConfig>());
            int                                          color_count = 0;

            const ConfigOptionStrings *filament_type = dynamic_cast<const ConfigOptionStrings *>(m_print_config.option("filament_type"));
            std::vector<std::string>   types         = filament_type ? filament_type->vserialize() : std::vector<std::string>{"PLA"};

            for (int e_index = 0; e_index < new_extruder_count; e_index++) {
                extruder_ams_count[e_index] = "1#0|4#1";
                for (int color_index = 0; color_index < 4; color_index++) {
                    DynamicPrintConfig       temp_config;
                    std::vector<std::string> temp_colors(1, "#FFFFFFFF");
                    std::vector<std::string> temp_types(1, "PLA");
                    if (filament_type)
                        temp_types[0] = types[color_count % types.size()];

                    temp_config.option<ConfigOptionStrings>("filament_colour", true)->values = temp_colors;
                    temp_config.option<ConfigOptionStrings>("filament_type", true)->values   = temp_types;
                    temp_config.option<ConfigOptionBools>("filament_is_support", true)->values = {0};
                    extruder_filament_info[e_index].push_back(std::move(temp_config));
                    color_count++;
                }
            }
            new_print_config.option<ConfigOptionStrings>("extruder_ams_count", true)->values = extruder_ams_count;
            print.set_extruder_filament_info(extruder_filament_info);
        }
    }

    // set filament_map
    std::vector<int> &final_filament_maps = new_print_config.option<ConfigOptionInts>("filament_map", true)->values;
    if (int(final_filament_maps.size()) < filament_count)
        final_filament_maps.resize(filament_count, 1);
    if (new_extruder_count == 1) {
        for (int index = 0; index < filament_count; index++)
            final_filament_maps[index] = 1;
    }
    if (!new_print_config.has("nozzle_volume_type")) {
        // set default nozzle_volume_type
        ConfigOptionEnumsGeneric *final_nozzle_volume_type_opt = new_print_config.option<ConfigOptionEnumsGeneric>("nozzle_volume_type", true);
        final_nozzle_volume_type_opt->values.resize(new_extruder_count, nvtStandard);
    }

    // ---- OS:6750-6816: apply and validate.
    print.apply(model, new_print_config);
    // PrintObject::m_id (Print.hpp) has no initialiser and only GCode::set_object_info assigns it,
    // for Klipper/Marlin/RRF with exclude_object; "; printing object <name> id:<n>" prints it for
    // every printer (heap garbage in a long-lived engine). Assign what set_object_info would.
    for (size_t i = 0; i < print.objects().size(); ++i)
        print.get_object(i)->set_id(i);
    print.set_no_check_flag(false);
    print.is_BBL_printer() = is_bbl_printer(new_print_config, prepared.printer_name);

    std::vector<StringObjectException> validation_warnings;
    print.set_check_multi_filaments_compatibility(true); // !allow_mix_temp
    const StringObjectException err = print.validate(&validation_warnings);
    if (!err.string.empty())
        fail(validation_exit_code(err.type), err.string, names_of(err.object));
    for (const StringObjectException &warning : validation_warnings)
        if (!warning.string.empty())
            sink.add_warning({"validation", warning.string, names_of(warning.object)});

    if (print.empty())
        fail(CLI_NO_SUITABLE_OBJECTS, "Nothing to be sliced: no object is fully inside the printable area.");

    print.set_status_callback([&sink](const PrintBase::SlicingStatus &status) { sink.on_status(status); });

    // OS:6853-6856: static tables the brim generator reads (Brim.cpp); from the plate-less config.
    Model::setExtruderParams(m_print_config, filament_count);
    Model::setPrintSpeedTable(m_print_config, print.config());

    const Clock::time_point loaded = Clock::now();
    out.timings.load_ms            = ms_between(started, loaded);

    GCodeProcessorResult gcode_result;
    try {
        print.process(); // OS:6878
        const Clock::time_point sliced = Clock::now();
        out.timings.slice_ms           = ms_between(loaded, sliced);

        // OS:6898-6902
        if (!print.get_conflict_string().empty()) {
            std::vector<std::string> objects;
            if (const ConflictResultOpt conflict = print.get_conflict_result()) {
                for (const std::string &name : {conflict->_objName1, conflict->_objName2})
                    if (!name.empty())
                        objects.push_back(name);
            }
            fail(CLI_GCODE_PATH_CONFLICTS, print.get_conflict_string(), objects);
        }

        // OS:6906-6939: warnings raised while slicing. Critical empty-layer and overlap warnings
        // fail the plate; everything else is only reported (no --strict). Warnings raised during
        // the export below never change the outcome, as in the CLI.
        for (const PrintBase::SlicingStatus &status : sink.take_process_warnings()) {
            if (status.warning_step == -1 || status.message_type == PrintStateBase::SlicingDefaultNotification)
                continue;
            if (status.warning_level == PrintStateBase::WarningLevel::CRITICAL &&
                (status.message_type == PrintStateBase::SlicingEmptyGcodeLayers || status.message_type == PrintStateBase::SlicingGcodeOverlap)) {
                std::vector<std::string> objects;
                if (status.flags & PrintBase::SlicingStatus::UPDATE_PRINT_OBJECT_STEP_WARNINGS)
                    if (std::string name = print_object_name(print, status.warning_object_id.id); !name.empty())
                        objects.push_back(std::move(name));
                fail(CLI_SLICING_ERROR, status.text, objects);
            }
        }

        // OS:6941-6957. A fresh job directory per job: GCode::do_export returns early, without
        // filling the result, when the output file already exists.
        sink.set_gcode_layers(count_gcode_layers(print));
        const std::string out_dir = job_dir.path() + "/out";
        boost::filesystem::create_directories(out_dir);
        const std::string gcode_path = print.export_gcode(out_dir + "/plate_1.gcode", &gcode_result, nullptr);

        // OS:6960-6970
        if (gcode_result.gcode_check_result.error_code)
            fail(CLI_GCODE_PATH_IN_UNPRINTABLE_AREA, "Found G-code in unprintable area of multi-extruder printers after slicing.");

        sink.progress(98, "Collecting results");
        // The processor's own checks (nozzle hardness, bed temperature, timelapse). The CLI never
        // reports them and the GUI shows them only when sending to a Bambu Lab printer
        // (SelectMachine.cpp); for other printers they can be plain wrong (Orca rates a brass
        // nozzle below the hardness its generic PLA asks for), so they are reported the same way.
        if (print.is_BBL_printer())
            for (const GCodeProcessorResult::SliceWarning &warning : gcode_result.warnings)
                if (std::string text = processor_warning_text(warning); !text.empty())
                    sink.add_warning({warning.msg, std::move(text), {}});

        out.stats = build_stats(gcode_result, print);
        if (request.want_toolpaths) {
            sink.progress(99, "Preparing the preview");
            out.toolpaths = build_toolpaths(gcode_result);
        }
        out.gcode_path       = gcode_path;
        out.timings.export_ms = ms_between(sliced, Clock::now());
    } catch (const JobFailure &) {
        throw;
    } catch (const CanceledException &) {
        fail(ENGINE_CANCELLED, "Slicing was cancelled.");
    } catch (const std::bad_alloc &) {
        throw;
    } catch (const SlicingErrors &ex) {
        // OS:7028-7034: any exception while slicing or exporting is -100.
        std::string              message;
        std::vector<std::string> objects;
        for (const SlicingError &error : ex.errors_) {
            message += (message.empty() ? "" : "\n") + std::string(error.what());
            if (std::string name = print_object_name(print, error.objectId()); !name.empty())
                objects.push_back(std::move(name));
        }
        fail(CLI_SLICING_ERROR, message.empty() ? ex.what() : message, objects);
    } catch (const SlicingError &ex) {
        std::vector<std::string> objects;
        if (std::string name = print_object_name(print, ex.objectId()); !name.empty())
            objects.push_back(std::move(name));
        fail(CLI_SLICING_ERROR, ex.what(), objects);
    } catch (const std::exception &ex) {
        std::string message = ex.what();
        if (message.rfind("Serializing ", 0) == 0) // "Serializing invalid number", "Serializing NaN"
            if (const std::string key = unserializable_setting(print.full_print_config()); !key.empty())
                message = "The setting \"" + key + "\" has a value that is not a valid number (" + message + ").";
        fail(CLI_SLICING_ERROR, message);
    }

    out.warnings        = sink.warnings();
    out.timings.total_ms = ms_between(started, Clock::now());
    out.job_dir         = job_dir.release();
    return out;
}

} // namespace muon
