#!/usr/bin/env bash
# Only called by the one-job self-hosted release workflow. Never publishes a release.
set -euo pipefail
version=${TAG#v}
node tools/release/merge-dist.mjs dist "$RELEASE_WORK/st" "$RELEASE_WORK/mt"
npm run build:host
node tools/release/assemble.mjs --dist dist --out "out/muon3d-slicer-engine-$version" --version "$version" \
  --tag "$TAG" --sources "$RELEASE_WORK/sources"/sources.json
mkdir -p assets
epoch=$(git log -1 --format=%ct)
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$epoch" --format=gnu -C out \
  -cf - "muon3d-slicer-engine-$version" | gzip -n -9 > "assets/muon3d-slicer-engine-$version.tgz"
# The profile set (docs/PROFILES.md), built with this release's engine from the pinned Orca tree and the
# Muon3D overlay, then checked: every preset against OrcaSlicer's loader, and the Muon3D record.
node tools/profiles/fixtures.ts --check
node tools/profiles/build.ts --out "out/muon3d-slicer-profiles-$version" --set "$version"
node tools/profiles/check.ts "out/muon3d-slicer-profiles-$version" --expect test/profiles/muon3d.json
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$epoch" --format=gnu -C out \
  -cf - "muon3d-slicer-profiles-$version" | gzip -n -9 > "assets/muon3d-slicer-profiles-$version.tgz"
jq -r '.sizes | to_entries[] | "- profiles \(.key): \(.value)"' "out/muon3d-slicer-profiles-$version/report.json" >> "$GITHUB_STEP_SUMMARY"
for key in bundle orca thirdParty; do
  file=$(node -p "require(process.env.RELEASE_WORK + '/sources/sources.json').$key.file")
  mv "$RELEASE_WORK/sources/$file" assets/
done
# The protocol package (Apache-2.0): its npm tarball, until it is on npmjs.
npm run pack:protocol -- assets
(cd assets && sha256sum -- * > ../SHA256SUMS) && mv SHA256SUMS assets/
cat assets/SHA256SUMS

version=${TAG#v}
mkdir -p check && tar -xzf "assets/muon3d-slicer-engine-$version.tgz" -C check
for variant in st mt; do
  node examples/node-cli/slice.mjs --cube 20 --variant "$variant" --dist "check/muon3d-slicer-engine-$version" -o "check/cube-$variant.gcode"
  grep -q '^; total layer number: 100$' "check/cube-$variant.gcode"
done

version=${TAG#v}
manifest=check/muon3d-slicer-engine-$version/manifest.json
orca_version=$(node -p "require('./$manifest').orca.version")
orca_commit=$(node -p "require('./$manifest').orca.commit")
orca_tag=$(node -p "require('./$manifest').orca.tag")
title="Muon3D Slicer Engine $version (OrcaSlicer $orca_version @ ${orca_commit:0:10})"
{
  echo "The Muon3D Slicer Engine $version: OrcaSlicer's libslic3r compiled to WebAssembly, with its host"
  echo "(protocol v$(node -p "require('./$manifest').protocol.major"), docs/PROTOCOL.md). Built from OrcaSlicer $orca_version at"
  echo "[\`$orca_commit\`](https://github.com/Muon-3D/OrcaSlicer/commit/$orca_commit) (tag \`$orca_tag\` of Muon-3D/OrcaSlicer)."
  echo
  echo "## Assets"
  echo
  echo "| File | What | sha256 |"
  echo "|---|---|---|"
  while read -r sum file; do
    case $file in
      "muon3d-slicer-engine-$version.tgz") what='The runtime: serve its folder as it is (README, "Using it from a web page")' ;;
      "muon3d-slicer-profiles-$version.tgz") what='The profile set: OrcaSlicer'"'"'s printer, process and filament presets for this engine, for a static site (docs/PROFILES.md)' ;;
      "muon3d-slicer-engine-$version-source.tar.gz") what='Source: this repository at the tag' ;;
      orcaslicer-*-source.tar.xz) what='Source: OrcaSlicer at the pinned commit (extract into the folder above)' ;;
      third-party-sources-*.tar) what='Source: every third-party archive the build uses, mirrored' ;;
      muon3d-slicer-engine-protocol-*.tgz) what='The protocol package @muon3d/slicer-engine-protocol (Apache-2.0): npm install the tarball URL' ;;
      *) what='' ;;
    esac
    echo "| \`$file\` | $what | \`$sum\` |"
  done < assets/SHA256SUMS
  echo
  echo "Check a download with \`sha256sum -c SHA256SUMS\`, and its provenance with"
  echo "\`gh attestation verify <file> --repo $GITHUB_REPOSITORY\`. The runtime's \`SOURCE.md\` says where the"
  echo "Corresponding Source of this build is; \`docs/BUILD.md\` has the steps to rebuild it, offline, from the three source assets."
} > notes.md
if gh release view "$TAG" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  echo "Release $TAG already exists; inspect it before retrying." >&2
  exit 1
fi
gh release create "$TAG" assets/* --repo "$GITHUB_REPOSITORY" --draft --verify-tag --title "$title" --notes-file notes.md
