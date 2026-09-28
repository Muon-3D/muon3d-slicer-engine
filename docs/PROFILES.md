# Profile sets

A **profile set** is OrcaSlicer's printer, process and filament presets packed for a static site: every vendor of the
OrcaSlicer tree the engine is built from, with the Muon3D vendor taken from [`profiles/muon3d`](../profiles/muon3d).
Each release publishes one as `muon3d-slicer-profiles-<version>.tgz`, built with that release's engine, and the
`edge` prerelease carries one for `main`. A client serves the set's `profiles/` folder next to its pages, lists
printers from the index, fetches a vendor's bundle when it is needed, and flattens presets itself; it never needs a
server, and it never has to evaluate OrcaSlicer's code to get OrcaSlicer's result.

The engine's profile ops ([`PROTOCOL.md`](PROTOCOL.md), "Profiles") do the work when a set is built: every file is
read with OrcaSlicer's own loader (`profiles.normalize`), every selectable preset is flattened by OrcaSlicer's own
`PresetBundle` (`profiles.resolve`), and OrcaSlicer's profile validator runs on the whole tree
(`profiles.validate`). The types of every file below are in the protocol package
([`packages/protocol/src/profileSet.ts`](../packages/protocol/src/profileSet.ts), Apache-2.0), with `flattenPreset`,
the reference way to flatten a preset from a set.

## Contents

