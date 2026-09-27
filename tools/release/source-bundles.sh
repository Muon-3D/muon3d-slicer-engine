#!/usr/bin/env bash
# =====================================================================================================
# source-bundles.sh: the source assets of a release, so that the release can be rebuilt without anything
# but these files and the toolchain (docs/BUILD.md, "From a release's source assets"):
#
#   muon3d-slicer-engine-<version>-source.tar.gz   this repository at HEAD (git archive), plus SOURCE_COMMITS
#                                                  naming this commit, the Orca commit and its tag
#   orcaslicer-<commit10>-source.tar.xz            the Orca tree at the pinned commit (git archive of orca/),
#                                                  under orca/: extract it into the folder above
#   third-party-sources-<key>.tar                  every third-party source archive the build uses: those in
#                                                  engine/deps/SHA256SUMS (GMP/MPFR aside, which the default
#                                                  build does not use), the Emscripten ports zlib and libpng,
#                                                  and any npm package bundled into the host
#   sources.json                                   file name, sha256 and size of the three (for assemble.mjs)
#
#   ORCA_WASM_ROOT=~/OrcaWasm bash tools/release/source-bundles.sh <out dir> <version>
#
# Needs: a clean checkout at the release commit with the orca/ submodule at the pin, the archives fetched
# (bash engine/deps/fetch-deps.sh), the emsdk (for the ports' URLs and hashes), GNU tar, gzip, xz and node.
# HOST_METAFILE: esbuild's metafile of the host build (host/build.mjs), to find bundled npm packages.
# =====================================================================================================
set -euo pipefail

OUT=${1:?usage: source-bundles.sh <out dir> <version>}
VERSION=${2:?usage: source-bundles.sh <out dir> <version>}
REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ORCA_WASM_ROOT=${ORCA_WASM_ROOT:-$HOME/OrcaWasm}
EMSCRIPTEN=${ORCA_EMSDK:-$ORCA_WASM_ROOT/emsdk}/upstream/emscripten
ARCHIVES=$ORCA_WASM_ROOT/deps-src/_archives
die() { echo "source-bundles: $*" >&2; exit 1; }

# shellcheck source=../../engine/scripts/orca/pin.sh
source "$REPO_DIR/engine/scripts/orca/pin.sh"
ENGINE_COMMIT=$(git -C "$REPO_DIR" rev-parse HEAD)
[[ -z $(git -C "$REPO_DIR" status --porcelain --untracked-files=no) ]] || die "$REPO_DIR has uncommitted changes"
[[ $(git -C "$REPO_DIR/orca" rev-parse HEAD) == "$ORCA_PINNED_COMMIT" ]] || die "orca/ is not at the pin $ORCA_PINNED_COMMIT"
[[ -f $EMSCRIPTEN/tools/ports/zlib.py ]] || die "no emsdk at $EMSCRIPTEN (set ORCA_EMSDK)"
EM_VERSION=$(tr -d '"[:space:]' < "$EMSCRIPTEN/emscripten-version.txt")
# Reproducible archives: fixed order, owner and times (the commit's time).
EPOCH=$(git -C "$REPO_DIR" log -1 --format=%ct)
TAR=(tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$EPOCH" --format=gnu)
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# ---- This repository ----------------------------------------------------------------------------------------
ENGINE_NAME=muon3d-slicer-engine-$VERSION
ENGINE_FILE=$ENGINE_NAME-source.tar.gz
# SOURCE_COMMITS lets the scripts build from the bundle, which is not a git checkout (engine/scripts/orca/pin.sh).
git -C "$REPO_DIR" archive --format=tar --prefix="$ENGINE_NAME/" \
  --add-virtual-file="$ENGINE_NAME/SOURCE_COMMITS:engine=$ENGINE_COMMIT
orca=$ORCA_PINNED_COMMIT
orca_tag=$ORCA_TAG
version=$VERSION
" HEAD | gzip -n -9 > "$OUT/$ENGINE_FILE"
tar -tzf "$OUT/$ENGINE_FILE" | grep -qx "$ENGINE_NAME/SOURCE_COMMITS" ||
  die "git archive did not put SOURCE_COMMITS at $ENGINE_NAME/SOURCE_COMMITS (git $(git --version))"
echo "[ok] $ENGINE_FILE"

# ---- OrcaSlicer at the pin -----------------------------------------------------------------------------------
ORCA_FILE=orcaslicer-${ORCA_PINNED_COMMIT:0:10}-source.tar.xz
git -C "$REPO_DIR/orca" archive --format=tar --prefix=orca/ "$ORCA_PINNED_COMMIT" | xz -T0 -6 > "$OUT/$ORCA_FILE"
echo "[ok] $ORCA_FILE"

# ---- Third-party sources --------------------------------------------------------------------------------------
TP=$WORK/tp
mkdir -p "$TP/deps" "$TP/emscripten-ports" "$TP/npm"
while read -r sum file; do
  case $file in gmp-*|mpfr-*) continue ;; esac   # optional (WITH_GMP=1), not in the default build
  [[ -f $ARCHIVES/$file ]] || die "$ARCHIVES/$file is missing (run bash engine/deps/fetch-deps.sh)"
  [[ $(sha256sum "$ARCHIVES/$file" | cut -d' ' -f1) == "$sum" ]] || die "$file does not match engine/deps/SHA256SUMS"
  cp "$ARCHIVES/$file" "$TP/deps/"
  printf '%s  deps/%s\n' "$sum" "$file" >> "$TP/SHA256SUMS"
