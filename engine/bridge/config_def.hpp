// configDefinitions(): Orca's option table (print_config_def) and the key sets that libslic3r
// defines (preset scopes, per-extruder and variant keys, per-object keys), as JSON text, for the
// settings catalogue generator. The shape is ConfigDefinitions in host/src/configDefinitions.ts.
#pragma once

#include <string>

namespace muon {

// Deterministic: options and every key list are sorted. Needs no initialisation (print_config_def
// is static). Never throws; on an internal error the JSON is { "error": "<message>" }.
std::string config_definitions_json();

} // namespace muon