1. [The tarball](#1-the-tarball)
2. [Serving it](#2-serving-it)
3. [The files](#3-the-files)
4. [Flattening a preset](#4-flattening-a-preset)
5. [Which presets suit a printer](#5-which-presets-suit-a-printer)
6. [Goldens: testing a client](#6-goldens-testing-a-client)
7. [The engine a set belongs to](#7-the-engine-a-set-belongs-to)
8. [Building and checking a set](#8-building-and-checking-a-set)
9. [The Muon3D overlay](#9-the-muon3d-overlay)
10. [Sizes](#10-sizes)
11. [Licence and source](#11-licence-and-source)

## 1. The tarball

```
muon3d-slicer-profiles-<version>/
  profiles/<set>/index.<hash>.json            the index: vendors, printers, models, each type's defaults
  profiles/<set>/vendors/<id>.<hash>.json.gz  one bundle per vendor (VendorBundle), gzip
  profiles/<set>/all.<hash>.json.gz           every bundle in one file, for offline or private use
  profiles/<set>/SOURCE.json                  where the source of the set is
  profiles/assets/<sha256>.<ext>              bed models (.stl), bed textures (.svg, .png), printer pictures (.webp)
  goldens.json.gz                             OrcaSlicer's own results, for testing a client (not served)
  report.json                                 what normalising changed per vendor, the validator's verdict, the sizes
  README.md, LICENSE
```

`<set>` is the release's version (`0.3.0`); `<hash>` is the first 16 hex digits of the sha256 of the file as stored.

## 2. Serving it

- Serve `profiles/` as it is. Every file but `SOURCE.json` is named after its content, so it can be cached for good;
  sets never change once published, and assets are shared between sets. Keep old sets online: saved presets and
  projects name the set they were made with.
- **Bundles are gzip files with a neutral type** (`.json.gz`). A client checks the first two bytes: `1f 8b` means
  gzip (decompress with `DecompressionStream('gzip')`), anything else is the JSON itself (a server that added
  `Content-Encoding: gzip` on its own). This works on any static host, whatever it does with `.gz` files.
- **Paths** in the index and in the bundles are relative to the index file's URL. Assets are `../assets/...`.
- Fetching a vendor's bundle tells the server which brand a person uses. The all-in-one file is the private option.

## 3. The files

### The index (`ProfileIndex`)

| Field | What |
|---|---|
| `format` | 1 |
| `set` | the set's name (the release's version) |
| `engine` | `version`, `orca: { version, commit }`, and `optionsHash`: the sha256 of the engine's `config.definitions` result as JSON text (`JSON.stringify`) |
| `source` | this repository and the commit the set was built from (`SOURCE.json` has the rest) |
| `library` | `"OrcaFilamentLibrary"`: the vendor every vendor's filaments may inherit from |
| `defaults` | each type's default preset, without `name`, `from`, `type` and `version`: where every inheritance chain starts |
| `vendors[]` | `id` (the folder name references use, `"BBL"`), `name` (`"Bambulab"`), `version` (the vendor's profile version), `description`, `bundle` (`{ path, bytes, sha256 }`), `printers[]` (`{ name, model, variant, nozzle[] }`, the selectable printers, by model, nozzle and name) and `models[]` (`{ name, family, nozzle[], cover }`, `cover` an asset path) |
| `all` | the all-in-one file: `{ path, bytes, sha256 }` |

### A vendor bundle (`VendorBundle`)

| Field | What |
|---|---|
| `format` | 1 |
| `vendor` | `{ id, name, version, description }` |
| `models` | the printer model files by model name, as the vendor ships them (`model_id`, `family`, `nozzle_diameter`, `bed_model`, `bed_texture`, `default_materials`, ...) |
| `presets` | `machine`, `process`, `filament`: each preset file by name, **in the order OrcaSlicer loads them** (a parent before its children), as `profiles.normalize` writes it: its metadata as given (`inherits`, `instantiation`, `setting_id`, `filament_id`, `renamed_from`, ...), then its settings under their current keys, in OrcaSlicer's text (a vector option as a list of strings). Selectable presets have `instantiation: "true"` |
| `adjust` | for the selectable presets that need it: settings as OrcaSlicer holds them after merging the chain (section 4) |
| `renamed` | older preset names that still find a preset: old name -> current name, per type |
| `assets` | the files the models name (`bed_model`, `bed_texture`, `<model name>_cover.png`) -> asset path |
| `report` | what normalising changed in the vendor's files: legacy key -> its new name, and counts of dropped (unknown or retired), misplaced (another preset type) and substituted values |

Normalising is what OrcaSlicer does to each file as it loads it, done once: a legacy key (`wall_infill_order`)
becomes its current key (`wall_sequence`), a retired or unknown key goes, a setting of another preset type goes, and
values are written as OrcaSlicer writes them (`"0.20"` becomes `"0.2"`). A client that merges the files then gets
what OrcaSlicer gets, and a settings panel shows the value that is printed.

### Assets

Bed models and textures are copied as they are; printer pictures are converted from PNG to WebP (quality 80). An
asset's name is the sha256 of its bytes, so identical files are stored once.

### `SOURCE.json`

The repository and commit (and tag, for a release) the set was built from, the builder (`tools/profiles/build.ts`),
the OrcaSlicer repository, commit, tag and version whose `resources/profiles` it read, the overlay (`profiles/muon3d`,
its vendors, and a digest of its files: the sha256 of the lines `<sha256 of the file>  <path>`, sorted by path,
documentation left out), and the engine fields of the index.

## 4. Flattening a preset

A selectable preset's flattened form is what `slice` and `settings.*` take. From a set, for a preset of type `T` named
`N` of vendor `V`:

1. **Find it.** In `V`'s bundle, by `N`, else by `V.renamed[T][N]`. A filament not in `V` is looked up the same way
   in the library's bundle. That bundle is the preset's *owner*.
2. **Walk its chain.** Start at the preset's file and follow `inherits` until a file has none. Each parent is looked
   up in the bundle the walk is in; for filaments only, a parent missing there is looked up in the library, and the
   walk continues in the library. A missing parent or a loop is an error.
3. **Merge.** Start from `index.defaults[T]`. Apply each file of the chain from the root to the preset: every key
   that is not metadata (`version`, `name`, `url`, `type`, `setting_id`, `filament_id`, `from`, `description`,
   `instantiation`, `inherits`, `renamed_from`, `is_custom_defined`) replaces the value so far.
4. **Filament id.** For a filament, `filament_id` is the first non-empty `filament_id` of the chain, from the preset
   to the root (OrcaSlicer inherits it that way, and writes it into the G-code's `filament_ids`).
5. **Adjust.** Apply `owner.adjust[T][N]`, when there is one: OrcaSlicer resizes vector settings to the printer's
   nozzles and variants and fills unset per-variant slots while it loads presets; the set records the result, so a
   client need not repeat that logic.
6. **Stamp** `name: N` (the current name), `from: "system"`, `type: T`.

`flattenPreset` in the protocol package does exactly this. For every selectable preset of every vendor, the result
is what OrcaSlicer's own `PresetBundle` holds for that preset (section 6); the build checks it.

A user preset (OrcaSlicer's format: `inherits` a system preset, `from: "User"`, only the changed keys) is the
flattened parent with the user's keys applied. `profiles.normalize` reads an imported preset file the way OrcaSlicer
does.

## 5. Which presets suit a printer

OrcaSlicer offers a process or filament with a printer when:

- its `compatible_printers` list names the printer; or
- the list is empty and its `compatible_printers_condition` holds for the printer's flattened config (OrcaSlicer's
  placeholder expression language, with two more variables: `printer_preset`, the printer's name, and
  `num_extruders`, the number of its nozzles; an expression that fails to evaluate counts as true); or
- both are empty;
- except that a library filament with an empty `compatible_printers` is not offered with a printer when another
  filament of the same alias (the name up to `@`, trimmed) names that printer in its `compatible_printers`: the
  printer's own "Generic PLA @Muon3D M1" replaces "Generic PLA @System".

A filament with `compatible_prints` (or `compatible_prints_condition`) also suits only those processes.
`profiles.resolve` with `compatibility` returns OrcaSlicer's own answer, and the goldens record it for every printer.

## 6. Goldens: testing a client

`goldens.json.gz` (`ProfileGoldens`) holds, per vendor:

- `presets[type][name]`: the sha256 (hex) of `canonicalConfigJson` of OrcaSlicer's flattened preset. The canonical form
  is the flattened preset without `name`, `from`, `type`, `version` and `instantiation`, keys sorted with
  JavaScript's default sort, as `JSON.stringify` writes it, hashed as UTF-8.
- `compatibility[printer]`: for the processes and the filaments (the vendor's and the library's) OrcaSlicer offers
  with the printer, the sha256 of the names sorted with JavaScript's default sort and joined by `"\n"`, and the counts.
- `printRestricted[filament]`: the vendor's processes a filament limited by `compatible_prints` suits.

A client's flattening passes when its canonical hash of every selectable preset equals the golden; its compatibility
rules when every printer's two hashes do.

## 7. The engine a set belongs to

A set is built by and for one engine release: its presets use that engine's keys, and its `adjust` records that
engine's loader. A client uses a set only with the engine its index names: `index.engine.orca.commit` equals the
`hello` answer's `engine.orca.commit`, and `index.engine.optionsHash` equals the sha256 of the engine's
`config.definitions` result as JSON text. The runtime and the set of a release are built from the same commit
(`index.source.commit` is the runtime manifest's `build.engineCommit`).

A fix to the Muon3D profiles alone needs no new engine build: it is a new release whose engine is rebuilt byte for
byte, with a new set.

## 8. Building and checking a set

```bash
npm run build:engine -- st                 # the engine the set is built with (dist/)
bash engine/scripts/get-orca.sh            # orca/ at the pin: the tree the engine is built from
npm run profiles:build -- --out out/profiles --set dev
npm run profiles:check -- out/profiles --expect test/profiles/muon3d.json
npm run profiles:fixtures -- --check       # the engine tests' preset fixtures are what profiles.resolve makes
```

The build fails when:

- OrcaSlicer's profile validator (`OrcaSlicer_profile_validator`, through `profiles.validate`) finds an error
  anywhere in the tree;
- a file of the overlay holds a key the engine does not read as it is: a legacy, unknown, retired or misplaced key, or
  a value OrcaSlicer would substitute (other vendors' such keys are dropped as OrcaSlicer drops them, and counted in
  their bundle's `report`);
- `flattenPreset` with the recorded adjustments does not give OrcaSlicer's result for a preset.

`tools/profiles/check.ts` checks a built set with no engine: every file the index names is there with its size and
sha256, the bundles agree with the index and the all-in-one file, every asset is there under its sha256, and every
selectable preset flattened from the set hashes to its golden. With `--expect`, the Muon3D presets and their
compatibility must match [`test/profiles/muon3d.json`](../test/profiles/muon3d.json): a change to what the M1 prints
is a reviewed change to that file (`--write-expect` rewrites it).

CI builds and checks a set on every pull request and push (`build.yml`), and also runs OrcaSlicer's
`scripts/orca_profile_tool.py check` on the OrcaSlicer tree with the overlay in place. A release builds its set in the
`draft` job and checks it again from the downloaded asset (`tools/release/verify-release.sh`).

## 9. The Muon3D overlay

[`profiles/muon3d`](../profiles/muon3d) holds the Muon3D vendor in OrcaSlicer's layout (`Muon3D.json` and
`Muon3D/`); a set takes it instead of the Muon3D folder of the OrcaSlicer tree. To change it: edit the files, keep them
in the shape OrcaSlicer's `scripts/orca_profile_tool.py` writes (`normalize`, `update-index`, `generate-id`), build
and check a set, and update `test/profiles/muon3d.json` with `--write-expect` when the M1's settings are meant to
change. [`profiles/muon3d/README.md`](../profiles/muon3d/README.md) says where the files came from.

## 10. Sizes

Measured on the set of the pinned OrcaSlicer tree (66 vendors, 10,776 selectable presets):

| Part | Size |
|---|---|
| Index (every vendor and printer, the type defaults) | 211 KB, 38.5 KB gzip |
| Muon3D bundle / OrcaFilamentLibrary bundle | 5.0 KB / 34 KB gzip |
| **Muon3D only**: index + Muon3D + OrcaFilamentLibrary | **77.6 KB** gzip |
| All 66 vendor bundles | 1.20 MB gzip (all-in-one file 1.16 MB) |
| M1 assets: bed model (STL), bed texture (SVG), picture (WebP) | 1.05 MB as stored (the STL is 1 MB; a server that compresses sends about 0.25 MB) |
| All assets (748 files) | 15.3 MB |

## 11. Licence and source

The presets are OrcaSlicer's, distributed under the AGPL-3.0; a set carries `LICENSE`. Its Corresponding Source is the
per-file JSON of the OrcaSlicer tree and of the overlay at the commits `SOURCE.json` names, and the build scripts in
this repository (`tools/profiles`); a release's source assets hold all of it.
