# Muon3D Slicer Engine (based on OrcaSlicer)

The Muon3D Slicer Engine is OrcaSlicer's slicing core (libslic3r) compiled to WebAssembly, with a host that any
client can drive through a documented message protocol: a web page through a Web Worker, a Node program through a
worker thread, a server or an app runtime through a byte stream. It is a derivative of
[OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer) and is licensed under the AGPL-3.0. The Muon3D Slicer web
app uses it; so can anything else that speaks the protocol ([`docs/PROTOCOL.md`](docs/PROTOCOL.md),
[`packages/protocol`](packages/protocol)).

Nothing is re-implemented: the engine runs Orca's own C++ (walls, infill, supports, seams, G-code, time estimates,
exclusion volumes), built out of tree from an unmodified Orca checkout, and follows the path Orca's command-line
slicer takes for one plate. It takes Orca presets and placed meshes, and returns the G-code, Orca's print
statistics, toolpaths for a preview, and Orca's warnings and error codes. Its settings service gives Orca's
settings forms as documents: the tabs' layout for the mode and the printer, which settings Orca hides or greys out
for the current values, Orca's checks and questions, and what an edit changes along with it.

**Status:** pre-release (`0.x`). The host speaks **protocol v2**: a handshake with capabilities, the licence and
the source; slicing, placement checks, Orca's option table and settings catalogue; the settings service
(`settings.view`, `settings.edit`). Releases, each with its complete source, are on
[GitHub Releases](https://github.com/Muon-3D/muon3d-slicer-engine/releases); the rolling `edge` prerelease follows
`main`. Or build it from source as below.

## What is here

```
engine/               the C++ bridge, the out-of-tree CMake build of libslic3r, shims, stubs, dependency scripts
orca/                 submodule: OrcaSlicer, branch muon3d-wasm of github.com/Muon-3D/OrcaSlicer, at a tagged pin
host/                 the host (TypeScript) and its build: core.ts (ops, lifecycle, queues, cancel, progress),
                      worker.ts (the Web Worker and worker_threads entry), bridge.ts (the engine module),
                      settings/ (the settings service: Orca's rules, the tabs' layout, object and plate settings)
packages/protocol/    @muon3d/slicer-engine-protocol: protocol v2's types, transports and client (Apache-2.0)
docs/PROTOCOL.md      the protocol, normative
tools/                settings-catalogue/ (the catalogue generator), goldens/ (the settings goldens' recorders),
                      check-imports.mjs, release/ (release assets, notices, offline rebuild), ci/ (the toolchain)
data/                 settings-catalogue.json: every Orca option, laid out as Orca's settings tabs
test/                 engine tests, protocol conformance (test/conformance), settings and slice goldens
                      (test/goldens), preset fixtures, test helpers
examples/node-cli/    slice from the command line through the host
examples/settings-cli/ validate presets and print Orca's settings forms, through the settings service
docs/                 PROTOCOL.md, BUILD.md (Linux, offline rebuilds, CI), RELEASING.md, the original engine spec
.github/              workflows: build (PRs, main, the edge prerelease), release, toolchain cache, upstream canary
```

## Build and test

Needs Git Bash (Windows) or bash, CMake, Ninja, Node.js 22.18 or newer and Emscripten 6.0.10;
[`engine/scripts/README.md`](engine/scripts/README.md) has the details and the one-time dependency build.

```bash
git clone --recurse-submodules --shallow-submodules https://github.com/Muon-3D/muon3d-slicer-engine.git
cd muon3d-slicer-engine
npm ci
export ORCA_WASM_ROOT=~/OrcaWasm     # emsdk, dependency sources, prefixes, build trees (no spaces)
bash engine/deps/fetch-deps.sh
VARIANT=st bash "$PWD/engine/deps/build-deps.sh"
VARIANT=mt bash "$PWD/engine/deps/build-deps.sh"
npm run build                        # engine (st, then mt) and host, into dist/
npm test                             # protocol, host, settings service and goldens, conformance (no engine needed)
npm run test:engine                  # engine tests and the conformance suite's engine part, on both variants
npm run check                        # nothing imported from outside the repository (or the protocol package); types
node examples/node-cli/slice.mjs --cube 20 -o cube.gcode
node examples/settings-cli/settings.mjs --validate
```

The host alone (`npm run build:host`) needs no Emscripten: the settings service, and the whole protocol suite but
slicing, run without the engine.

## Using it

A release's runtime tarball (or `dist/` of a build) is served as it is:

| File | What |
|---|---|
| `manifest.json` | the host to start, the engine files with sizes and sha256, Orca version and commit, the source (`EngineManifest`) |
| `host.<hash>.js` | the host: an ES module a Web Worker or a Node worker thread runs |
| `host-*.<hash>.js` | scripts the host loads on demand (the settings service): `manifest.host.chunks` |
| `engine-st.mjs`, `engine-st.wasm` | the single-threaded engine: works in every current browser |
| `engine-mt.mjs`, `engine-mt.wasm` | the multithreaded engine: needs a cross-origin isolated page (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`) |
| `*.br`, `*.gz` | precompressed copies a server can send as they are |
| `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md`, `SOURCE.md` | the licence, the notices (ours and the third-party components'), and where the source of this build is |

```js
import { EngineConnection, workerTransport } from '@muon3d/slicer-engine-protocol';

const base = new URL('/engine/', location.href);                      // wherever the runtime is served
const manifest = await (await fetch(new URL('manifest.json', base))).json();
const worker = new Worker(new URL(manifest.host.file, base), { type: 'module' });
const engine = new EngineConnection(workerTransport(worker));
const hello = await engine.open({ name: 'my-app', version: '1.0.0' });   // protocol, engine, licence, source
const { gcode, stats, toolpaths } = await engine.request('slice', {
  configs: { machine, process, filaments: [filament] },
  objects: [{ name: 'Cube.stl', mesh: { positions } }],
});
```

The client starts the host by URL and talks to it only with messages; it never imports or bundles engine code. The
protocol package (a release asset, `muon3d-slicer-engine-protocol-<v>.tgz`, until it is on npm) has the types, the
transports and the client; [`docs/PROTOCOL.md`](docs/PROTOCOL.md) is enough to write a client without it.
[`examples/node-cli`](examples/node-cli) and [`examples/settings-cli`](examples/settings-cli) are complete
clients. A project that serves a local build of this repository points at the `dist/` folder of its clone (for
example through an `ENGINE_DIR` setting of its own) after `npm run build` here.

## Licence

The engine is free software under the GNU Affero General Public License, version 3 only (`LICENSE`). `NOTICE` gives
the copyright holders and the lineage, and [`SOURCE.md`](SOURCE.md) says what the Corresponding Source of a build is
and where to get it. [`packages/protocol`](packages/protocol) is a separate work under the Apache License 2.0.
Contributions: see [`CONTRIBUTING.md`](CONTRIBUTING.md) (DCO sign-off).

## Acknowledgements

- [OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer) and the projects it builds on: Bambu Studio, PrusaSlicer,
  Slic3r, SuperSlicer and CuraEngine's Arachne wall generator.
- [Hiosdra/OrcaWasm](https://github.com/Hiosdra/OrcaWasm), which showed OrcaSlicer compiles to WebAssembly: the serial
  TBB shim in `engine/shims/tbb-serial` is derived from its shim, and its notes on threads and Arachne saved much
  time.
- [lolookw/ipad-slicer](https://github.com/lolookw/ipad-slicer), for ideas about loading the engine and the headers
  a page needs. No code was taken from it.

"OrcaSlicer" names the project this engine derives from. The OrcaSlicer project has not made, endorsed or reviewed
this engine.
