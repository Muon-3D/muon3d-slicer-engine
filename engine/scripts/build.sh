#!/usr/bin/env bash
# =====================================================================================================
# build.sh: configure and build the browser engine for one variant, then publish it into dist/.
#
#   bash engine/scripts/build.sh st                    # single-threaded engine (or VARIANT=st, the default)
#   bash engine/scripts/build.sh mt                    # pthreads + oneTBB engine
#   bash engine/scripts/build.sh st libslic3r          # build other targets only; nothing is published
#   NINJA_ARGS="-k 0" bash engine/scripts/build.sh st libslic3r   # keep going after errors
#   npm run build:engine [-- st|mt]                    # the same from npm, on any shell (both variants by default)
#
# Needs the orca/ submodule (scripts/get-orca.sh) and the dependency prefix from engine/deps/build-deps.sh
# for the same variant; the whole sequence from an empty machine is in engine/scripts/README.md.
#
# Output:
#   $ENGINE_BUILD/out/engine-$VARIANT.{mjs,wasm}   (+ .mjs.symbols)
#   dist/engine-$VARIANT.{mjs,wasm}, their precompressed .br/.gz (scripts/compress.mjs), and
#   dist/manifest.json (EngineManifest in packages/protocol/src/v1.ts; the other variant's entry is kept if
#   it was built from the same Orca commit, and so is the host entry that host/build.mjs writes).
#
# Environment:
#   VARIANT         st (default) or mt; a first argument st|mt takes precedence
#   ORCA_WASM_ROOT  default ~/OrcaWasm (no spaces): prefixes in prefix-$VARIANT
#   ORCA_SRC        default: the orca/ submodule (read only)
#   ENGINE_DIST     where to publish, default dist/ in this repository
#   ORCA_EMSDK      default $ORCA_WASM_ROOT/emsdk (scripts/toolchain.sh)
#   ENGINE_BUILD    build tree, default $ORCA_WASM_ROOT/build-$VARIANT
#   JOBS            parallel jobs (default: all cores)
#   NINJA_ARGS      extra arguments for ninja, e.g. "-k 0"
#   EM_CACHE        default: the emsdk's own cache (must be on the same drive as the build tree)
# =====================================================================================================
set -euo pipefail

if [[ ${1:-} == st || ${1:-} == mt ]]; then VARIANT=$1; shift; fi
VARIANT=${VARIANT:-st}
[[ $VARIANT == st || $VARIANT == mt ]] || { echo "VARIANT must be st or mt" >&2; exit 2; }
JOBS=${JOBS:-$(nproc)}
TARGETS=("$@")
read -r -a NINJA_EXTRA <<< "${NINJA_ARGS:-}"

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=toolchain.sh
source "$SCRIPT_DIR/toolchain.sh"
# Mixed-style paths (X:/...) throughout: native Windows tools (cmake, emcc, ninja) get them unconverted.
ENGINE_DIR=$(dir_path "$SCRIPT_DIR/..")
REPO_DIR=$(dir_path "$ENGINE_DIR/..")
ORCA_WASM_ROOT=$(mixed_path "${ORCA_WASM_ROOT:-$ORCAWASM_DEFAULT_ROOT}")
check_root "$ORCA_WASM_ROOT"
ORCA_SRC=$(mixed_path "${ORCA_SRC:-$REPO_DIR/orca}")
PREFIX=$ORCA_WASM_ROOT/prefix-$VARIANT
BUILD=$(mixed_path "${ENGINE_BUILD:-$ORCA_WASM_ROOT/build-$VARIANT}")
PUBLISH=$(mixed_path "${ENGINE_DIST:-$REPO_DIR/dist}")
INITIAL_CACHE=$PREFIX/share/orcawasm/initial-cache.cmake

