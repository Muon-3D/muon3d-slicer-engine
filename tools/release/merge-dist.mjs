// Merges the dist/ folders of builds made on separate machines (CI builds st and mt in parallel jobs) into one:
// copies every file and merges manifest.json's variants. The builds must name the same Orca version and commit.
//
//   node tools/release/merge-dist.mjs <out> <dist-st> <dist-mt> [...]
import fs from 'node:fs';
import path from 'node:path';

const [out, ...inputs] = process.argv.slice(2);
if (!out || inputs.length === 0) {
  console.error('usage: node tools/release/merge-dist.mjs <out> <dist>...');
  process.exit(2);
}

fs.mkdirSync(out, { recursive: true });
let merged = null;
for (const dir of inputs) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (!merged) {
    merged = { ...manifest, variants: { ...manifest.variants } };
  } else {
    if (manifest.orcaCommit !== merged.orcaCommit || manifest.orcaVersion !== merged.orcaVersion) {
      throw new Error(`${dir}: built from Orca ${manifest.orcaVersion} @ ${manifest.orcaCommit}, not ${merged.orcaVersion} @ ${merged.orcaCommit}`);
    }
    for (const [variant, entry] of Object.entries(manifest.variants)) {
      if (merged.variants[variant]) throw new Error(`${dir}: variant ${variant} is in more than one input`);
      merged.variants[variant] = entry;
    }
    if (manifest.builtAt > merged.builtAt) merged.builtAt = manifest.builtAt;
    merged.host ??= manifest.host;
  }
  for (const name of fs.readdirSync(dir)) {
    if (name !== 'manifest.json' && fs.statSync(path.join(dir, name)).isFile()) fs.copyFileSync(path.join(dir, name), path.join(out, name));
  }
}
merged.variants = Object.fromEntries(Object.entries(merged.variants).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(merged, null, 2) + '\n');
console.log(`merged ${inputs.length} builds into ${out}: variants ${Object.keys(merged.variants).join(', ')}`);
