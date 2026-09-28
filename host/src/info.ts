// What the host says about itself in `hello`: filled in by host/build.mjs at build time (esbuild `define`),
// with placeholders when the sources run unbundled (the Node tests).
import type { EngineInfo } from '../../packages/protocol/src/ops.ts';
import { HOST_CANARY } from './canary.ts';

export interface BuildInfo {
  version: string;
  commit: string;
  source: string;
  orca: { version: string; commit: string; repository: string };
  /** The engine's -sMAXIMUM_MEMORY (engine/cmake/Engine.cmake). */
  maxHeapBytes: number;
}

declare const __ENGINE_BUILD__: BuildInfo | undefined;

const DEV: BuildInfo = {
  version: '0.0.0-dev',
  commit: 'dev',
  source: 'https://github.com/Muon-3D/muon3d-slicer-engine',
  orca: { version: 'unknown', commit: 'unknown', repository: 'https://github.com/Muon-3D/OrcaSlicer' },
  maxHeapBytes: 4 * 1024 ** 3,
};

export const BUILD: BuildInfo = typeof __ENGINE_BUILD__ !== 'undefined' ? __ENGINE_BUILD__ : DEV;

export const ENGINE_NAME = 'Muon3D Slicer Engine (based on OrcaSlicer)';
export const LICENSE = 'AGPL-3.0-only';

/** The engine part of `hello`; `base` is the folder the host is served from (NOTICE sits next to it). */
export function engineInfo(base: string, build: BuildInfo = BUILD): EngineInfo {
  let notice: string;
  try {
    notice = new URL('NOTICE', base).href;
  } catch {
    notice = 'NOTICE';
  }
  return {
    name: ENGINE_NAME,
    version: build.version,
    orca: { ...build.orca },
    license: LICENSE,
    source: build.source,
    notice,
    canary: HOST_CANARY,
    commit: build.commit,
  };
}
