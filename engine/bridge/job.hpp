// Plain data exchanged between the embind glue (engine.cpp) and the slicing core (cli_config,
// slice_job, toolpaths, placement). Nothing here depends on Emscripten, so the core can also be
// compiled natively for debugging.
//
// The shapes mirror packages/protocol/src/v1.ts (EngineError, EngineWarning, SliceOutput, CheckOutput).
#pragma once

#include <cstdint>
#include <exception>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace muon {

// Engine-level error codes (protocol.ts EngineError.code); Orca's own codes are the negative CLI_*
// values from libslic3r/Utils.hpp.
constexpr int ENGINE_INTERNAL_ERROR = 1;
constexpr int ENGINE_OUT_OF_MEMORY  = 2;
constexpr int ENGINE_CANCELLED      = 3;

struct EngineError {
    int                      code = 0;
    std::string              message;
    std::vector<std::string> objects;
};

struct EngineWarning {
    std::string              kind;
    std::string              message;
    std::vector<std::string> objects;
};

// Thrown by the core to end a job with an error; engine.cpp turns it into a 'failed' response.
class JobFailure : public std::exception {
public:
    explicit JobFailure(EngineError error) : m_error(std::move(error)) {}
    JobFailure(int code, std::string message, std::vector<std::string> objects = {})
        : m_error{code, std::move(message), std::move(objects)} {}
    const char        *what() const noexcept override { return m_error.message.c_str(); }
    const EngineError &error() const { return m_error; }

private:
    EngineError m_error;
};

// One plate object: a triangle soup (9 floats per triangle) already in bed coordinates, and its
// per-object settings (protocol.ts EngineObject.config): Orca option name -> value text, in the
// order given, applied to the ModelObject's config as Orca's 3MF loader does.
struct MeshInput {
    std::string                                      name;
    std::vector<float>                               positions;
    std::vector<std::pair<std::string, std::string>> config;
};

// Receives progress and warnings while a job runs. Implementations must be thread-safe: in the
// multi-threaded build Orca reports some progress (G-code generation, tree supports) from TBB
// worker threads.
class JobReporter {
public:
    virtual ~JobReporter() = default;
    virtual void progress(int percent, const std::string &message) = 0;
    virtual void warning(const EngineWarning &warning) = 0;
    // Polled from Orca's status callback; true makes the running Print cancel itself.
    virtual bool cancel_requested() { return false; }
};

// GcodeStats (packages/protocol/src/v1.ts). Absent values are std::nullopt (null in JS).
struct GcodeStats {
    std::optional<double>      print_time_seconds;
    std::optional<std::string> print_time_text;
    std::optional<std::string> first_layer_time_text;
    std::optional<double>      filament_mm;
    std::optional<double>      filament_cm3;
    std::optional<double>      filament_g;
    std::optional<double>      filament_cost;
    std::optional<double>      layers;
    std::optional<double>      max_z;
};

// Toolpaths plus ToolpathExtras (packages/protocol/src/v1.ts), as flat arrays.
struct ToolpathData {
    std::vector<std::string> roles;        // first-seen order, Orca's ';TYPE:' names
    std::vector<double>      role_length;  // mm extruded per role, parallel to `roles`
    std::vector<float>       layer_z;      // one per layer

    std::vector<float>    extrusion_positions;    // 6 floats per segment
    std::vector<uint32_t> extrusion_layer_start;  // layer count + 1
    std::vector<uint8_t>  extrusion_role;         // index into `roles`
    std::vector<uint8_t>  extrusion_width;        // size codes (parse.ts sizeCode), 0 = unknown
    std::vector<uint8_t>  extrusion_height;       // size codes, 0 = unknown

    std::vector<float>    travel_positions;
    std::vector<uint32_t> travel_layer_start;

    std::optional<double> line_width;  // dominant width in mm
    bool                  has_bounds = false;
    float                 bounds_min[3] = {0, 0, 0};
    float                 bounds_max[3] = {0, 0, 0};

    // ToolpathExtras, parallel to the extrusion segments.
    std::vector<float>    feedrate;     // mm/s
    std::vector<uint8_t>  fan_speed;    // 0-100 %
    std::vector<uint16_t> temperature;  // degrees C
    std::vector<float>    time;         // s from print start at the end of the segment
    std::vector<float>    height;       // mm

    size_t extrusion_count() const { return extrusion_role.size(); }
    size_t travel_count() const { return travel_positions.size() / 6; }
    size_t layer_count() const { return layer_z.size(); }
};

struct SliceTimings {
    double load_ms   = 0;
    double slice_ms  = 0;
    double export_ms = 0;
    double total_ms  = 0;
};

struct SliceRequest {
    std::string              machine_json;
    std::string              process_json;
    std::vector<std::string> filament_jsons;
    std::vector<MeshInput>   objects;
    bool                     want_toolpaths = true;
};

struct SliceResult {
    // The finished G-code, still in the virtual file system; the caller reads it and then
    // removes the job directory with remove_job_dir().
    std::string                 gcode_path;
    std::string                 job_dir;
    GcodeStats                  stats;
    std::optional<ToolpathData> toolpaths;
    std::vector<EngineWarning>  warnings;
    SliceTimings                timings;
};

struct CheckRequest {
    std::string              machine_json;
    std::string              process_json;
    std::vector<std::string> filament_jsons;
    std::vector<MeshInput>   objects;
};

struct ExclusionHit {
    int                extruder     = 0;  // 0-based
    int                region_index = 0;  // index in that extruder's region list
    std::vector<float> triangles;         // intersecting surface, 9 floats per triangle
};

struct CheckedObject {
    std::string               name;
    bool                      inside = false;
    std::vector<ExclusionHit> exclusion_hits;
};

} // namespace muon
