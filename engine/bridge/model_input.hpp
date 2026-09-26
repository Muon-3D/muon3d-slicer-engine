// Helpers shared by the slice and check jobs: the per-job directory in Emscripten's in-memory file
// system, turning a plate object into a ModelObject the way the CLI loads an STL file, the plate's
// build volume, and naming the object an Orca error or warning refers to.
#pragma once

#include "job.hpp"

#include <libslic3r/BuildVolume.hpp>
#include <libslic3r/Model.hpp>
#include <libslic3r/Print.hpp>
#include <libslic3r/PrintConfig.hpp>

#include <string>
#include <vector>

namespace muon {

// Creates a fresh, empty directory for one job (e.g. "/tmp/orca-engine/slice-12").
std::string make_job_dir(const std::string &kind);
// Removes a job directory and everything in it (frees the memory the files use). Never throws.
void remove_job_dir(const std::string &dir) noexcept;

// Removes a job directory when it goes out of scope, unless release() hands it on.
class JobDirGuard {
public:
    explicit JobDirGuard(std::string dir) : m_dir(std::move(dir)) {}
    ~JobDirGuard() { if (!m_dir.empty()) remove_job_dir(m_dir); }
    JobDirGuard(const JobDirGuard &) = delete;
    JobDirGuard &operator=(const JobDirGuard &) = delete;
    const std::string &path() const { return m_dir; }
    std::string        release() { return std::exchange(m_dir, std::string()); }

private:
    std::string m_dir;
};

// Writes `positions` (9 floats per triangle) as a binary STL, byte for byte what the server's
// writeBinaryStl (server/meshio.ts) produces for the CLI.
void write_binary_stl(const std::string &path, const std::vector<float> &positions);

// Loads one plate object into `model` exactly like the CLI loads an STL argument (OS:1718-1990):
// Format/STL load_stl (admesh repair, normals recomputed), a default instance, ensure_on_bed;
// `object.config` becomes the ModelObject's own settings, as a 3MF's object metadata would.
// Throws JobFailure(CLI_DATA_FILE_ERROR) when the mesh cannot be read, JobFailure
// (CLI_CONFIG_FILE_ERROR) naming the object for a setting Orca does not know or a value it cannot
// read, and std::bad_alloc when memory ran out, also where Orca itself swallowed that (the convex
// hull). The slice runs check_object_config on every object first.
Slic3r::ModelObject *load_object(Slic3r::Model &model, const MeshInput &object, const std::string &stl_path);

// Checks one object's own settings (`object.config`) before its mesh loads: each must be a setting
// Orca knows with a value it can read (the failures load_object would give), and the plate's
// config with them over it must pass the value checks the presets passed (PrintConfig.cpp
// validate(), as prepare_config runs it): Orca's limits (def.min / def.max), a layer height above
// 0, line widths the nozzle can print. Orca's 3MF loader skips that for object settings, and a
// layer height of 0 then makes the slicer allocate layers until memory runs out. Throws
// JobFailure(CLI_CONFIG_FILE_ERROR) naming the object and the setting.
void check_object_config(const MeshInput &object, const Slic3r::DynamicPrintConfig &plate_config);

// The plate's build volume as the CLI builds it for plate 1 (OS:4277 set_shapes, OS:6331).
Slic3r::BuildVolume plate_build_volume(const Slic3r::DynamicPrintConfig &config);

// True when the printer is one of Bambu Lab's (OS:6754-6770): it changes Orca's G-code dialect.
bool is_bbl_printer(const Slic3r::DynamicPrintConfig &config, const std::string &printer_name);

// Name of the object an Orca validation error or warning points at (ModelObject, ModelInstance or
// PrintObject); empty when there is none.
std::string object_name(const Slic3r::ObjectBase *object);
// Name of the print object with the given ObjectID (SlicingError::objectId, warning statuses).
std::string print_object_name(const Slic3r::Print &print, size_t object_id);

} // namespace muon
