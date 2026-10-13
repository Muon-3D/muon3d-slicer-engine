# Print checks ("Before you print")

After every slice the engine looks for the places where the print is likely to fail and returns them in
`SliceResult.printChecks` (protocol 2.2, capability `slice.printChecks`; see [PROTOCOL.md](PROTOCOL.md)). They are
**warnings only**: a slice never fails, and no G-code changes, because of a check. The app shows them in its
"Before you print" panel, grouped by severity, each with the layer to jump to and one fix.

The checks run after the G-code export, on Orca's layers (still in memory) and the G-code processor's moves, in
[engine/bridge/print_checks.cpp](../engine/bridge/print_checks.cpp). `output.printChecks: false` skips them; the
time they take is `timings.checks` (ms).

## The issue

| Field | |
|---|---|
| `kind` | `unstable-part`, `floating-extrusion`, `long-bridge`, `curled-overhang`, `weak-connection` (Orca's search), `warp-risk`, `slender`, `thin-feature`, `layer-time`, `overhang`, `roof-gap`, `hanging-mass`, `weak-support-interface` (the heuristics below) |
| `severity` | `critical`, `warning` or `info` |
| `layer` | 0-based preview layer (the toolpaths' layer index) |
| `position` | `[x, y, z]` in bed millimetres; z is the layer's print height |
| `message` | one short line |
| `fix` | `supports`, `brim`, `slower-outer-walls`, `contact-area`, `orientation` ("turn it") or `support-interface` |
| `object` | the object's name, when the issue belongs to one |
| `value` | the check's number, when it has one (below) |

Issues of one kind on one object that are within 10 mm and 5 mm of height of each other are merged (the lowest
is kept; `unstable-part` and `weak-connection`, which are about a whole part, merge at any height), and at most 12 per kind and object are returned; the run-based checks return at most 6 runs per object.

## Gravity

In the slicer's frame layers stack along +Z. On an upright printer gravity points against that, onto the bed. The
Muon3D M1 prints upside down: the plate is above the part, the part grows downwards hanging from it, and gravity
points **along** +Z, the build direction. Which one a printer is comes from its machine preset's `gravity` key,
`"along_build"` or `"against_build"` (an engine key: Orca does not define it and its loader skips it; the profile
build keeps it, `PRESET_ENGINE_KEYS`). The M1's profiles set `"along_build"` (`fdm_common_muon_m1`); a preset
without the key is upright, which is what every other vendor's profiles describe. Any other value fails the slice.
`SliceResult.gravity` says which one the checks used. Service-load strength of the finished part does not depend on
it (the layers lie the same way in the part); the stability while printing does:

- **Weight pulls the part off the plate.** PrusaSlicer's search treats the part's weight as steadying it (it
  presses the part onto the bed, and its offset only counts when it lies outside the contact). Hanging, the bed
  interface and every section carry the weight of what was printed after them, in tension, while still warm.
  Engine patch 2 sets the search's gravity (`EngineGravity`): along the build direction, the bed check adds the
  whole weight as a tension on the interface (as the torque that loads its section modulus as much) and its
  offset always peels; each connection carries the part's weight above it in the slicer's frame (taken as
  `W · (1 − z_conn / z)`, uniform with height) the same way, from the first layer on (PrusaSlicer ignores the weight
  until 30 mm above a connection, for weight that presses down). Both still add the nozzle forces (10 gf, 65 gf
  over curled areas).
- **Sag goes towards the nozzle.** Unsupported extrusions (overhangs, bridges, floating extrusions) sag along +Z,
  away from the previous layer and into the next one's path, instead of drooping into the void. The overhang
  angle, bridge length and curl thresholds are the printer's row of the table below.
- **Curl and warp.** Gravity adds to an edge curling towards the nozzle (the curl factor) and to corners peeling
  off the plate: the warp score gets a peel term from the part's weight.
- **Supports hold in tension**, by what sticks at the interface: `weak-support-interface`.
- **Roofs over gaps sag away from the part beneath**, so the rule that a one-layer roof over a small gap fuses
  may not hold: `roof-gap` follows the row.
- **Which way up:** mass far from the plate behind a thin neck: `hanging-mass`.

| Row | Overhang (from vertical) | Bridge | Curl factor | Curl reported from | Roof fuses under | Status |
|---|---|---|---|---|---|---|
| `against_build` | 45° | 16 mm | 1.0 | 1 layer height | 0.2 mm | defaults with sources (below) |
| `along_build` (M1) | 35° | 10 mm | 1.5 | 0.5 layer height | 0.1 mm | **provisional, to calibrate on M1 prints** |

The M1 row is a guess made tighter than the upright one because sag goes towards the nozzle; none of it is
measured. Its messages end "(M1 threshold, to calibrate)". The upright row: 45° is the overhang rule of thumb and
PrusaSlicer/Orca's default support threshold region; 16 mm is the search's `bridge_distance`; the curl rule is the
search's (a curl of a layer height is a nozzle conflict); 0.2 mm is the usual print-in-place clearance for a
0.4 mm nozzle (a design rule of thumb, not a measurement).

The other hanging constants (`print_checks.cpp`), also **provisional, to calibrate on M1 prints**: a sideways sway
of 0.1 of the weight (`HANG_SWAY`), a reference stress of 0.1 MPa for a warm section (`HANG_REF_MPA`), and a peel
reference of 0.01 MPa (`PEEL_REF_MPA`).

## Orca's stability and support-issue search

`SupportSpotsGenerator::full_search` and `gather_issues` (libslic3r/Support), PrusaSlicer's search that Orca keeps
commented out, turned back on by an out-of-tree patch ([engine/PATCHES.md](../engine/PATCHES.md), patch 2). It
walks the layers bottom-up, builds the object's parts and their connections, and finds where extruding a line
breaks something: the part comes off the bed or its supports, a connection cracks, an extrusion has nothing under
it, a bridge is too long. Parameters are Orca's defaults (`SupportSpotsGenerator::Params`): the nozzle pushes
with **10 gf** (`standard_extruder_conflict_force`) and **65 gf over curled areas**
(`malformations_additive_conflict_extruder_force`), a bridge is long over **16 mm** (`bridge_distance`; the printer's row, see "Gravity"), the bed
adhesion and yield strength (33 MPa, ABS) are PrusaSlicer's. The curled areas come from
`SupportSpotsGenerator::estimate_malformations`, run for the search whatever the overhang settings.

| Orca cause | `kind` | `fix` |
|---|---|---|
| `SeparationFromBed` | `unstable-part` | `contact-area` |
| `UnstableFloatingPart` (and a part not connected to the bed) | `unstable-part` | `supports` |
| `FloatingExtrusion`, `FloatingBridgeAnchor` | `floating-extrusion` | `supports` |
| `LongBridge` | `long-bridge` | `supports` |
| `WeakObjectPart` | `weak-connection` | `orientation` |

With supports on (`enable_support`), the causes supports fix (`FloatingExtrusion`, `FloatingBridgeAnchor`,
`LongBridge`, `UnstableFloatingPart`, a part not connected to the bed) are not reported: PrusaSlicer only raises
them while supports are off. Hanging, the supports' hold is checked instead (`weak-support-interface`).

Severity is `gather_issues`'s (PrusaSlicer's alert rules): `critical` where it marks the cause critical,
`warning` where it reports it, `info` for points of a cause it does not report. `value` is the destabilising force
in grams-force, for the object-level causes.

Source: PrusaSlicer, `src/libslic3r/SupportSpotsGenerator.cpp` (2.6 onwards; checked against 2.9.2), where the
same search drives the "Detected print stability issues" notification.

## Curled overhangs

From the same `estimate_malformations`: each perimeter line's estimated curl height above its layer
(`Layer::curled_lines`), Prusa's model of overhangs lifting as they cool. A run of layers whose highest curl is at
least the row's curl threshold (times the row's curl factor) is one issue, at its highest curl: `warning` from 3
layer heights, else `info`. Where Orca's *Slow down for curled perimeters* (`slowdown_for_curled_perimeters`) is on,
Orca already slows exactly these lines (the same estimate drives it) and the issue is `info`: the estimate is
geometric, so slowing down does not make it go away. `value` is the curl height (mm). Fix: `slower-outer-walls`
(the app turns on Orca's overhang slow-down and curled-perimeter slow-down, and slows the outer walls).

Source: PrusaSlicer `SupportSpotsGenerator::estimate_malformations` and Orca's "Slow down for curled perimeters"
(`PrintObject::estimate_curled_extrusions`).

## Warp risk per first-layer island

A part warps when its first layer shrinks while the bed holds it: the stress grows with the length that shrinks,
concentrates at sharp corners, and is set by how far the part cools below the temperature where the polymer stops
flowing. For each island of the first layer:

```
score = L · s · (1 + θ/π) · c · b · r / 60
```

- `L`: the island's length, the diagonal of its bounding box (mm);
- `s`: linear shrinkage (%) — Orca's *Shrinkage (XY)* (`filament_shrink`) when set below 100 %, else the
  material table;
- `θ`: the sharpest convex corner of the outline, as its turning angle (a square's corners are π/2; corners
  turning less than 30° are facets of a curve and do not count);
- `c = clamp((T_g − T_chamber) / (T_g − 25 °C), 0.1, 1)`, with the chamber at `chamber_temperature` (25 °C when
  unset): a warm chamber lowers the stress;
- `b = 1 / (1 + brim / 5 mm)` for an outer brim of that width (no reduction for an auto brim, whose width Orca
  decides later); `r = 0.5` on a raft;
- hanging only (`along_build`): a peel term, the score times `1 + (W / A₁) / 0.01 MPa`, with `W` the part's weight
  and `A₁` its first layer's area (provisional, to calibrate on M1 prints). Upright, the weight presses the first
  layer down and there is no such term.

`warning` from 1, `critical` from 2.5 (`value` is the score). The scale puts a 20 mm PLA cube near 0.2, a 100 mm
PLA plate at 1, and a 150 mm ABS plate in an open printer above 3. Fix: `brim`.

Sources: warp deformation growing with the shrinking length and the temperature drop — Wang, Xi and Jin, "A model
research for prototype warp deformation in the FDM process", *Int. J. Adv. Manuf. Technol.* 33 (2007) 1087–1096;
the chamber term is the usual thermal-strain argument (stress ∝ α·ΔT, with ΔT from the glass transition down to
the surroundings), and the corner term and the scale (60) are this engine's calibration, not a published model.

## Slenderness against the nozzle force

A tall thin part bends when the nozzle drags past it, and the next layers land off target (or it snaps). The part
is a cantilever fixed to the bed, pushed sideways at the layer being printed by the search's 10 gf nozzle force
(0.098 N). Its deflection at height `h`:

```
δ(h) = F/E · Σ (h − z_j)² · Δz_j / I_j      over the layers below
```

with `I_j` the smaller principal second moment of area of each layer's largest island (mm⁴, holes subtracted)
and `E` the material's modulus. The worst `δ` over the part is the issue: `warning` from 0.1 mm, `critical` from
0.4 mm; `value` is `δ` (mm). A 3 mm PLA pin 40 mm tall bends about 0.15 mm. Fix: `orientation` (lay it down).

Sources: Euler–Bernoulli cantilever deflection, δ = ∫ F (h − z)² / (E I(z)) dz — Gere and Goodno, *Mechanics of
Materials* (cantilever deflection by integration); the nozzle force: PrusaSlicer's `standard_extruder_conflict_force`.

## Thin features under 2 lines

A wall narrower than two outer-wall lines has no room for a perimeter pair; under one line it may not print at
all. On each layer, the parts of the slices that a morphological opening by one line width removes (the opening
by half a line width for under one line); pieces smaller than 3 line-widths² are corner slivers and are left out.
A run of layers is one issue: `warning` when some layer is under one line, else `info`; `value` is the number of
layers. Fix: `orientation`.

Source: the minimum printable feature width of 2× the extrusion width (one perimeter pair) — Orca/PrusaSlicer's
*Detect thin walls* and Arachne's `min_feature_size`; morphological opening as in Orca's `opening_ex`
(ClipperUtils).

## Overhangs steeper than the printer's angle

Each layer against the layer about 1 mm below it, grown by that height × tan(angle): what still sticks out is
steeper than the row's overhang angle (from vertical). Slivers under half a line wide are left out (a morphological
opening). A run of layers is one issue at its largest area (`value`, mm²), `warning`; not reported with supports on.
Fix: `supports`.

Source: the 45° overhang rule (the angle from vertical a layer can step out by about its own height) — e.g.
Redwood, Schöffer and Garret, *The 3D Printing Handbook* (3D Hubs, 2017), "overhangs"; Orca/PrusaSlicer's
overhang detection works the same way, by the area outside the layer below grown by an allowance.

## Roofs over print-in-place gaps

Where a layer's area is not over the layer below (a roof's first layer) and the part is there again within 1 mm
under it, the roof closes a gap of that height. Upright, a one-layer roof droops into a gap under the row's limit
and fuses with the part beneath. Hanging, it sags away from the part beneath, so whether it fuses is open: the M1
row's limit is provisional, to calibrate. `warning` (`value`: the gap, mm). Fix: `orientation` (turn the gap
upright).