# ---- Toolchain environment (same as engine/deps/build-deps.sh) ------------------------------------------
setup_emsdk
check_emcc 6.0.10
[[ -f $INITIAL_CACHE ]] || {
  echo "Missing $INITIAL_CACHE: build the dependencies first (VARIANT=$VARIANT bash engine/deps/build-deps.sh)." >&2
  exit 1
}
[[ -f $ORCA_SRC/src/libslic3r/CMakeLists.txt ]] || {
  echo "ORCA_SRC=$ORCA_SRC is not an Orca source tree (get the orca/ submodule: bash engine/scripts/get-orca.sh)" >&2
  exit 1
}

# ---- Orca commit ------------------------------------------------------------------------------------------
# Compiled into the engine (version() -> the worker's `ready` message) and written to the manifest, from
# this one value. The published engine must correspond to a commit (AGPL source offer), so say when not.
ORCA_COMMIT=$(git -C "$ORCA_SRC" rev-parse HEAD)
if [[ -n $(git -C "$ORCA_SRC" status --porcelain --untracked-files=no -- src deps_src resources version.inc) ]]; then
  ORCA_COMMIT="$ORCA_COMMIT-dirty"
  echo "warning: $ORCA_SRC has uncommitted changes; the engine reports $ORCA_COMMIT" >&2
fi
# shellcheck source=orca/pin.sh
source "$SCRIPT_DIR/orca/pin.sh"
if [[ ${ORCA_COMMIT%-dirty} != "$ORCA_PINNED_COMMIT" ]]; then
  echo "warning: $ORCA_SRC is at ${ORCA_COMMIT%-dirty}, not at the pinned $ORCA_PINNED_COMMIT (the orca/" \
       "submodule), so nobody else can get this source: push and tag it on the fork, then commit the pin." >&2
fi

# ---- Configure + build ------------------------------------------------------------------------------------
echo "==== engine $VARIANT: $ORCA_SRC ($ORCA_COMMIT) -> $BUILD"
# -G Ninja is required: emcmake would otherwise pick "MinGW Makefiles" (Strawberry's make is on PATH).
# Configuring on every run keeps ORCA_COMMIT and the source list parsed from Orca's CMakeLists current.
# The prefix's flags are cache entries, which -C does not overwrite in a build tree configured before: when
# the initial cache has changed since (the prefix was rebuilt with other flags), configure afresh. The
# objects stay; ninja recompiles whatever the new flags change.
CACHE_STAMP=$BUILD/orcawasm-initial-cache.sha256
CACHE_HASH=$(sha256sum "$INITIAL_CACHE" | cut -d' ' -f1)
FRESH=()
if [[ -f $BUILD/CMakeCache.txt && $(cat "$CACHE_STAMP" 2>/dev/null) != "$CACHE_HASH" ]]; then
  echo "$INITIAL_CACHE changed since $BUILD was configured: configuring afresh."
  FRESH=(--fresh)
fi
# A build tree configured from another copy of engine/ (CMake refuses a second source directory): start
# the cache afresh. Every command line changes with the source path, so ninja then rebuilds everything.
CACHED_SOURCE=$(sed -n 's/^CMAKE_HOME_DIRECTORY:INTERNAL=//p' "$BUILD/CMakeCache.txt" 2>/dev/null || true)
if [[ -n $CACHED_SOURCE && $CACHED_SOURCE != "$ENGINE_DIR" ]]; then
  echo "$BUILD was configured from $CACHED_SOURCE, not $ENGINE_DIR: configuring afresh (full rebuild)."
  FRESH=(--fresh)
fi
emcmake cmake "${FRESH[@]}" -C "$INITIAL_CACHE" -G Ninja -S "$ENGINE_DIR" -B "$BUILD" \
  -DORCA_SRC="$ORCA_SRC" -DENGINE_VARIANT="$VARIANT" -DORCA_COMMIT="$ORCA_COMMIT"
echo "$CACHE_HASH" > "$CACHE_STAMP"

