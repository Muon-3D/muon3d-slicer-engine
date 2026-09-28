// `npm run check:imports`: fails if any source file in this repository imports something outside it.
//
// Checked in every .ts, .mts, .js and .mjs file (node_modules/, orca/, dist/ and test-out/ aside):
//   - static imports and re-exports (`import ... from '<spec>'`, `export ... from '<spec>'`),
//     side-effect imports (`import '<spec>'`) and dynamic imports with a literal (`import('<spec>')`);
//   - file references made with `new URL('<literal>', import.meta.url)`.
// A relative specifier must resolve to a file inside the repository (and outside orca/, which is only
// read as data); a bare one must be a Node built-in (`node:*`) or a package this repository declares in
// its package.json. The engine must build and test from this repository alone.
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'orca', 'dist', 'test-out', '.git']);
const EXTENSIONS = /\.(ts|mts|js|mjs)$/;

const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
const builtins = new Set(builtinModules);

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sourceFiles(path.join(dir, entry.name));
    } else if (EXTENSIONS.test(entry.name)) {
      yield path.join(dir, entry.name);
    }
  }
}

/** Comments blanked out (same length, line breaks kept), so commented-out imports do not count. */
function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\'"`])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
}

const PATTERNS = [
  /\bimport\s+(?:type\s+)?[\w*{}\s,$]+\s+from\s+['"]([^'"]+)['"]/g,
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*[,)]/g,
  /\bnew\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
];

function packageName(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const problems = [];
let files = 0;
let references = 0;
for (const file of sourceFiles(repo)) {
  files++;
  const text = withoutComments(fs.readFileSync(file, 'utf8'));
  const rel = path.relative(repo, file).replace(/\\/g, '/');
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const spec = match[1];
      references++;
      const line = text.slice(0, match.index).split('\n').length;
      const where = `${rel}:${line}`;
      if (rel.startsWith('packages/protocol/')) {
        // The protocol package is a separate work (Apache-2.0) that others install on its own: it imports
        // nothing outside its folder, not even Node's modules (it runs in browsers).
        const target = path.resolve(path.dirname(file), spec);
        const inPackage = !path.relative(path.join(repo, 'packages/protocol'), target).startsWith('..');
        if (!(spec.startsWith('.') && inPackage)) problems.push(`${where}: "${spec}" is outside packages/protocol (the package imports only its own files)`);
        continue;
      }
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const target = path.resolve(path.dirname(file), spec);
        const inside = path.relative(repo, target);
        if (inside.startsWith('..') || path.isAbsolute(inside)) problems.push(`${where}: "${spec}" is outside the repository`);
        else if (inside.split(path.sep)[0] === 'orca' && !/^new\s+URL/.test(match[0])) problems.push(`${where}: "${spec}" imports code from orca/`);
      } else if (spec.startsWith('node:') || builtins.has(spec)) {
        // a Node built-in
      } else if (/^[a-z]+:/i.test(spec)) {
        problems.push(`${where}: "${spec}" is a URL`);
      } else if (!declared.has(packageName(spec))) {
        problems.push(`${where}: "${spec}" is not a package this repository declares (package.json)`);
      }
    }
  }
}

if (problems.length) {
  console.error(`Imports outside the repository (${problems.length}):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`OK: ${references} imports in ${files} files, all inside the repository.`);
