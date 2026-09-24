// One slicing job: the plate half of OrcaSlicer's CLI::run (src/OrcaSlicer.cpp:6331-7034) for a
// single plate built from pre-placed objects, run with the configuration from cli_config.
#pragma once

#include "job.hpp"

namespace muon {

// Slices the plate and writes plate_1.gcode into a fresh job directory. On success the caller
// owns SliceResult::job_dir (read the G-code, then remove_job_dir). Failures throw JobFailure with
// the CLI's exit code (see protocol.ts EngineError) and leave nothing behind. Takes the request by
// value: each mesh is released as soon as Orca has loaded it.
SliceResult run_slice(SliceRequest request, JobReporter &reporter);

} // namespace muon
