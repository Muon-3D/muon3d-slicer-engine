// OrcaSlicer's vendor profiles, handled by Orca's own code (libslic3r Preset and PresetBundle): each
// file read the way Orca reads it, whole vendors loaded and flattened the way the desktop app loads
// them, and Orca's profile validator. The profile files come with the request (the engine carries no
// profile tree) and go into a job folder of the virtual file system for the duration of the call.
//
// Requests and results are JSON text; their shapes are the protocol's (packages/protocol/src/profiles.ts),
// minus what the host adds (host/src/profiles.ts). A malformed request throws JobFailure with
// ENGINE_BAD_REQUEST.
#pragma once

#include <string>

namespace muon {

// { presets: [{ type, config }] } -> { presets: [{ config, renamed, dropped, misplaced, substituted, added } | { error }] }
// Each file as Orca's vendor loader reads it (ConfigBase::load_from_json with handle_legacy, then the
// keys of another preset type removed as Preset::remove_invalid_keys does), written back in Orca's own
// text (ConfigBase::save_to_json). Metadata keys (name, inherits, instantiation, ...) pass through.
std::string profiles_normalize(const std::string &request);

// { vendor: Folder, library?: Folder, presets?: [{ type, name }], compatibility?: bool | string[] }
//   -> { presets: [...], compatibility?: [...], printRestricted?: [...], errors: string[] }
// Loads the folders the way the desktop app loads its system presets (PresetBundle::load_presets:
// the filament library first, then the vendor against it; nothing else) and returns each selectable
// preset's config as Orca holds it (every setting of its type), with Orca's compatibility per printer.
std::string profiles_resolve(const std::string &request);

// { vendors: Folder[], vendor?: string, checkFilamentSubtypes?: bool } -> { ok, errors, warnings, counts }
// OrcaSlicer_profile_validator (src/dev-utils) on the folders given: the load in validation mode (of
// `vendor` and the filament library only, when `vendor` is given: -v), and PresetBundle::has_errors.
// Its reference checks look across every loaded vendor, so the library passes only with the vendors
// its filaments name.
std::string profiles_validate(const std::string &request);

} // namespace muon
