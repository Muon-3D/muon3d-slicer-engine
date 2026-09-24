// Builds the full print configuration exactly the way OrcaSlicer's command line does
// (src/OrcaSlicer.cpp, CLI::run) for
//   --load-settings "machine.json;process.json" --load-filaments f1.json[;f2.json…]
// with flattened system presets. See engine/research/headless-entry.md §1 for the step table.
#pragma once

#include "job.hpp"

#include <libslic3r/PrintConfig.hpp>

#include <string>
#include <vector>

namespace muon {

struct PreparedConfig {
    // The CLI's m_print_config after the FullPrintConfig fill and validation (OS:4079-4112).
    Slic3r::DynamicPrintConfig print_config;
    // The CLI's m_extra_config: the command-line options, which the CLI applies again on top of
    // every plate's config (OS:6690).
    Slic3r::DynamicPrintConfig extra_config;
    // new_printer_name / new_printer_system_name in CLI::run.
    std::string printer_name;
    std::string printer_system_name;
    // new_extruder_count (number of nozzles) and filament_count (number of loaded filaments).
    int extruder_count = 1;
    int filament_count = 0;
};

// Loads the three preset kinds from JSON text (written to `work_dir` first: Orca's loader only
// reads files) and merges them like the CLI. Throws JobFailure with the CLI's exit code on a bad
// preset (-5), an incompatible process (-17), invalid values (-18) or a broken mixed filament (-69).
PreparedConfig prepare_config(const std::string              &machine_json,
                              const std::string              &process_json,
                              const std::vector<std::string> &filament_jsons,
                              const std::string              &work_dir);

} // namespace muon
