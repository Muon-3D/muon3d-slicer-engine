# The Muon3D vendor profiles

The printer, process and filament presets of the Muon3D M1, in OrcaSlicer's layout: `Muon3D.json` (the vendor
index) and `Muon3D/`. A profile set (`docs/PROFILES.md`) takes this folder instead of the Muon3D folder of the
OrcaSlicer tree the engine is built from. This folder is where the Muon3D profiles are maintained for the engine.

## Where the files come from

**Do not edit the files here.** The M1 profiles have one home: `resources/profiles/Muon3D.json` and
`resources/profiles/Muon3D/` of <https://github.com/Muon-3D/OrcaSlicer>, branch `muon3d-m1`, the profiles the desktop
OrcaSlicer build ships. This folder is their copy at the commit `tools/profiles/muon3d-source.json` pins, written by
`tools/profiles/sync-muon3d.ts`, so the desktop slicer and the web slicer print the same M1 settings.

The copy differs from its source in two ways only, both because the engine's OrcaSlicer (the `muon3d-wasm` branch,
OrcaSlicer#13777) is not the desktop build:

1. **The 3D exclusion zone.** The desktop build reads the M1's notch from `bed_exclude_area`, a point list with a Z
   range (`0..5;119.5x0,...`); the engine reads `bed_exclude_volumes`, the same text as one string. The copy moves a
   Z-ranged `bed_exclude_area` to `bed_exclude_volumes`. Once `muon3d-m1` takes #13777's option, this step does nothing.
2. **The shape** `orca/scripts/orca_profile_tool.py` writes at the engine's pin (`normalize`, `update-index`).

CI keeps it so: `build.yml` runs `sync-muon3d.ts --check` on every change (the copy must be what the tool writes from
the pinned commit), and `profiles-source.yml` runs `--check --latest` every day (it fails when `muon3d-m1` has M1
profile changes this repository has not pinned).

## Changing them

1. Change the M1 profiles in Muon-3D/OrcaSlicer, in a pull request to `muon3d-m1`. Bump `version` in `Muon3D.json`
   so installed desktop copies update. That repository's `check_profiles.yml` runs OrcaSlicer's checks; also run
   upstream's `scripts/orca_profile_tool.py check` (this repository's `orca/`) on a tree with the folder, which is
   stricter (legacy keys, ids).
2. Once it is merged, here: `node tools/profiles/sync-muon3d.ts --latest` (pins `muon3d-m1`'s head and writes the
   copy), then build and check a set (`docs/PROFILES.md`, "Building and checking a set"). When the M1's settings
   change, record them: `node tools/profiles/check.ts <set> --write-expect test/profiles/muon3d.json`, regenerate the
   preset fixtures (`node tools/profiles/fixtures.ts`), and re-record the slice goldens whose G-code changes
   (`tools/goldens/record-slices-*.mjs`, each with the release its header names). Review those changes with the
   profile change.

History: the folder began on 2026-09-24 as the Muon3D folder of OrcaSlicer `2d1163eb6f` (`muon3d-wasm/2026-09-24`),
vendor `02.03.00.11`, and was maintained here by hand until 2026-11-16, when it became the copy of `muon3d-m1`
(vendor `02.03.00.15`: the standard part-fan settings for the M1's firmware fan modes, and the `PURGE_LINE` start).

## Licence

The files in this folder are available under the AGPL-3.0 (like the rest of this repository) or, at your
option, the MIT licence (`LICENSES/MIT.txt`). SPDX: `AGPL-3.0-only OR MIT`.
