#!/usr/bin/env bash
# =====================================================================================================
# rebuild-offline.sh: rebuilds one engine variant from a release's source assets alone, with no network and
# an empty Emscripten cache, and prints the sha256 of the result. Run inside the container of
# tools/release/offline/Dockerfile (the emsdk 6.0.10 image), as the release workflow does:
#
#   docker build -t engine-offline tools/release/offline
#   docker run --rm --network none -v "$PWD/assets:/in:ro" -v "$PWD/work:/work" engine-offline \
#     bash /work/rebuild-offline.sh st
#
# /in holds the three source assets of the release (muon3d-slicer-engine-<v>-source.tar.gz,
# orcaslicer-<commit>-source.tar.xz, third-party-sources-<key>.tar); /work is empty and writable. Writes the
# engine to /work/out-<variant>/ and its sha256 to /work/out-<variant>/SHA256. Compare them with
# variants.<variant>.sha256 in the release's manifest.json. docs/BUILD.md describes the same steps by hand.
# =====================================================================================================
set -euo pipefail

VARIANT=${1:?usage: rebuild-offline.sh st|mt}
IN=${IN:-/in}
WORK=${WORK:-/work}
EMSDK_DIR=${ORCA_EMSDK:-/emsdk}
die() { echo "rebuild-offline: $*" >&2; exit 1; }
one() { local f; f=$(compgen -G "$1") || die "no $1"; [[ $(wc -l <<<"$f") == 1 ]] || die "more than one $1"; echo "$f"; }

ENGINE_BUNDLE=$(one "$IN/muon3d-slicer-engine-*-source.tar.gz")
ORCA_BUNDLE=$(one "$IN/orcaslicer-*-source.tar.xz")
TP_BUNDLE=$(one "$IN/third-party-sources-*.tar")

if curl -fsS --max-time 5 -o /dev/null https://github.com 2>/dev/null; then
  echo "warning: the network is reachable; run the container with --network none for an offline check" >&2
fi

# ---- The sources ------------------------------------------------------------------------------------------------
rm -rf "$WORK/src" "$WORK/root" "$WORK/emcache" "$WORK/out-$VARIANT" "$WORK"/third-party-sources-*
mkdir -p "$WORK/src"
tar -xzf "$ENGINE_BUNDLE" -C "$WORK/src"
SRC=$(one "$WORK/src/muon3d-slicer-engine-*")
ORCA_COMMIT=$(sed -n 's/^orca=//p' "$SRC/SOURCE_COMMITS")
# git archive records the commit it was made from in the tar header: the Orca bundle must be the pinned commit.
BUNDLE_COMMIT=$(xz -dc "$ORCA_BUNDLE" | git get-tar-commit-id) || die "$ORCA_BUNDLE carries no commit id"
[[ $BUNDLE_COMMIT == "$ORCA_COMMIT" ]] || die "$ORCA_BUNDLE is commit $BUNDLE_COMMIT, SOURCE_COMMITS pins $ORCA_COMMIT"
tar -xJf "$ORCA_BUNDLE" -C "$SRC"
echo "sources: $(sed 's/$/ /' "$SRC/SOURCE_COMMITS" | tr -d '\n')"

tar -xf "$TP_BUNDLE" -C "$WORK"
TP=$(one "$WORK/third-party-sources-*")
(cd "$TP" && sha256sum --quiet -c SHA256SUMS) || die "$TP_BUNDLE: SHA256SUMS does not match"
mkdir -p "$WORK/root/deps-src/_archives"
cp "$TP"/deps/* "$WORK/root/deps-src/_archives/"

# ---- The toolchain: the image's emsdk, an empty cache, the ports from the mirror ---------------------------------
export ORCA_WASM_ROOT=$WORK/root ORCA_EMSDK=$EMSDK_DIR EM_CACHE=$WORK/emcache
mkdir -p "$EM_CACHE"
# A first emcc run writes the cache's sanity file; a cache without one is cleared on first use, ports and all.
PATH=$EMSDK_DIR/upstream/emscripten:$PATH emcc --check > /dev/null 2>&1 || true
NODE=$(ls -d "$EMSDK_DIR"/node/*_64bit | sort -V | tail -1)/bin/node
"$NODE" "$SRC/tools/release/emscripten-ports.mjs" seed "$EMSDK_DIR/upstream/emscripten" "$TP/emscripten-ports" "$EM_CACHE/ports"

# ---- Build: the same scripts as always ---------------------------------------------------------------------------
started=$SECONDS
bash "$SRC/engine/deps/fetch-deps.sh"
VARIANT=$VARIANT bash "$SRC/engine/deps/build-deps.sh"
deps_done=$SECONDS
ENGINE_DIST=$WORK/out-$VARIANT ENGINE_BUILD=$WORK/build-$VARIANT bash "$SRC/engine/scripts/build.sh" "$VARIANT"
(cd "$WORK/out-$VARIANT" && sha256sum "engine-$VARIANT.mjs" "engine-$VARIANT.wasm" | tee SHA256)
echo "rebuild-offline: $VARIANT done: dependencies $((deps_done - started)) s, engine $((SECONDS - deps_done)) s"
