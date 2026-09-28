// Writes a goldens file: the top-level fields pretty-printed, and each entry of the object fields named
// in `oneLine` on one line of its own (small files, one changed line per changed entry).
import fs from 'node:fs';

export function writeGoldens(file: string, value: Record<string, unknown>, oneLine: readonly string[]): void {
  const parts = Object.entries(value).map(([key, field]) => {
    if (oneLine.includes(key) && field && typeof field === 'object' && !Array.isArray(field)) {
      const lines = Object.entries(field).map(([id, entry]) => `  ${JSON.stringify(id)}: ${JSON.stringify(entry)}`);
      return `${JSON.stringify(key)}: {\n${lines.join(',\n')}\n}`;
    }
    return `${JSON.stringify(key)}: ${JSON.stringify(field, null, 1)}`;
  });
  fs.writeFileSync(file, `{\n${parts.join(',\n')}\n}\n`);
}
