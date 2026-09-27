# @muon3d/slicer-engine-protocol

Types of the Web Worker protocol spoken by the [Muon3D Slicer Engine](../../README.md) host: the job and result
types (`SliceJob`, `SliceOutput`, `CheckJob`, `CheckOutput`, `Toolpaths`, `GcodeStats`, `FlatConfig`, ...), the
worker messages (`EngineRequest`, `EngineResponse`) and the build manifest (`EngineManifest`).

This is protocol **v1**, the one the first client used. It changes only additively; protocol v2 will replace it
with a documented envelope, a handshake and capabilities.

The package holds types only: importing it bundles no engine code. A page starts the engine by URL
(`new Worker(base + manifest.host.file, { type: 'module' })`) and talks to it with `postMessage`.

Licence: Apache-2.0 (`LICENSE`). The engine itself is AGPL-3.0-only; this package is a separate work.