done < "$REPO_DIR/engine/deps/SHA256SUMS"
node "$REPO_DIR/tools/release/emscripten-ports.mjs" collect "$EMSCRIPTEN" "$TP/emscripten-ports"
for f in "$TP"/emscripten-ports/*.tar.gz; do
  printf '%s  emscripten-ports/%s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$(basename "$f")" >> "$TP/SHA256SUMS"
done
# npm packages bundled into the host (none today: the host bundles only this repository's code).
if [[ -n ${HOST_METAFILE:-} ]]; then
  node -e '
    const meta = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const pkgs = new Set(Object.keys(meta.inputs).map((f) => /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(f)?.[1]).filter(Boolean));
    console.log([...pkgs].join("\n"));' "$HOST_METAFILE" | while read -r pkg; do
    [[ -n $pkg ]] || continue
    version=$(node -p "require('$REPO_DIR/node_modules/$pkg/package.json').version")
    "${TAR[@]}" -czf "$TP/npm/${pkg//\//-}-$version.tgz" -C "$REPO_DIR/node_modules" "$pkg"
    echo "[ok] npm package $pkg $version (bundled into the host)"
  done
fi
cat > "$TP/README.md" <<EOF
# Third-party sources of the Muon3D Slicer Engine

Every third-party source archive built into the engine, mirrored so that a release can be rebuilt when an
upstream download disappears. SHA256SUMS lists them all.

- \`deps/\`: the archives of engine/deps/fetch-deps.sh, with the sha256 of engine/deps/SHA256SUMS. Copy them
  into \`\$ORCA_WASM_ROOT/deps-src/_archives/\` and fetch-deps.sh uses them instead of downloading.
- \`emscripten-ports/\`: zlib and libpng as Emscripten $EM_VERSION fetches them (URLs and sha512 in
  PORTS.json, from the emsdk's tools/ports/*.py). tools/release/emscripten-ports.mjs seed unpacks them into
  an Emscripten cache.
- \`npm/\`: npm packages bundled into the host, if any.

docs/BUILD.md in the engine's source bundle has the steps.
EOF
KEY=$(cat "$TP/SHA256SUMS" | sha256sum | cut -c1-12)
TP_NAME=third-party-sources-$KEY
mv "$TP" "$WORK/$TP_NAME"
TP_FILE=$TP_NAME.tar
"${TAR[@]}" -cf "$OUT/$TP_FILE" -C "$WORK" "$TP_NAME"
echo "[ok] $TP_FILE"

# ---- sources.json ------------------------------------------------------------------------------------------------
entry() { printf '{ "file": "%s", "sha256": "%s", "bytes": %s }' "$1" "$(sha256sum "$OUT/$1" | cut -d' ' -f1)" "$(stat -c %s "$OUT/$1")"; }
cat > "$OUT/sources.json" <<EOF
{
  "bundle": $(entry "$ENGINE_FILE"),
  "orca": $(entry "$ORCA_FILE"),
  "thirdParty": $(entry "$TP_FILE")
}
EOF
cat "$OUT/sources.json"
