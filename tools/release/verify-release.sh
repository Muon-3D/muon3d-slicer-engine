#!/usr/bin/env bash
# =====================================================================================================
# verify-release.sh: checks a release as a user receives it. Downloads every asset (drafts too, with a token
# that can see them), checks SHA256SUMS, unpacks the runtime, checks every file against manifest.json, checks the
# profile set (tools/profiles/check.ts) and its pairing with the engine, validates the M1 presets with
# examples/settings-cli (the settings service, no wasm) and slices a 20 mm cube with examples/node-cli on both
# variants from the unpacked runtime.
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
for (const c of m.host.chunks ?? []) if (!fs.existsSync(path.join(dir, c.file)) || sha(path.join(dir, c.file)) !== c.sha256) problems.push(`host chunk ${c.file}: missing or sha256 differs`);
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

# ---- The profile set -------------------------------------------------------------------------------------------------
# Every file the index names, every preset flattened from the set against OrcaSlicer's loader (the goldens), the
# Muon3D record, and the pairing with this release's engine.
PROFILES=$DIR/assets/muon3d-slicer-profiles-$VERSION.tgz
[[ -f $PROFILES ]] || die "no profile set $PROFILES"
rm -rf "$DIR/profiles" && mkdir -p "$DIR/profiles"
tar -xzf "$PROFILES" -C "$DIR/profiles"
PS=$DIR/profiles/muon3d-slicer-profiles-$VERSION
node "$HERE/tools/profiles/check.ts" "$PS" --expect "$HERE/test/profiles/muon3d.json" || die "the profile set does not check"
node - "$PS" "$RT" "$VERSION" <<'EOF'
const fs = require('fs'), path = require('path');
const [set, runtime, version] = process.argv.slice(2);
const dir = path.join(set, 'profiles', version);
const index = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => /^index\.[0-9a-f]{16}\.json$/.test(f))), 'utf8'));
const m = JSON.parse(fs.readFileSync(path.join(runtime, 'manifest.json'), 'utf8'));
const problems = [];
if (index.set !== version || index.engine.version !== version) problems.push(`set ${index.set}, engine ${index.engine.version}, release ${version}`);
if (index.engine.orca.commit !== m.orca.commit) problems.push(`profiles from Orca ${index.engine.orca.commit}, engine from ${m.orca.commit}`);
if (index.source.commit !== m.build.engineCommit) problems.push(`profiles from ${index.source.commit}, engine from ${m.build.engineCommit}`);
for (const f of ['LICENSE', 'README.md', 'goldens.json.gz']) if (!fs.existsSync(path.join(set, f))) problems.push(`${f} missing`);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`OK: profile set ${index.set}: ${index.vendors.length} vendors, paired with engine ${m.version} (Orca ${m.orca.commit.slice(0, 10)})`);
EOF

# ---- The settings service from the unpacked runtime (no wasm) --------------------------------------------------------
node "$HERE/examples/settings-cli/settings.mjs" --validate --dist "$RT" > "$DIR/settings-validate.txt" || die "settings-cli --validate failed on the runtime"
grep -q '^OK: Orca raises no error or warning' "$DIR/settings-validate.txt" || die "settings-cli: unexpected output: $(cat "$DIR/settings-validate.txt")"

# ---- Slice the cube from the unpacked runtime ------------------------------------------------------------------------
for variant in st mt; do
  node "$HERE/examples/node-cli/slice.mjs" --cube 20 --variant "$variant" --dist "$RT" -o "$DIR/cube-$variant.gcode"
  lines=$(wc -l < "$DIR/cube-$variant.gcode")
  (( lines > 1000 )) || die "cube-$variant.gcode has only $lines lines"
  grep -q '^; total layer number: 100$' "$DIR/cube-$variant.gcode" || die "cube-$variant.gcode: not the 100 layers of a 20 mm cube"
done
echo "OK: $TAG verified in $DIR (checksums, manifest, profile set, settings service, cube sliced on st and mt)"