Source: the print-in-place clearance rule of thumb (about 0.2–0.3 mm between parts for a 0.4 mm nozzle, from
print-in-place design guides); a design rule, not a measurement, and this engine's choice of 0.2 mm.

## Hanging mass behind a thin neck

Only with gravity along the build direction. Each section carries everything printed after it, while still warm.
Its stress is the weight over its area plus the bending of that weight's offset and of a sideways sway on a round
section of the same area:

```
σ = W / A · (1 + 4 (e + k L) / r)
```

- `W`: the weight printed after the section (the search's density); `A`, `r = √(A/π)`: the section's area and
  equivalent radius; `e`: the horizontal offset of the hanging mass's centroid; `L`: its distance from the section;
- `k = 0.1`: the sideways load from the moves, as a fraction of the weight (provisional).

The worst section is the issue when `σ / 0.1 MPa` reaches 0.3 (`warning`), `critical` from 1 (provisional); `value`
is that ratio. A 30 mm block on a 4 mm stem 30 mm tall is critical. Fix: `orientation` (print the heavy end first,
near the plate).

Sources: axial and bending stress of a section, σ = N/A + M c / I, with I = π r⁴ / 4 — Gere and Goodno,
*Mechanics of Materials*; the thresholds are this engine's, to calibrate on M1 prints.

## Weak support interfaces (hanging)

Only with gravity along the build direction and supports on. Upright, supports push an overhang up; hanging, they
hold it in tension, by what sticks at the interface. One issue per object, at the lowest point the supports hold
(`value`: how many support points the search found), when the interface leaves little to stick: a top Z
distance of half a layer or more (`critical` from a whole layer), no top interface layers, or interface lines
further apart than a line width (`warning`). Provisional rule, to calibrate on M1 prints. Fix: `support-interface`
(the app sets the top Z distance to 0, three dense interface layers; supports then come off harder).

Source: this engine's; the support settings are Orca's (`support_top_z_distance`, `support_interface_top_layers`,
`support_interface_spacing`).

## Layer-time bond index

Each G-code layer's time (the processor's normal-mode estimate, with Orca's slow-down already applied) against the
material's minimum layer time (`slow_down_layer_time`):

```
B = t_layer / t_min
```

- `B < 1`: Orca could not slow down enough (minimum speed reached); the layer is printed on one that is still
  soft. `warning` below 0.5, else `info`.
- `B > 30` for materials printed hot (ABS, ASA, PC, PA, HIPS, PP): the layer below has cooled far below its
  welding temperature, and the bond is weaker (`info`).

A run of layers is one issue (`value` is the run's lowest, or highest, `B`). Fix: `slower-outer-walls`.

Sources: interlayer bond strength against the time the previous layer cools — Sun, Rizvi, Bellehumeur and Gu,
"Effect of processing conditions on the bonding quality of FDM polymer filaments", *Rapid Prototyping Journal* 14
(2008) 72–80; minimum layer time for cooling — Orca's `slow_down_layer_time` and its tooltip.

## Material table

| Type | Shrinkage (%) | T_g / softening (°C) | E (MPa) |
|---|---|---|---|
| PLA | 0.3 | 60 | 3500 |
| PETG, PET | 0.4 | 80 | 2100 |
| PCTG | 0.4 | 85 | 1900 |
| ABS | 0.7 | 105 | 2200 |
| ASA | 0.6 | 100 | 2000 |
| HIPS | 0.6 | 100 | 1900 |
| PC | 0.7 | 147 | 2300 |
| PA | 1.2 | 70 | 1500 |
| PP | 1.5 | 100 | 1300 |
| TPU | 0.5 | 60 | 30 |
| PVA | 0.5 | 75 | 2000 |

The filament's `filament_type` picks the row by its longest matching prefix (`PLA-CF` is PLA, `PA6-GF` is PA);
unknown types are PLA. Values are typical datasheet figures for printed parts (manufacturers' TDS: Prusament,
Polymaker, BASF Ultrafuse; mould shrinkage for the shrinkage column) and are meant to rank risks, not predict them.

## Fixture coverage

`test/printChecks.test.ts` runs on both the single-threaded and multithreaded engines. It requires these
issues to appear, checks their layer, position, severity and message, and verifies that enabling checks leaves
G-code unchanged:

| Fixture | Required issues |
|---|---|
| Tall pin (Ø3 × 40 mm) | Slenderness, unstable part, minimum layer time |
| Bridge (52 mm deck) | Long bridge, floating extrusion |
| Mushroom (Ø40 cap) | Curled overhang, floating extrusion, unstable part |
| Large ABS plate (150 × 130 mm) | Warp risk |
| Thin wall (0.6 mm) | Thin feature under two lines |
| Broad foot with a 1 mm neck and a tapered tall pin | Weak connection |

The taper on the weak-neck fixture avoids an unsupported cap: support spots proposed for such a cap would
reinforce the search's virtual connection before it evaluates the nozzle load.
