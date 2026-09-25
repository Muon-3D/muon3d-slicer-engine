// Copies files with CRLF line ends turned into LF, byte for byte otherwise; a copy whose content is
// already right is left alone (so its time stamp does not trigger a relink). Engine.cmake runs it at
// configure time on the Orca resources the engine embeds (CMake's own file(WRITE) writes CRLF on
// Windows, and file(CONFIGURE)/file(GENERATE) add a final newline).
//
//   node copy-lf.mjs <source folder> <destination folder> <relative path>...
import fs from 'node:fs';
import path from 'node:path';

const [from, to, ...files] = process.argv.slice(2);
for (const file of files) {
  const data = Buffer.from(fs.readFileSync(path.join(from, file)).toString('latin1').replaceAll('\r\n', '\n'), 'latin1');
  const target = path.join(to, file);
  let current = null;
  try {
    current = fs.readFileSync(target);
  } catch {
    // not copied yet
  }
  if (current && current.equals(data)) continue;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
}
