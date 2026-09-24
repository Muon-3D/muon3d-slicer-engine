#!/usr/bin/env bash
# =====================================================================================================
# build.sh: configure and build the browser engine for one variant, then publish it into the web app.
#
#   VARIANT=st bash engine/scripts/build.sh            # single-threaded engine
#   VARIANT=mt bash engine/scripts/build.sh            # pthreads + oneTBB engine
#   VARIANT=st bash engine/scripts/build.sh libslic3r  # build other targets only; nothing is published
#   NINJA_ARGS="-k 0" VARIANT=st bash engine/scripts/build.sh libslic3r   # keep going after errors
#
# Needs the dependency prefix from engine/deps/build-deps.sh for the same variant.
#
# Output:
#   $ORCA_WASM_ROOT/build-$VARIANT/out/engine-$VARIANT.{mjs,wasm}   (+ .mjs.symbols)
#   web/public/engine/engine-$VARIANT.{mjs,wasm} and web/public/engine/manifest.json (EngineManifest in
#   web/src/engine/protocol.ts; the other variant's entry is kept if it was built from the same commit).
#
# Environment:
#   VARIANT         st (default) or mt
#   ORCA_WASM_ROOT  default ~/OrcaWasm: prefixes in prefix-$VARIANT, build tree in build-$VARIANT
#   ORCA_SRC        default $ORCA_WASM_ROOT/orca (read only)
#   JOBS            parallel jobs (default: all cores)
#   NINJA_ARGS      extra arguments for ninja, e.g. "-k 0"
#   EM_CACHE        default: the emsdk's own cache (must be on the same drive as the build tree)
# =====================================================================================================
set -euo pipefail

VARIANT=${VARIANT:-st}
[[ $VARIANT == st || $VARIANT == mt ]] || { echo "VARIANT must be st or mt" >&2; exit 2; }
JOBS=${JOBS:-$(nproc)}
TARGETS=("$@")
read -r -a NINJA_EXTRA <<< "${NINJA_ARGS:-}"

# Mixed-style paths (X:/...) throughout: native Windows tools (cmake, emcc, ninja) get them unconverted.
ENGINE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -W)
REPO_DIR=$(cd "$ENGINE_DIR/.." && pwd -W)
ORCA_WASM_ROOT=$(cygpath -m "${ORCA_WASM_ROOT:-$HOME/OrcaWasm}")
ORCA_SRC=$(cygpath -m "${ORCA_SRC:-$ORCA_WASM_ROOT/orca}")
PREFIX=$ORCA_WASM_ROOT/prefix-$VARIANT
BUILD=$ORCA_WASM_ROOT/build-$VARIANT
PUBLISH=$REPO_DIR/web/public/engine
INITIAL_CACHE=$PREFIX/share/orcawasm/initial-cache.cmake

