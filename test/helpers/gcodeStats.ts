// Test helper: Orca's print statistics read back from the text of a G-code file.
//
// Provenance: copied on 2026-09-27 from the Muon3D Slicer app (server/gcodeStats.ts: parseStatsText
// and the functions it uses; the file and scan helpers were left out). It is Muon 3D Technologies' own
// code; this copy is part of the engine repository and licensed like it (AGPL-3.0-only). The engine
// tests check that the stats the engine returns are exactly what the G-code's header and footer say.
import type { GcodeStats } from '../../packages/protocol/src/v1.ts';

const UNIT_SECONDS: Record<string, number> = { d: 86_400, h: 3_600, m: 60, s: 1 };

/** Parses Orca's duration text ("1d 2h 3m 4s", "44m 38s", "15s") into seconds; null if unrecognised. */
export function parseDuration(text: string): number | null {
  const trimmed = text.trim();
  if (!/^(?:\d+(?:\.\d+)?\s*[dhms]\s*)+$/i.test(trimmed)) return null;
  let seconds = 0;
  for (const [, amount, unit] of trimmed.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) {
    seconds += Number(amount) * UNIT_SECONDS[unit.toLowerCase()];
  }
  return Math.round(seconds);
}

/** Value of the last `; <key> = <value>` (or `; <key>: <value>`) comment line in `text`. */
function lastValue(text: string, key: string, separator: '=' | ':'): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^;\\s*${escaped}\\s*${separator}[ \\t]*(.*?)\\s*$`, 'gm');
  let value: string | null = null;
  for (const m of text.matchAll(re)) value = m[1];
  return value === '' ? null : value;
}

/**
 * Parses a number, or the sum of a comma-separated per-extruder list ("12.5, 3.1").
 * Returns null when nothing numeric is there.
 */
function parseAmount(value: string | null): number | null {
  if (value === null) return null;
  const parts = value.split(',').map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length === 0) return null;
  let sum = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isFinite(n)) return null;
    sum += n;
  }
  return Math.round(sum * 1000) / 1000;
}

function parseCount(value: string | null): number | null {
  const n = parseAmount(value);
  return n === null ? null : Math.round(n);
}

// Bambu Lab G-code has no footer time; its header says
// "; model printing time: 30m 39s; total estimated time: 36m 54s".
const BBL_TOTAL_TIME_RE = /^;\s*model printing time:[^;\n]*;\s*total estimated time:[ \t]*(.+?)\s*$/m;

/**
 * Extracts the stats from the first and last bytes of a G-code file. `head` and `tail` may
 * overlap (small files) — every field is taken from one region only, so that is harmless.
 */
export function parseStatsText(head: string, tail: string): GcodeStats {
  // The footer is what follows the toolpaths, minus the CONFIG block: its `; key = value` lines
  // use different key spellings today, but a vendor template could contain anything. Bambu Lab
  // files put the CONFIG block near the top instead, so in a small file the tail holds it too.
  const executableEnd = tail.lastIndexOf('; EXECUTABLE_BLOCK_END');
  const footerStart = Math.max(0, executableEnd);
  const configStart =
    executableEnd >= 0 ? tail.indexOf('; CONFIG_BLOCK_START', executableEnd) : tail.lastIndexOf('; CONFIG_BLOCK_START');
  const footer = tail.slice(footerStart, configStart >= 0 ? configStart : undefined);
  // Bambu Lab files put the CONFIG block right after the header, inside the head window.
  const headerEnd = head.indexOf('; HEADER_BLOCK_END');
  const header = headerEnd >= 0 ? head.slice(0, headerEnd) : head;

  const printTimeText =
    lastValue(footer, 'estimated printing time (normal mode)', '=') ?? BBL_TOTAL_TIME_RE.exec(header)?.[1] ?? null;
  const firstLayerTimeText =
    lastValue(footer, 'estimated first layer printing time (normal mode)', '=') ??
    lastValue(header, 'estimated first layer printing time (normal mode)', '=');

  return {
    printTimeSeconds: printTimeText === null ? null : parseDuration(printTimeText),
    printTimeText,
    firstLayerTimeText,
    filamentMm: parseAmount(lastValue(footer, 'filament used [mm]', '=')),
    filamentCm3: parseAmount(lastValue(footer, 'filament used [cm3]', '=')),
    filamentG:
      parseAmount(lastValue(footer, 'total filament used [g]', '=')) ??
      parseAmount(lastValue(footer, 'filament used [g]', '=')),
    filamentCost:
      parseAmount(lastValue(footer, 'total filament cost', '=')) ??
      parseAmount(lastValue(footer, 'filament cost', '=')),
    // The header count is the number of layer-change tags, which is what a preview's layer
    // slider shows; the footer count is one off with supports (one more) or vase mode (one fewer).
    layers:
      parseCount(lastValue(header, 'total layer number', ':')) ??
      parseCount(lastValue(footer, 'total layers count', '=')),
    maxZ: parseAmount(lastValue(header, 'max_z_height', ':')),
  };
}
