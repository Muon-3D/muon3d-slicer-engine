// "Before you print" checks (KAN-528): after a slice, where the print may fail and what to change.
// Orca's stability and support-issue search (SupportSpotsGenerator full_search / gather_issues, as in
// PrusaSlicer) and the engine's own heuristics, documented with their sources in docs/print-checks.md.
// They only report: a slice never fails because of a check.
#pragma once

#include "job.hpp"

#include <vector>

namespace Slic3r {
class Print;
struct GCodeProcessorResult;
} // namespace Slic3r

namespace muon {

// Runs after the G-code export, so the G-code is the same with or without the checks: the stability search,
// curled overhangs, warp risk, slender parts and thin features on Orca's layers (still there), and the
// layer-time bond index from the G-code's layer times. Each issue's layer is the preview's layer index
// (GCodeProcessorResult layer ids, as toolpaths.cpp numbers them); critical first, then by layer.
std::vector<PrintCheck> run_print_checks(Slic3r::Print &print, const Slic3r::GCodeProcessorResult &gcode);

} // namespace muon
