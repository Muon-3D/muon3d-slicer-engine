# @muon3d/slicer-engine-protocol

Protocol **v2** of the [Muon3D Slicer Engine](https://github.com/Muon-3D/muon3d-slicer-engine): the messages a
client exchanges with the engine host, and small helpers both sides share. The normative description is
[`docs/PROTOCOL.md`](https://github.com/Muon-3D/muon3d-slicer-engine/blob/main/docs/PROTOCOL.md); this package is
its code. Package 2.1.x is protocol 2.1.

- **Types:** the envelope (`Request`, `Response`, `HostState`, `EngineError`, `ErrorCode`), every op's params and
  result (`Ops`, `HelloResult`, `SliceParams`, `SliceResult`, `Toolpaths`, `CheckResult`, `ConfigDefinitions`,
  `SettingsCatalogue`, `SettingsView`, `SettingsEditResult`, the profile ops' `ProfileFolder` and results, ...),
  capability names (`Capability`, `OPS`) and the build manifest (`EngineManifest`).
- **Profile sets:** the files a release's profile set holds (`ProfileIndex`, `VendorBundle`, `ProfileGoldens`), and
  `flattenPreset()` and `canonicalConfigJson()`, the reference way to flatten a preset from a set
  ([`docs/PROFILES.md`](https://github.com/Muon-3D/muon3d-slicer-engine/blob/main/docs/PROFILES.md)).
- **Helpers:** `negotiate()` (does a host's `hello` suit this client), `transferablesOf()` (the buffers of a
  message, to transfer rather than copy), `configHash()` (the hash a settings request names a cached preset by).
- **Transports:** `workerTransport()` (a Web Worker, a MessagePort, or a worker's own scope),
  `nodeWorkerTransport()` (Node `worker_threads`), `byteStreamTransport()` (anything that carries bytes: a
  WebSocket, an HTTP body, a pipe; messages framed by `encodeFrame()` / `FrameReader`).
- **Client:** `EngineConnection` (request ids, promises, progress and warnings, state, cancel) over any transport,
  and `SettingsClient` (sends presets once and then by hash, caches the settings forms).

```ts
import { EngineConnection, SettingsClient, workerTransport } from '@muon3d/slicer-engine-protocol';

const worker = new Worker(new URL(manifest.host.file, engineBase), { type: 'module' });
const engine = new EngineConnection(workerTransport(worker), { onState: (s) => console.log(s.state) });
const hello = await engine.open({ name: 'my-app', version: '1.0.0' });
const sliced = await engine.request('slice', { configs, objects }, { onProgress: (p) => console.log(p.percent) });
```

The package holds no engine code: importing it bundles none, and it imports nothing outside itself (CI checks).
It has no dependencies and needs no DOM or Node types beyond `AbortSignal`.

Licence: Apache-2.0 (`LICENSE`). The engine itself is AGPL-3.0-only; this package is a separate work.
Contributions to this folder are under Apache-2.0.
