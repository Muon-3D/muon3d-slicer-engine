# Slice job service

One slice per run, as its own process, for servers that slice on behalf of someone else. The first caller is the
agent-CAD MCP server in `muon3d-design` (KAN-908, the `slicer_slice` tool), which starts this program and exchanges
only files with it: a model in, G-code and JSON out. It never loads the engine. Licence: AGPL-3.0-only, like the rest
of this repository, and every answer carries the source offer (AGPL §13).

```
node service/slice-job.mjs --runtime <engine runtime folder> < job.json > answer.json
```

- **Job:** `{"model": {"format": "3mf" | "stl", "data": "<base64>"}, "preset": "muon3d-m1-0.4", "name": "part"}`.
- **Answer:** `{"ok": true, "stats": {layers, printTimeSeconds, printTimeText, filamentMm, filamentG, maxZ, ...},
  "gcode": "<base64>", "gcodeSha256", "warnings", "engine", "preset": {name, sha256, names}, "source", "timings"}`,
  or `{"ok": false, "error": {kind, message}, "source"}`. The exit code is 1 on failure.
- **Presets are frozen.** A caller names a file in `service/presets/` (flattened machine, process and filament, as in
  `test/fixtures/presets/`) and cannot change a setting. `muon3d-m1-0.4` is the M1 with a 0.4 mm nozzle, 0.20 mm
  Standard and Generic PLA.
- **Placement:** the model is centred on the printable area and dropped to z = 0, as `examples/node-cli` does.
- **3MF:** `threemf.mjs` reads the meshes of the build items with their transforms (Node's zlib, no dependencies).
  Components, colours and settings in the archive are ignored.
- **Runtime:** the engine runtime folder from a release tarball (`muon3d-slicer-engine-<v>/`), or `dist/` after a
  build. The agent-CAD server pins the same version as the Muon3D Slicer web app (`engine.lock.json` there).
- **Sandboxing** is the caller's job. The agent-CAD server runs this in a one-shot gVisor sandbox with no network,
  this repository and the runtime mounted read-only.

## Tests

```
SLICE_JOB_RUNTIME=<runtime folder> node --test service/slice-job.test.mjs
```

Real slices of real models: a 20 mm cube is 100 layers of 0.2 mm, the same cube as a 3MF slices to the same print,
a 30 mm part takes 150 layers, and bad presets, paths, models and formats are refused with the source offer.

## Browser against server

```
PLAYWRIGHT_CORE=<playwright-core> node service/compare-browser.mjs --runtime <runtime folder> [--out report.json] model.stl model.3mf ...
```

Slices each model with the same preset and the same placed triangles twice: through the engine in Node (as this
service runs it) and in headless Chromium, the host in a module Web Worker, driven by the protocol package as the
Muon3D Slicer web app drives it. It compares layer count, estimated time (±1 %), filament length (±0.5 %), G1 moves
per layer, and the G-code with the header lines that name a date or the generator taken out. The web app's own
steps after slicing (thumbnails, the keep-out scan) and its placement are not part of this comparison.
