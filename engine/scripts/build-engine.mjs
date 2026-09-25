// `npm run build:engine`: builds and publishes the browser engine (scripts/build.sh) for each variant
// in turn, from any shell. On Windows it runs Git Bash: a bare `bash` there is usually WSL's.
//
//   npm run build:engine            # st, then mt
//   npm run build:engine -- mt      # one variant
//
// The environment passes through (ORCA_WASM_ROOT, ORCA_SRC, ORCA_EMSDK, JOBS, ...; see build.sh).
// GIT_BASH overrides the bash to use.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Git Bash on Windows (next to the git on PATH), plain bash elsewhere. */
function findBash() {
  if (process.env.GIT_BASH) return process.env.GIT_BASH;
  if (process.platform !== 'win32') return 'bash';
  const candidates = [];
  try {
    // e.g. C:/Program Files/Git/mingw64/libexec/git-core -> C:/Program Files/Git/bin/bash.exe
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    candidates.push(path.resolve(execPath, '../../../bin/bash.exe'));
  } catch {
    // no git on PATH
  }
  candidates.push('C:/Program Files/Git/bin/bash.exe');
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('Git Bash not found: install Git for Windows, or set GIT_BASH to its bash.exe.');
  return found;
}

const args = process.argv.slice(2);
const variants = args.length ? args : ['st', 'mt'];
for (const variant of variants) {
  if (variant !== 'st' && variant !== 'mt') {
    console.error(`usage: npm run build:engine [-- st|mt ...] (got "${variant}")`);
    process.exit(2);
  }
}
const bash = findBash();
for (const variant of variants) {
  const result = spawnSync(bash, [path.join(here, 'build.sh'), variant], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
