#!/usr/bin/env bash
# =====================================================================================================
# verify-release.sh: checks a release as a user receives it. Downloads every asset (drafts too, with a token
# that can see them), checks SHA256SUMS, unpacks the runtime, checks every file against manifest.json, and
# slices a 20 mm cube with examples/node-cli on both variants from the unpacked runtime.
#
#   bash tools/release/verify-release.sh v0.1.0 [<folder>]      # default folder: release-<tag>/
#
# Needs gh (signed in), node >= 22.18, sha256sum and tar. GH_REPO overrides the repository.
# =====================================================================================================
set -euo pipefail

TAG=${1:?usage: verify-release.sh <tag> [folder]}
DIR=${2:-release-$TAG}
REPO=${GH_REPO:-Muon-3D/muon3d-slicer-engine}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
die() { echo "verify-release: $*" >&2; exit 1; }

# ---- Download (the API, so that a draft release works too) ---------------------------------------------------------
mkdir -p "$DIR/assets"
RELEASE_ID=$(gh api "repos/$REPO/releases?per_page=100" --jq ".[] | select(.tag_name == \"$TAG\") | .id" | head -1)
[[ -n $RELEASE_ID ]] || die "no release $TAG in $REPO"
gh api "repos/$REPO/releases/$RELEASE_ID/assets?per_page=100" --jq '.[] | "\(.id) \(.name)"' |
  while read -r id name; do
    [[ -s $DIR/assets/$name ]] && continue
    echo "downloading $name"
    gh api -H 'Accept: application/octet-stream' "repos/$REPO/releases/assets/$id" > "$DIR/assets/$name.part"
    mv "$DIR/assets/$name.part" "$DIR/assets/$name"
  done

# ---- Checksums -------------------------------------------------------------------------------------------------------
(cd "$DIR/assets" && sha256sum -c SHA256SUMS) || die "SHA256SUMS does not match the assets"
listed=$(awk '{print $2}' "$DIR/assets/SHA256SUMS" | sed 's/^\*//' | sort)
present=$(cd "$DIR/assets" && ls | grep -v '^SHA256SUMS$' | sort)
[[ $listed == "$present" ]] || die "SHA256SUMS does not list exactly the assets:"$'\n'"$(diff <(echo "$listed") <(echo "$present"))"

# ---- The runtime -----------------------------------------------------------------------------------------------------
VERSION=${TAG#v}
RUNTIME=$DIR/assets/muon3d-slicer-engine-$VERSION.tgz
[[ -f $RUNTIME ]] || die "no runtime tarball $RUNTIME"
rm -rf "$DIR/runtime" && mkdir -p "$DIR/runtime"
tar -xzf "$RUNTIME" -C "$DIR/runtime"
RT=$DIR/runtime/muon3d-slicer-engine-$VERSION
node - "$RT" "$DIR/assets" <<'EOF'
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [dir, assets] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const problems = [];
const names = fs.readdirSync(dir).filter((n) => n !== 'manifest.json').sort();
if (JSON.stringify(names) !== JSON.stringify(Object.keys(m.files).sort())) problems.push(`files: ${names} vs manifest ${Object.keys(m.files)}`);
for (const [name, e] of Object.entries(m.files)) if (sha(path.join(dir, name)) !== e.sha256) problems.push(`${name}: sha256 differs`);
for (const [v, e] of Object.entries(m.variants)) {
  if (sha(path.join(dir, e.wasm)) !== e.sha256.wasm || sha(path.join(dir, e.mjs)) !== e.sha256.mjs) problems.push(`${v}: variant sha256 differs`);
}
if (sha(path.join(dir, m.host.file)) !== m.host.sha256) problems.push('host sha256 differs');
for (const key of ['bundle', 'orca', 'thirdParty']) {
  const s = m.source?.[key];
  if (!s) { problems.push(`manifest.source.${key} missing`); continue; }
  const file = path.join(assets, s.file);
  if (!fs.existsSync(file)) problems.push(`${s.file} (source.${key}) is not a release asset`);
  else if (sha(file) !== s.sha256) problems.push(`${s.file}: sha256 differs from manifest.source.${key}`);
}
for (const f of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'SOURCE.md']) if (!m.files[f]) problems.push(`${f} missing`);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`OK: runtime ${m.version}: ${Object.keys(m.files).length} files match manifest.json; Orca ${m.orca.version} @ ${m.orca.commit}; engine @ ${m.build.engineCommit}`);
EOF

# ---- Slice the cube from the unpacked runtime ------------------------------------------------------------------------
for variant in st mt; do
  node "$HERE/examples/node-cli/slice.mjs" --cube 20 --variant "$variant" --dist "$RT" -o "$DIR/cube-$variant.gcode"
  lines=$(wc -l < "$DIR/cube-$variant.gcode")
  (( lines > 1000 )) || die "cube-$variant.gcode has only $lines lines"
  grep -q '^; total layer number: 100$' "$DIR/cube-$variant.gcode" || die "cube-$variant.gcode: not the 100 layers of a 20 mm cube"
done
echo "OK: $TAG verified in $DIR (checksums, manifest, cube sliced on st and mt)"