if (( ${#TARGETS[@]} )); then
  cmake --build "$BUILD" -j "$JOBS" --target "${TARGETS[@]}" -- "${NINJA_EXTRA[@]}"
  echo "OK: built ${TARGETS[*]} (not published)"
  exit 0
fi
cmake --build "$BUILD" -j "$JOBS" --target orca_engine -- "${NINJA_EXTRA[@]}"

# ---- Publish into dist/ ------------------------------------------------------------------------------------
OUT=$BUILD/out
MJS=engine-$VARIANT.mjs
WASM=engine-$VARIANT.wasm
for f in "$MJS" "$WASM"; do [[ -f $OUT/$f ]] || { echo "Build did not produce $OUT/$f" >&2; exit 1; }; done
mkdir -p "$PUBLISH"
cp "$OUT/$MJS" "$OUT/$WASM" "$PUBLISH/"
# <file>.br / <file>.gz, which a server can send instead of compressing on every request. Written after the
# files they compress, so a server that compares dates never takes a stale sibling.
node "$ENGINE_DIR/scripts/compress.mjs" "$PUBLISH/$MJS" "$PUBLISH/$WASM"

# orcaVersion: SoftFever_VERSION from the generated libslic3r_version.h, i.e. what the G-code header says.
ORCA_VERSION=$(sed -n 's/^#define SoftFever_VERSION "\(.*\)"/\1/p' "$BUILD/libslic3r/libslic3r_version.h")
WASM_BYTES=$(stat -c %s "$OUT/$WASM")
WASM_BR_BYTES=$(stat -c %s "$PUBLISH/$WASM.br")
SHA_MJS=$(sha256sum "$PUBLISH/$MJS" | cut -d' ' -f1)
SHA_WASM=$(sha256sum "$PUBLISH/$WASM" | cut -d' ' -f1)
# This repository's commit, for the bridge and the build recipe compiled into the engine; "-dirty" when
# engine/ has changes that are not committed (docs do not count).
ENGINE_COMMIT=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo unknown)
if [[ $ENGINE_COMMIT != unknown && -n $(git -C "$REPO_DIR" status --porcelain -- engine \
      ':(exclude)engine/research' ':(exclude,glob)engine/**/*.md') ]]; then
  ENGINE_COMMIT="$ENGINE_COMMIT-dirty"
fi

# Merge into manifest.json. An entry for the other variant survives only if it was built from the same
# Orca commit; otherwise it would be described by the wrong orcaVersion/orcaCommit. The host entry
# (written by host/build.mjs) is kept.
MANIFEST=$PUBLISH/manifest.json MANIFEST_VARIANT=$VARIANT MANIFEST_MJS=$MJS MANIFEST_WASM=$WASM \
MANIFEST_WASM_BYTES=$WASM_BYTES MANIFEST_WASM_BR_BYTES=$WASM_BR_BYTES MANIFEST_SHA_MJS=$SHA_MJS \
MANIFEST_SHA_WASM=$SHA_WASM MANIFEST_ENGINE_COMMIT=$ENGINE_COMMIT \
MANIFEST_ORCA_VERSION=$ORCA_VERSION MANIFEST_ORCA_COMMIT=$ORCA_COMMIT \
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
  ...(previous && previous.host ? { host: previous.host } : {}),
  variants: {
    ...(sameBuild ? previous.variants : {}),
    [e.MANIFEST_VARIANT]: {
      mjs: e.MANIFEST_MJS,
      wasm: e.MANIFEST_WASM,
      wasmBytes: Number(e.MANIFEST_WASM_BYTES),
      // What the server sends a browser that accepts brotli (the precompressed .br).
      wasmTransferBytes: Number(e.MANIFEST_WASM_BR_BYTES),
      // To check a rebuild, or a deployed copy, against this build.
      sha256: { mjs: e.MANIFEST_SHA_MJS, wasm: e.MANIFEST_SHA_WASM },
      engineCommit: e.MANIFEST_ENGINE_COMMIT,
    },
  },
};
fs.writeFileSync(e.MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
EOF

echo "OK: published $MJS + $WASM ($WASM_BYTES bytes, sha256 $SHA_WASM) to $PUBLISH"
echo "    Orca $ORCA_VERSION @ $ORCA_COMMIT, engine @ $ENGINE_COMMIT"
