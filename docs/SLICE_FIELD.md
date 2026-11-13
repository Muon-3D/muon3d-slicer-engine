# The slice field

**Format version: 1.** How a plate will actually be printed, sampled on a voxel grid, as one file. The slicer writes
it; a separate program, such as the print-strength simulator ([Muon-3D/muon3d-sim](https://github.com/Muon-3D/muon3d-sim)),
reads it. **Only this file crosses that boundary**: no libslic3r structure, no engine code, no protocol connection.
That keeps the AGPL engine and the programs that read the field separate programs.

The engine's reader and writer are in [`packages/protocol/src/sliceField.ts`](https://github.com/Muon-3D/muon3d-slicer-engine/blob/feat/KAN-528-slice-field/packages/protocol/src/sliceField.ts) (Apache-2.0, no engine code):
`decodeSliceField(bytes)`, `readSliceFieldHeader(bytes)`, `encodeSliceField(description, arrays)`. Another
language needs nothing but this page.

The engine builds the field when a `slice` asks for it (`SliceParams.output.sliceField`, capability `slice.field`;
[engine PROTOCOL.md](https://github.com/Muon-3D/muon3d-slicer-engine/blob/feat/KAN-528-slice-field/docs/PROTOCOL.md) §6.5) and returns the file's bytes in `SliceResult.sliceField`. A client saves them as
`<name>.slicefield`.

## The file

All numbers little-endian.

| Bytes | What |
|---|---|
| 0-7 | Magic: ASCII `MSLFIELD` |
| 8-11 | `u32`: the header's length in bytes, `H` (a multiple of 8) |
| 12-15 | `u32`: 0 (reserved) |
| 16 … 16 + H - 1 | The header: UTF-8 JSON, padded with spaces to `H` bytes |
| … | The arrays, each at the byte `offset` the header gives (from the start of the file; a multiple of 8) |

Arrays must start after the padded header, have integer offsets aligned to 8 bytes, fit in the file,
and occupy disjoint byte ranges. Readers reject a layout that violates these rules.

## The header

```jsonc
{
  "format": "muon3d.slice-field",
  "version": 1,                       // this page; a reader refuses another version
  "units": "mm",
  "origin": [50, 40, 0],              // bed coordinates of the grid's minimum corner (corner of voxel [0,0,0])
  "voxelSize": 1,                     // cube edge, mm: 1 (default) or 0.5
  "dims": [100, 100, 100],            // voxels along x, y, z
  "buildDirection": [0, 0, 1],        // layers stack along +z of the grid
  "gravity": "along_build",           // gravity during the print: "along_build" | "against_build" | null (below)
  "material": { "type": "PLA", "name": "Generic PLA @Muon3D M1", "vendor": "Generic" },   // filament 1
  "layerHeight": 0.2,                 // the process's layer_height, mm
  "firstLayerHeight": 0.2,            // initial_layer_print_height, mm
  "layerCount": 500,
  "layerZ": [0.2, 0.4, …],            // top of each layer, mm from the bed; layer n spans (layerZ[n-1], layerZ[n]] (layer 0 from 0)
  "infillPatterns": [ { "id": 0, "name": "none" }, { "id": 1, "name": "rectilinear" }, …, { "id": 10, "name": "gyroid" }, … ],
  "objects": [ { "name": "Cube.stl", "wallLoops": 2, "infillDensity": 20, "infillPattern": 10 } ],
  "arrays": {
    "wallFraction":    { "type": "u8",  "offset": …, "length": 1000000 },
    "skinFraction":    { "type": "u8",  "offset": …, "length": 1000000 },
    "infillFraction":  { "type": "u8",  "offset": …, "length": 1000000 },
    "infillDensity":   { "type": "u8",  "offset": …, "length": 1000000 },
    "infillPattern":   { "type": "u8",  "offset": …, "length": 1000000 },
    "rasterDirection": { "type": "i8",  "offset": …, "length": 1000000 },
    "layerIndex":      { "type": "u16", "offset": …, "length": 1000000 },
    "depositionTime":  { "type": "f32", "offset": …, "length": 1000000 }   // optional
  },
  "generator": "Muon3D Slicer Engine"   // optional
}
```

- The grid covers the objects' bounding box in x and y and runs from the bed (z = 0) to their top, rounded up to whole
  voxels. Voxel `[i, j, k]` spans `origin + [i, j, k] * voxelSize` to `origin + [i+1, j+1, k+1] * voxelSize`.
- **Order:** x fastest: voxel `[i, j, k]` is value `i + dims[0] * (j + dims[1] * k)` of every array.
- `infillPatterns` maps the ids `infillPattern` uses to Orca's `sparse_infill_pattern` names. Id 0 is `none`. The
  writer keeps the ids stable (Orca's patterns in a fixed order, unknown names appended), but a reader MUST look names
  up in the table rather than assume ids.
- `gravity` is which way gravity pointed **during the print**, relative to `buildDirection`. `"against_build"`: a
  normal printer, the part standing on the plate (gravity along -z). `"along_build"`: the Muon3D M1, which prints
  upside down, the part hanging from the plate above it and growing downward (gravity along +z of this frame). It
  comes from the printer profile (`printer_notes`, [engine PROFILES.md](https://github.com/Muon-3D/muon3d-slicer-engine/blob/feat/KAN-528-slice-field/docs/PROFILES.md) §9.1); `null` when the profile does
  not say, and a reader MUST NOT assume either then. It does not change the arrays: the layers sit in the part the
  same way, so a service-load analysis of the finished part reads the field the same either way. Process simulation
  and stability checks (weight while printing, sag of unsupported extrusions, peel at the plate) MUST use it.
- `objects` are the plate's objects and their sparse-infill settings (each object's own settings over the process's).
- Unknown header keys MUST be ignored; new ones may appear within version 1. A new array may appear too (a reader finds
  arrays by name in `arrays`).

## The arrays

One value per voxel each.

| Name | Type | Value |
|---|---|---|
| `wallFraction` | u8 | Fraction of the voxel's volume that is perimeter, 0-255 for 0-1 |
| `skinFraction` | u8 | Fraction that is solid infill (internal solid infill, top and bottom surfaces, bridges), 0-255 |
| `infillFraction` | u8 | Fraction that is the sparse-infill region, 0-255 |
| `infillDensity` | u8 | The sparse infill's density there, % (0 where `infillFraction` is 0) |
| `infillPattern` | u8 | Its pattern, an id of `infillPatterns` (0 where `infillFraction` is 0) |
| `rasterDirection` | i8 | Dominant raster direction in the XY plane: degrees from +x, ÷ 2, in [-45, 44]; -128 where nothing is extruded |
| `layerIndex` | u16 | The layer the voxel's centre is printed in (`layerZ[n-1] < z ≤ layerZ[n]`); 65535 where the voxel has no material |
| `depositionTime` | f32 | Optional. Volume-weighted mean time the voxel's material was laid, s from the print's start; NaN where nothing is extruded |

- The three fractions add up to at most 255 (rounding aside); the rest is empty space. `infillFraction` is the share of
  the voxel inside the part's sparse-infill region, whatever its density: the material there is
  `infillFraction / 255 × infillDensity / 100` of the voxel, as a homogenised continuum.
- `rasterDirection` is the mean direction of all the material extruded in the voxel (walls, skin and infill), weighted
  by volume, taken on doubled angles because a line has no sense (0° ≡ 180°). Lines along +x give 0, along +y -45
  (i.e. ±90°), along x = y 23 (46°, the nearest 2° sample; halfway values round toward +∞). Sparse infill does not cross every voxel of a fine grid: a voxel in the sparse region
  with no line through it has -128.
- `layerIndex` follows the plate's layers (`layerZ`); with objects of different layer heights the layers are the union
  of their tops.

## How the slicer builds it

From the sliced layers' extrusions (their role, path, width and height: the neutral toolpaths of PROTOCOL.md §8)
and the objects' meshes:

| Extrusion role (`;TYPE:`) | Counts as |
|---|---|
| Outer wall, Inner wall, Overhang wall, Gap infill | wall |
| Internal solid infill, Top surface, Bottom surface, Bridge, Internal Bridge | skin |
| Sparse infill | infill (its region) |
| Support, Support interface, Support transition, Skirt, Brim, Ironing, Prime tower, Custom | left out |

For each layer, on an XY raster of 8 cells per voxel edge (0.125 mm at 1 mm voxels):

1. The objects' cross-sections at mid-layer are filled (even-odd): the region a sparse infill fills.
2. Each wall and skin extrusion is drawn as a capsule of its line width; wall wins where they overlap. A cell under a
   bead leaves the sparse region.
3. The cells are counted per voxel column and added to the voxels the layer overlaps in z, by the thickness of the
   overlap.

Every material extrusion also adds its direction (and its time) to the voxels it runs through. Fractions are good to
about one raster cell (1/8 of a voxel edge): a 0.82 mm band of walls fills the outer 1 mm voxel to about 0.82-0.88.
A bead turning a convex corner leaves its radius unfilled there, as the print does.

## Versions

- **1** (this page): first version. This contract is mirrored at `docs/SLICE_FIELD.md` in Muon-3D/muon3d-sim.
  Keep both copies identical when evolving the file format.
