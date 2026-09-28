# node-cli: slice from the command line

Slices a model with the built engine, with no web page involved. `slice.mjs` starts the engine host from `dist/`
(the same `host.<hash>.js` a browser starts) in a Node worker thread (`../start-host.mjs`) and drives it through
protocol v2 with the protocol package's client (`EngineConnection` over `nodeWorkerTransport`): `hello`, `load`,
then `slice`, and it writes the G-code it gets back.

```bash
npm run build                                                       # the engine and the host, into dist/
node examples/node-cli/slice.mjs --cube 20 --at 100,90 -o cube.gcode
node examples/node-cli/slice.mjs model.stl --variant mt
node examples/node-cli/slice.mjs model.stl --presets my-presets.json -o model.gcode
node examples/node-cli/slice.mjs --cube 20 --dist muon3d-slicer-engine-0.2.0   # a release's runtime folder
```

The presets are one JSON file with `machine`, `process` and `filaments` (an array), each an Orca preset flattened
the way Orca's CLI takes it (inheritance resolved, `from: "system"`, a `type`, no `inherits`); see
`test/fixtures/presets/` for two. The model is centred on the bed (or on `--at x,y`) and rests on it; the object is
named after the file, as Orca's CLI names it. `--help` lists every option.

Errors come back as Orca's own codes and messages, for example a cube in the M1's front keep-out zone:

```
slice: Orca refused the job (code -64): Cube.stl intersects an exclusion volume for extruder 1.
```
