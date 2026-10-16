#!/usr/bin/env bash
set -euo pipefail
bash tools/release/verify-release.sh "$TAG" rel
for VARIANT in st mt; do
version=${TAG#v}
mkdir -p in "work-$VARIANT"
for f in rel/assets/*-source.tar.gz rel/assets/*-source.tar.xz rel/assets/third-party-sources-*.tar; do ln -f "$f" in/; done
# The rebuild script as released, from the engine's source bundle.
tar -xzf "in/muon3d-slicer-engine-$version-source.tar.gz" -O "muon3d-slicer-engine-$version/tools/release/rebuild-offline.sh" > work-$VARIANT/rebuild-offline.sh
tar -xzf "in/muon3d-slicer-engine-$version-source.tar.gz" -C "work-$VARIANT" "muon3d-slicer-engine-$version/tools/release/offline/Dockerfile"
docker build -q -t engine-offline "work-$VARIANT/muon3d-slicer-engine-$version/tools/release/offline"
start=$SECONDS
docker run --rm --network none -v "$PWD/in:/in:ro" -v "$PWD/work-$VARIANT:/work" engine-offline bash /work/rebuild-offline.sh "$VARIANT"
took=$((SECONDS - start))
manifest=rel/runtime/muon3d-slicer-engine-$version/manifest.json
want_wasm=$(node -p "require('./$manifest').variants.$VARIANT.sha256.wasm")
want_mjs=$(node -p "require('./$manifest').variants.$VARIANT.sha256.mjs")
got_wasm=$(sha256sum "work-$VARIANT/out-$VARIANT/engine-$VARIANT.wasm" | cut -d' ' -f1)
got_mjs=$(sha256sum "work-$VARIANT/out-$VARIANT/engine-$VARIANT.mjs" | cut -d' ' -f1)
echo "engine-$VARIANT.wasm: released $want_wasm, rebuilt $got_wasm"
echo "engine-$VARIANT.mjs:  released $want_mjs, rebuilt $got_mjs"
mkdir -p result
if [[ $want_wasm == "$got_wasm" && $want_mjs == "$got_mjs" ]]; then
  echo "- \`engine-$VARIANT.wasm\` and \`engine-$VARIANT.mjs\` rebuilt byte for byte from the three source assets alone, in \`emscripten/emsdk:6.0.10\` with the network off and an empty Emscripten cache ($((took / 60)) min)." > "result/$VARIANT.md"
  cat "result/$VARIANT.md" >> "$GITHUB_STEP_SUMMARY"
else
  echo "::error::the offline rebuild of $VARIANT differs from the release"
  exit 1
fi

done
version=${TAG#v}
rm -rf hostcheck && mkdir hostcheck
tar -xzf "in/muon3d-slicer-engine-$version-source.tar.gz" -C hostcheck
cd "hostcheck/muon3d-slicer-engine-$version"
npm ci --no-audit --no-fund
ENGINE_DIST=$PWD/out node host/build.mjs
manifest=../../rel/runtime/muon3d-slicer-engine-$version/manifest.json
want=$(node -p "JSON.stringify([require('$manifest').host.sha256, ...(require('$manifest').host.chunks ?? []).map((c) => c.sha256)])")
got=$(node -p "JSON.stringify([require('./out/manifest.json').host.sha256, ...(require('./out/manifest.json').host.chunks ?? []).map((c) => c.sha256)])")
[[ $want == "$got" ]] || { echo "::error::host rebuilt from the source bundle: $got, released $want"; exit 1; }
echo "- \`$(node -p "require('$manifest').host.file")\` and the chunks it loads rebuilt byte for byte from the source bundle (with its locked npm dependencies)." > ../../result/host.md

cd ../..
{
  echo
  echo '## Verified (self-hosted, no Actions artifacts)'
  cat result/*.md
  echo
  echo "Run: https://github.com/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
} >> notes.md
gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" --draft --notes-file notes.md
cat assets/SHA256SUMS >> "$GITHUB_STEP_SUMMARY"
echo "Verified draft $TAG. Publishing requires a separate supervisor action." >> "$GITHUB_STEP_SUMMARY"
