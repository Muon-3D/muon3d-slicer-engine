// "Before you print" checks (KAN-528): after a slice, where the print may fail and what to change.
// Orca's stability and support-issue search (SupportSpotsGenerator full_search / gather_issues, as in
// PrusaSlicer) and the engine's own heuristics, documented with their sources in docs/print-checks.md.
// They only report: a slice never fails because of a check.
#pragma once

#include "job.hpp"

#include <string>
#include <vector>

namespace Slic3r {
class Print;
struct GCodeProcessorResult;
} // namespace Slic3r

namespace muon {

// Which way gravity points in the slicer's frame, where layers stack along +Z: against the build direction on an
// upright printer, along it on one that prints hanging from the bed (the Muon3D M1). A printer preset's "gravity"
// key, "against_build" when the preset has none (docs/print-checks.md, "Gravity").
enum class Gravity { AgainstBuild, AlongBuild };

const char *gravity_name(Gravity gravity);

// The preset's "gravity", from the machine preset's JSON text. Throws std::invalid_argument for another value.
Gravity gravity_of_machine_json(const std::string &machine_json);

// Runs after the G-code export, so the G-code is the same with or without the checks: the stability search,
// curled overhangs, warp risk, slender parts and thin features on Orca's layers (still there), and the
// layer-time bond index from the G-code's layer times. Each issue's layer is the preview's layer index
// (GCodeProcessorResult layer ids, as toolpaths.cpp numbers them); critical first, then by layer.
// Gravity-dependent checks follow `gravity` (docs/print-checks.md, "Gravity").
std::vector<PrintCheck> run_print_checks(Slic3r::Print &print, const Slic3r::GCodeProcessorResult &gcode, Gravity gravity);

} // namespace muon
