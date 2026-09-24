// Turns Orca's GCodeProcessorResult (the G-code as Orca's own processor understood it) into what
// the web app shows: the preview toolpaths in the format of web/src/gcode/parse.ts and the print
// statistics of shared/types.ts GcodeStats.
#pragma once

#include "job.hpp"

#include <libslic3r/GCode/GCodeProcessor.hpp>
#include <libslic3r/Print.hpp>

namespace muon {

// Segments follow the G-code parser's conventions (see toolpaths.cpp for how the processor's
// view is mapped onto them). `with_extras` also fills the ToolpathExtras arrays.
ToolpathData build_toolpaths(const Slic3r::GCodeProcessorResult &result, bool with_extras = true);

// The values the server reads from the G-code header and footer (server/gcodeStats.ts), computed
// from the same data Orca writes them from, with the same rounding.
GcodeStats build_stats(const Slic3r::GCodeProcessorResult &result, const Slic3r::Print &print);

} // namespace muon