# ---- Toolchain environment (same as engine/deps/build-deps.sh) ------------------------------------------
# emsdk 6 on Windows ships .exe launchers that Git Bash runs directly; no need to source emsdk_env.sh.
# The Program Files CMake (3.31) must come before Strawberry Perl's older one.
export EMSDK=$ORCA_WASM_ROOT/emsdk
export EM_CONFIG=$EMSDK/.emscripten
export EM_CACHE=$(cygpath -m "${EM_CACHE:-$EMSDK/upstream/emscripten/cache}")
EMSDK_NODE_DIR=$(ls -d "$EMSDK"/node/*_64bit 2>/dev/null | sort -V | tail -1)
EMSDK_PY_DIR=$(ls -d "$EMSDK"/python/*_64bit 2>/dev/null | sort -V | tail -1)
export EMSDK_NODE=$EMSDK_NODE_DIR/node.exe
export EMSDK_PYTHON=$EMSDK_PY_DIR/python.exe
export PATH="$(cygpath -u "$EMSDK/upstream/emscripten"):$(cygpath -u "$EMSDK_NODE_DIR"):/c/Program Files/CMake/bin:$PATH"

command -v emcc >/dev/null || { echo "emcc not found under $EMSDK" >&2; exit 1; }
command -v ninja >/dev/null || { echo "ninja not on PATH" >&2; exit 1; }
[[ -f $INITIAL_CACHE ]] || {
  echo "Missing $INITIAL_CACHE: build the dependencies first (VARIANT=$VARIANT bash engine/deps/build-deps.sh)." >&2
  exit 1
}
[[ -f $ORCA_SRC/src/libslic3r/CMakeLists.txt ]] || { echo "ORCA_SRC=$ORCA_SRC is not an Orca source tree" >&2; exit 1; }

# ---- Orca commit ------------------------------------------------------------------------------------------
# Compiled into the engine (version() -> the worker's `ready` message) and written to the manifest, from
# this one value. The published engine must correspond to a commit (AGPL source offer), so say when not.
ORCA_COMMIT=$(git -C "$ORCA_SRC" rev-parse HEAD)
if [[ -n $(git -C "$ORCA_SRC" status --porcelain --untracked-files=no -- src deps_src resources version.inc) ]]; then
  ORCA_COMMIT="$ORCA_COMMIT-dirty"
  echo "warning: $ORCA_SRC has uncommitted changes; the engine reports $ORCA_COMMIT" >&2
fi

# ---- Configure + build ------------------------------------------------------------------------------------
echo "==== engine $VARIANT: $ORCA_SRC ($ORCA_COMMIT) -> $BUILD"
# -G Ninja is required: emcmake would otherwise pick "MinGW Makefiles" (Strawberry's make is on PATH).
# Configuring on every run keeps ORCA_COMMIT and the source list parsed from Orca's CMakeLists current.
emcmake cmake -C "$INITIAL_CACHE" -G Ninja -S "$ENGINE_DIR" -B "$BUILD" \
  -DORCA_SRC="$ORCA_SRC" -DENGINE_VARIANT="$VARIANT" -DORCA_COMMIT="$ORCA_COMMIT"

if (( ${#TARGETS[@]} )); then
  cmake --build "$BUILD" -j "$JOBS" --target "${TARGETS[@]}" -- "${NINJA_EXTRA[@]}"
  echo "OK: built ${TARGETS[*]} (not published)"
  exit 0
fi
cmake --build "$BUILD" -j "$JOBS" --target orca_engine -- "${NINJA_EXTRA[@]}"

# ---- Publish into web/public/engine ------------------------------------------------------------------------
OUT=$BUILD/out
MJS=engine-$VARIANT.mjs
WASM=engine-$VARIANT.wasm
for f in "$MJS" "$WASM"; do [[ -f $OUT/$f ]] || { echo "Build did not produce $OUT/$f" >&2; exit 1; }; done
mkdir -p "$PUBLISH"
cp "$OUT/$MJS" "$OUT/$WASM" "$PUBLISH/"

# orcaVersion: SoftFever_VERSION from the generated libslic3r_version.h, i.e. what the G-code header says.
ORCA_VERSION=$(sed -n 's/^#define SoftFever_VERSION "\(.*\)"/\1/p' "$BUILD/libslic3r/libslic3r_version.h")
WASM_BYTES=$(stat -c %s "$OUT/$WASM")

# Merge into manifest.json. An entry for the other variant survives only if it was built from the same
# Orca commit; otherwise it would be described by the wrong orcaVersion/orcaCommit.
MANIFEST=$PUBLISH/manifest.json MANIFEST_VARIANT=$VARIANT MANIFEST_MJS=$MJS MANIFEST_WASM=$WASM \
MANIFEST_WASM_BYTES=$WASM_BYTES MANIFEST_ORCA_VERSION=$ORCA_VERSION MANIFEST_ORCA_COMMIT=$ORCA_COMMIT \
node - <<'EOF'
const fs = require('fs');
const e = process.env;
let previous = null;
try { previous = JSON.parse(fs.readFileSync(e.MANIFEST, 'utf8')); } catch { /* none yet */ }
const sameBuild = previous && previous.orcaCommit === e.MANIFEST_ORCA_COMMIT && previous.orcaVersion === e.MANIFEST_ORCA_VERSION;
if (previous && !sameBuild && Object.keys(previous.variants || {}).some((v) => v !== e.MANIFEST_VARIANT))
  console.warn(`warning: dropping variants built from ${previous.orcaCommit} from manifest.json`);
const manifest = {
  orcaVersion: e.MANIFEST_ORCA_VERSION,
  orcaCommit: e.MANIFEST_ORCA_COMMIT,
  builtAt: new Date().toISOString(),
  variants: {
    ...(sameBuild ? previous.variants : {}),
    [e.MANIFEST_VARIANT]: { mjs: e.MANIFEST_MJS, wasm: e.MANIFEST_WASM, wasmBytes: Number(e.MANIFEST_WASM_BYTES) },
  },
};
fs.writeFileSync(e.MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
EOF

echo "OK: published $MJS + $WASM ($WASM_BYTES bytes) to $PUBLISH (Orca $ORCA_VERSION @ $ORCA_COMMIT)"
