// SPDX-License-Identifier: Apache-2.0
// The build manifest: dist/manifest.json of a build, and manifest.json of a release's runtime folder, which
// names the host to start, the engine files, and (in a release) where the source is.
import type { Variant } from './envelope.ts';

/** What the build publishes next to the engine files (dist/manifest.json). */
export interface EngineManifest {
  orcaVersion: string;
  orcaCommit: string;
  builtAt: string;
  /** The worker host to start: new Worker(<folder of manifest.json> + host.file, { type: 'module' }). */
  host?: EngineManifestHost;
  /**
   * `mjs` and `wasm` are relative to manifest.json and may sit in a folder of their own (e.g. one
   * named after a content hash, cached for good). The engine loads engine-<variant>.mjs and
   * engine-<variant>.wasm from the folder of `mjs`: those names are built into the .mjs, which
   * also starts its pthread workers from its own URL. `wasmBytes` is the uncompressed size;
   * `wasmTransferBytes`, when present, what a server sends a browser that accepts brotli (the .br).
   */
  variants: Partial<Record<Variant, EngineManifestVariant>>;
  // The fields below are written by the release tooling (tools/release/assemble.mjs) into the runtime of a
  // release or prerelease; a local `npm run build` has only the ones above.
  /** Format of this manifest: 2 once the release fields below are present. */
  manifest?: 2;
  name?: 'muon3d-slicer-engine';
  /** This release's version (semver), e.g. "0.1.0", or "0.1.0-edge.<commit>" for the rolling prerelease. */
  version?: string;
  /** The protocol the host speaks. */
  protocol?: { major: number; minor: number };
  license?: 'AGPL-3.0-only';
  orca?: EngineManifestOrca;
  build?: { engineCommit: string; emsdk: string; builtAt: string };
  source?: EngineManifestSource;
  /** Every other file of the runtime, with its sha256 (hex) and size. */
  files?: Record<string, { sha256: string; bytes: number }>;
}

export interface EngineManifestOrca {
  version: string;
  commit: string;
  /** The tag on `repository` naming `commit`, which keeps its source reachable. */
  tag: string;
  repository: string;
  /** The upstream OrcaSlicer commit the fork's branch is based on. */
  base?: { repository: string; ref: string; commit: string };
}

/** Where this build's Corresponding Source is (SOURCE.md next to the manifest says the same in words). */
export interface EngineManifestSource {
  /** This repository. */
  url: string;
  /** Its release tag, when this is a release. */
  tag?: string;
  /** Its commit the build was made from. */
  commit: string;
  /** Release assets: this repository at `tag`, the Orca tree at `orca.commit`, and every third-party source archive. */
  bundle?: EngineManifestSourceFile;
  orca?: EngineManifestSourceFile;
  thirdParty?: EngineManifestSourceFile;
}

export interface EngineManifestSourceFile {
  file: string;
  url: string;
  sha256: string;
  bytes: number;
}

export interface EngineManifestVariant {
  mjs: string;
  wasm: string;
  wasmBytes: number;
  wasmTransferBytes?: number;
  /** sha256 (hex) of the two files as published, to check a rebuild or a deployed copy against them. */
  sha256?: { mjs: string; wasm: string };
  /**
   * The commit of this repository the build ran from (the bridge and build recipe in engine/), with
   * "-dirty" when engine/ had uncommitted changes. The Orca source is `orcaCommit`.
   */
  engineCommit?: string;
}

export interface EngineManifestHost {
  /** File name, relative to manifest.json: host.<content hash>.js, an ES module worker script. */
  file: string;
  /** sha256 (hex) of the file. */
  sha256: string;
  /** The protocol major version the host speaks. */
  protocol: number;
  /**
   * Scripts the host loads on demand (the settings service), relative to manifest.json: served next to it,
   * each with its sha256. Absent in hosts before protocol 2.
   */
  chunks?: Array<{ file: string; sha256: string }>;
  /** The string the host reports in `ready` (see there). */
  canary: string;
  /** The commit of this repository the host was built from ("-dirty" with uncommitted changes in host/). */
  engineCommit?: string;
}
