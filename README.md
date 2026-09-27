# Muon3D Slicer Engine (based on OrcaSlicer)

The Muon3D Slicer Engine is OrcaSlicer's slicing core (libslic3r) compiled to WebAssembly, with a Web Worker host
that any web page can drive through a documented message protocol. It is a derivative of
[OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer) and is licensed under the AGPL-3.0. The Muon3D Slicer web
app uses it; so can anything else that speaks the protocol in [`packages/protocol`](packages/protocol).

Nothing is re-implemented: the engine runs Orca's own C++ (walls, infill, supports, seams, G-code, time estimates,
exclusion volumes), built out of tree from an unmodified Orca checkout, and follows the path Orca's command-line
slicer takes for one plate. It takes Orca presets and placed meshes, and returns the G-code, Orca's print
statistics, toolpaths for a preview, and Orca's warnings and error codes.

**Status:** pre-release. The host speaks protocol v1; protocol v2 (a documented envelope, handshake and
capabilities, and a settings service) is next. Releases, each with its complete source, are on
[GitHub Releases](https://github.com/Muon-3D/muon3d-slicer-engine/releases); the rolling `edge` prerelease follows
`main`. Or build it from source as below.

## What is here

```
engine/              the C++ bridge, the out-of-tree CMake build of libslic3r, shims, stubs, dependency scripts
orca/                submodule: OrcaSlicer, branch muon3d-wasm of github.com/Muon-3D/OrcaSlicer, at a tagged pin
host/                the Web Worker host (TypeScript) and its build; host/src/settings: Orca's settings rules
packages/protocol/   @muon3d/slicer-engine-protocol: the protocol types (Apache-2.0)
tools/               settings-catalogue/ (the settings catalogue generator), check-imports.mjs, release/ (release
                     assets, notices, offline rebuild), ci/ (the Linux toolchain)
data/                settings-catalogue.json: every Orca option, laid out as Orca's settings tabs
test/                engine tests (Node), preset fixtures, test helpers
examples/node-cli/   slice from the command line through the host
docs/                BUILD.md (Linux, offline rebuilds, CI), RELEASING.md, the original engine spec, research notes
.github/             workflows: build (PRs, main, the edge prerelease), release, toolchain cache, upstream canary
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
npm test                             # host, settings rules and catalogue, engine (st)
npm run test:engine                  # engine tests on both variants
npm run check                        # nothing imported from outside the repository; type check
node examples/node-cli/slice.mjs --cube 20 -o cube.gcode
```

## Using it from a web page

`dist/` is the runtime, served as it is:

| File | What |
|---|---|
| `manifest.json` | Orca version and commit, per variant the files, sizes and sha256, and the host (`EngineManifest`) |
| `host.<hash>.js` | the worker host, an ES module worker script |
| `engine-st.mjs`, `engine-st.wasm` | the single-threaded engine: works in every current browser |
| `engine-mt.mjs`, `engine-mt.wasm` | the multithreaded engine: needs a cross-origin isolated page (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`) |
| `*.br`, `*.gz` | precompressed copies a server can send as they are |
| `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md`, `SOURCE.md` | the licence, the notices (ours and the third-party components'), and where the source of this build is |

```js
const base = '/engine/';                                   // wherever dist/ is served
const manifest = await (await fetch(base + 'manifest.json')).json();
const worker = new Worker(base + manifest.host.file, { type: 'module' });
worker.postMessage({ type: 'init', baseUrl: new URL(base, location.href).href, variant: crossOriginIsolated ? 'mt' : 'st' });
// on { type: 'ready' }:
worker.postMessage({ type: 'slice', id: '1', job: { machine, process, filaments: [filament], objects: [{ name: 'Cube.stl', positions }] } });
// then 'progress' and 'warning' messages, and 'sliced' (G-code, stats, toolpaths) or 'failed' (Orca's code and message)
```

The page starts the host by URL and talks to it only with messages; it never imports or bundles engine code. The
types of every message are in [`packages/protocol/src/v1.ts`](packages/protocol/src/v1.ts), and
[`examples/node-cli`](examples/node-cli) is a complete client in one short file. A project that serves a
local build of this repository points at the `dist/` folder of its clone (for example through an `ENGINE_DIR`
setting of its own) after `npm run build` here.

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
