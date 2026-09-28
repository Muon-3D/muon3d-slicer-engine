# The Muon3D vendor profiles

The printer, process and filament presets of the Muon3D M1, in OrcaSlicer's layout: `Muon3D.json` (the vendor
index) and `Muon3D/`. A profile set (`docs/PROFILES.md`) takes this folder instead of the Muon3D folder of the
OrcaSlicer tree the engine is built from. This folder is where the Muon3D profiles are maintained for the engine.

## Where the files came from

They started as `resources/profiles/Muon3D.json` and `resources/profiles/Muon3D/` of the pinned OrcaSlicer commit
(`2d1163eb6f`, tag `muon3d-wasm/2026-09-24` of <https://github.com/Muon-3D/OrcaSlicer>), vendor version `02.03.00.11`,
with the exclusion zones as `bed_exclude_volumes`. The bed model, bed texture and picture are those files as they
were (the texture with LF line ends). The changes since, none of which changes a setting (every M1 preset flattens to
the same settings as the pinned files, checked with `profiles.resolve`, and the same processes and filaments are
offered with each printer):

1. **The two common files.** `machine/fdm_machine_common.json` and `process/fdm_process_common.json` began as copies
   of OrcaSlicer's `Custom` vendor files. They now hold no settings. Of the values they gave the M1, those that differ
   from the engine's defaults and that the M1's own base files did not set moved into those base files:
   `extruder_colour` into `machine/fdm_common_muon_m1.json`, and 28 settings (line widths, speeds, skirt, infill and
   support details, `filename_format`) into `process/fdm_process_muon_m1_common.json`, written as OrcaSlicer writes
   them. The rest were the engine's defaults, or set again by the M1's files.
2. **Keys OrcaSlicer no longer reads** are gone: `silent_mode`, `adaptive_layer_height`, `tree_support_with_infill`.
3. **Compatible printers.** `Generic PLA Matte` and `Generic PLA Silk` list the M1 printers themselves, as OrcaSlicer's
   profile checks want of every vendor filament.
4. **Ids.** `setting_id` and `filament_id` are the ids OrcaSlicer's `scripts/orca_profile_tool.py generate-id` mints.
   `Generic PLA High Speed`, `Generic PLA Matte`, `Generic PLA Silk` and `Polyflex TPU90` had inherited the
   `filament_id` of another filament, which OrcaSlicer's profile validator reports as an ambiguous filament match; each
   now has its own.
5. **Shape.** Every file is as `orca_profile_tool.py normalize` and `update-index` write it.

TODO: take the M1 start G-code change of <https://github.com/Muon-3D/OrcaSlicer/pull/7> (vendor version
`02.03.00.13`: lift to Z6 after the purge line, before the first travel) once that pull request is reviewed and
merged, and bump `version` in `Muon3D.json` with it. Until then the version stays `02.03.00.11`.

## Changing them

Edit the files, then keep them in the shape OrcaSlicer's tools write, on an OrcaSlicer tree with this folder in place of
its Muon3D folder:

```bash
python3 orca/scripts/orca_profile_tool.py normalize    --profiles <tree> --vendor Muon3D
python3 orca/scripts/orca_profile_tool.py update-index --profiles <tree> --vendor Muon3D
python3 orca/scripts/orca_profile_tool.py generate-id  --profiles <tree> --vendor Muon3D
python3 orca/scripts/orca_profile_tool.py check        --profiles <tree>
```

and build and check a set (`docs/PROFILES.md`, "Building and checking a set"). The build refuses a key here that the
engine does not read as it is. When the M1's settings or offered presets are meant to change, record them:
`npm run profiles:check -- <set> --write-expect test/profiles/muon3d.json`, and let the change of that file be reviewed
with the profile change.

Licence: AGPL-3.0-only, as the rest of this repository.
