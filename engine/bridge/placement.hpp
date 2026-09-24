// The check job: Orca's own pre-slice placement checks for the objects on the plate, without
// slicing. The UI calls it whenever an object moves, so it keeps the prepared config and the
// loaded meshes between calls and only moves an object when its triangles are an exact translation
// of the ones it has already loaded.
#pragma once

#include "cli_config.hpp"
#include "job.hpp"

#include <libslic3r/BuildVolume.hpp>
#include <libslic3r/Model.hpp>
#include <libslic3r/PrintConfig.hpp>

#include <memory>
#include <string>
#include <vector>

namespace muon {

class PlacementChecker {
public:
    PlacementChecker();
    ~PlacementChecker();

    // For each object: is it fully inside the printable volume (the test behind the CLI's -50/-52
    // and the GUI's PartPlate::check_outside), and which bed exclusion regions does it intersect
    // (the test behind Print::validate's -64), with the intersecting surface for drawing.
    // Throws JobFailure for bad presets (as the slice job would) or unreadable meshes.
    std::vector<CheckedObject> check(CheckRequest request);

    // Drops the cached config and meshes (frees their memory).
    void clear();

private:
    struct Settings;
    struct CachedObject;

    const Settings      &settings_for(const CheckRequest &request, const std::string &work_dir);
    Slic3r::ModelObject *object_for(MeshInput &input, const std::string &stl_path);
    CheckedObject        check_object(const std::string &name, Slic3r::ModelObject &object) const;

    std::unique_ptr<Settings>                  m_settings;
    std::vector<std::unique_ptr<CachedObject>> m_objects;
};

} // namespace muon
