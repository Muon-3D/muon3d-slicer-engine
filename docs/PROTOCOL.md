# Protocol v2

This is the protocol a client speaks with the Muon3D Slicer Engine's host: the messages, what each operation takes
and returns, and how the messages travel. It is normative: a client written from this document alone works with
the host, and a new host (a cloud service, a native app's runtime) that follows it works with every client.

The code of this document is [`packages/protocol`](../packages/protocol) (`@muon3d/slicer-engine-protocol`,
Apache-2.0): the TypeScript types of every message, and the helpers named below. The conformance suite
([`test/conformance`](../test/conformance)) runs every operation through every transport against those types.

**Version: 2.0.** Words such as MUST, SHOULD and MAY are used as in RFC 2119.

## Contents

1. [Principles](#1-principles)
2. [Transports](#2-transports)
3. [The envelope](#3-the-envelope)
4. [The host's lifecycle](#4-the-hosts-lifecycle)
5. [Errors](#5-errors)
6. [Operations](#6-operations)
7. [Settings](#7-settings)
8. [Data types](#8-data-types)
9. [Compatibility](#9-compatibility)
10. [A client in brief](#10-a-client-in-brief)

## 1. Principles

- **Messages only.** A client starts a host and exchanges messages with it. It never imports, evaluates or calls
  engine code, and never shares memory with it (no `SharedArrayBuffer`, no `Atomics` between client and host; the
  `mt` engine's threads share memory only among themselves).
- **Coarse, stateless operations: documents in, documents out.** No handles into the engine's objects cross the
  boundary. The host may cache (configs by hash, the loaded engine), but no request depends on another's effect
  except through what the client sends.
- **Plain data.** Every message is JSON-compatible data (objects, arrays, strings, finite numbers, booleans, `null`)
  plus typed arrays (`Uint8Array`, `Uint16Array`, `Uint32Array`, `Int*Array`, `Float32Array`, `Float64Array`) and
  `ArrayBuffer`. Nothing else: no `Map`, `Set`, `Date`, class instances, `undefined` inside arrays, `BigInt`,
  functions or `SharedArrayBuffer`. That is what lets the same messages travel over `postMessage` and over bytes.
  - configs are OrcaSlicer's own preset-file text (`key -> "text"` or `["text", ...]`);
  - meshes are float arrays (an STL's content);
  - G-code is bytes;
  - toolpaths are neutral typed arrays (a G-code parser can make the same from any slicer's file);
  - settings metadata and forms are JSON documents;
  - enums are strings.
- **No callbacks.** Progress, warnings and state changes are messages.
- **Transport-agnostic.** The host core does not know how messages travel; a transport adapter moves them. The same
  host file serves a Web Worker and a Node worker thread, and the same core serves a byte stream.

## 2. Transports

A transport carries messages between one client and one host, in order, both ways. Four are defined; the protocol
is the same on each.

| Transport | Client side | Host side | Binary data |
|---|---|---|---|
| Web Worker | `new Worker(url, { type: 'module' })` | the host file in the worker (`postMessage`) | structured clone; buffers may be transferred |
| MessagePort | a `MessagePort` whose other end reaches a host | the same | as above |
| Node `worker_threads` | `new Worker(url)` | the host file in the worker thread (`parentPort`) | as above |
| Byte stream | a WebSocket, an HTTP body, a pipe: bytes both ways | the host core behind a frame reader | frames: a JSON envelope plus binary attachments |

`packages/protocol` has an adapter for each (`workerTransport`, `nodeWorkerTransport`, `byteStreamTransport`,
`webSocketChannel`); both sides use the same adapters.

### 2.1 Workers

The client starts the host by URL, from the runtime folder of a release (or `dist/` of a build), and names it by
`manifest.json`:

```js
const base = new URL('/engine/0.2.0/', location.href);            // wherever the runtime folder is served
const manifest = await (await fetch(new URL('manifest.json', base))).json();
const worker = new Worker(new URL(manifest.host.file, base), { type: 'module', name: 'muon3d-slicer-engine' });
```

The host loads the files it needs from its own folder (the engine's `.mjs` and `.wasm`, the scripts listed in
`manifest.host.chunks`, `manifest.json`). A server MUST serve the whole runtime folder as it is. The `mt` engine
needs a cross-origin isolated page (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy:
require-corp`).

A Node program starts the same file with `new Worker(pathToFileURL(file))` from `node:worker_threads`
([`examples/start-host.mjs`](../examples/start-host.mjs)). `workerData.engineBase` MAY name another folder for the
engine files.

**Transfers.** A sender MAY list buffers to transfer instead of copy (`postMessage(message, transferList)`). The host
always transfers the buffers of its results; a client that transfers its meshes loses them (send copies of arrays it
still needs). `transferablesOf(value)` lists the buffers of a message. Transfers are an optimisation: a message means
the same with or without them.

### 2.2 Byte streams

Where no structured clone exists (a WebSocket, HTTP, a native app's pipe), each message is one **frame**. All
integers are little-endian `u32`.

| Offset | Size | Content |
|---|---|---|
| 0 | 4 | `M3SE` (ASCII) |
| 4 | 4 | the frame's length in bytes, all of it |
| 8 | 4 | `J`: the length of the JSON text |
| 12 | 4 | `N`: the number of attachments |
| 16 | 4 N | the byte length of each attachment |
| next multiple of 8 | J | the message as JSON text (UTF-8), then zero bytes to a multiple of 8 |
| then | ... | each attachment's bytes, each followed by zero bytes to a multiple of 8 |

In the JSON text, a typed array or `ArrayBuffer` is replaced by `{"$bin": <attachment index>, "type": "<type>"}`,
where `type` is `Uint8Array`, `Uint8ClampedArray`, `Int8Array`, `Uint16Array`, `Int16Array`, `Uint32Array`,
`Int32Array`, `Float32Array`, `Float64Array` or `ArrayBuffer`. No protocol value has a `$bin` key otherwise. A reader
MUST give each typed array a buffer of its own. Attachments start at multiples of 8 in the frame, so a reader MAY
view them in place instead.

- **Streams:** frames follow each other; a reader splits them by their length (`FrameReader`). Chunks may split
  frames anywhere.
- **WebSocket:** binary messages only; each message holds one or more whole frames (`webSocketChannel`). One socket
  is one connection: request ids are the socket's.
- **HTTP:** a request body is one frame (the request); the response body is the stream of frames the host sends for
  it (progress, warnings, then the result or the error), `Content-Type: application/vnd.muon3d.engine-frames`. State
  messages MAY be included. `hello` and `status` fit this as any other op.
- `encodeFrame`, `decodeFrame`, `FrameReader` and `byteStreamTransport` implement this;
  [`test/conformance`](../test/conformance) runs every operation through it.

## 3. The envelope

```ts
// client -> host
interface Request { v: 2; id: number; op: string; params: object }

// host -> client
type Response =
  | { v: 2; id: number; kind: 'result'; result: unknown }
  | { v: 2; id: number; kind: 'error'; error: EngineError }
  | { v: 2; id: number; kind: 'progress'; progress: Progress }
  | { v: 2; id: number; kind: 'warning'; warning: EngineWarning }
  | { v: 2; id: 0; kind: 'state'; state: HostState };        // unsolicited
```

- `id` is chosen by the client: an integer > 0, unique among its open requests on the connection. A message without
  a valid `id` is ignored.
- Every request gets **exactly one** `result` or `error`, with its `id`. `progress` and `warning` messages MAY come
  before it.
- `v` MUST be 2. A request with another `v` is answered with error `ProtocolMismatch`.
- `params` MUST be an object (it MAY be `{}`); an absent `params` is `{}`.
- Unknown fields in any message MUST be ignored by the receiver.

**Order.** The host serves requests in two **lanes**, each in the order received, one at a time:

| Lane | Ops |
|---|---|
| engine | `load`, `slice`, `check`, `config.definitions` |
| settings | `settings.catalogue`, `settings.view`, `settings.edit` |

`hello`, `status` and `cancel` are answered at once, outside the lanes. Results of different lanes may interleave. A
slice blocks the host while it runs (the engine is synchronous): nothing is answered during it, so a client runs
settings ops on a host of their own (they never load the engine) and keeps slicing on another.

**State messages** (`id: 0`) tell the client how the engine is: loading (with download progress), ready, dead. They
come when the state changes; `status` returns the current one.

**Progress** (`{ percent, stage?, message }`): `percent` 0 to 100, never decreasing within a request; `message` is
Orca's English text; `stage`, when present, a stable id.

**Warnings** (`{ kind, message, objects? }`): `kind` is an open set (Orca's warning step names,
`object_outside`, `exclusion_volume_path`, ...). A slice's result lists its warnings again.

## 4. The host's lifecycle

```ts
type HostState =
  | { state: 'idle' }                                   // the host runs; the engine is not loaded
  | { state: 'loading'; variant: 'st' | 'mt'; loadedBytes: number; totalBytes: number; done?: boolean }
  | { state: 'ready'; variant: 'st' | 'mt'; initMs: number; heapBytes?: number; maxHeapBytes?: number }
  | { state: 'fatal'; code: number; message: string; detail?: string };
```

- The host starts `idle`. It loads the engine (wasm) on the first op that needs it (`load`, `slice`, `check`,
  `config.definitions`), as variant `auto`, unless `load` came first. Settings ops never load it.
- **Variants:** `st` runs everywhere; `mt` needs `SharedArrayBuffer` (a cross-origin isolated page, or Node) and uses
  threads. `auto` is `mt` where it can run and is built, else `st`. `hello.variants` lists what can run.
- **Once loaded,** the variant is fixed: a `load` of the other variant fails with `BadRequest` (start another host).
- **`fatal`:** the engine could not load, or crashed (a trap, an abort, out of memory). Every later engine op fails
  at once with the same error; settings ops still work. The client SHOULD end the host and start a new one.
- **Memory:** wasm memory only grows. Results of `slice` and `check` carry `heapBytes` where the build reports it; a
  client SHOULD replace a host whose heap has grown large (for example beyond half of `hello.limits.maxHeapBytes`).
- **Ending a host** is the client's: terminate the worker, close the socket. There is no shutdown op.

## 5. Errors

```ts
interface EngineError { code: number; message: string; objects?: string[]; detail?: string }
```

| Code | Name | Meaning |
|---|---|---|
| 1 | `Internal` | The engine crashed (the host is `fatal` afterwards), or the host failed |
| 2 | `OutOfMemory` | The engine ran out of memory (the host is `fatal` afterwards) |
| 3 | `Cancelled` | The request was cancelled before it ran |
| 4 | `Unsupported` | Unknown op, or an op or field this host does not support |
| 5 | `BadRequest` | The request is malformed; `message` says what |
| 6 | `NotLoaded` | The op needs the engine, which could not be loaded (`detail`: the runtime's own error) |
| 7 | `ProtocolMismatch` | The client's protocol major is not the host's; `detail` lists the majors served, e.g. `"2"` |
| 8 | `NotCached` | A config was named by a hash the host does not hold: send it again with the config |
| < 0 | Orca's | OrcaSlicer's CLI exit codes, passed through (below) |

Negative codes are Orca refusing a job; the engine stays loaded. `message` is Orca's English text and `objects`
names the objects it concerns. Codes seen today: -5 bad config, -17 incompatible process, -18 invalid values, -50
nothing on the plate, -51 validation error, -52 partly outside the plate, -63/-64 collisions (also exclusion
volumes), -100 slicing error, -102 unprintable area. New codes may appear: a client SHOULD treat an unknown negative
code as "Orca refused the job" and show `message`.

## 6. Operations

| Op | Lane | Needs the engine | Purpose |
|---|---|---|---|
| `hello` | at once | no | Handshake: protocol, engine, licence, source, capabilities, variants, limits |
| `load` | engine | yes | Load the engine now (a variant, threads) |
| `status` | at once | no | The host's state |
| `cancel` | at once | no | Cancel a queued request |
| `slice` | engine | yes | Configs + placed objects -> G-code, stats, toolpaths, warnings |
| `check` | engine | yes | Orca's placement checks per object: inside the plate, exclusion volumes |
| `config.definitions` | engine | yes | Orca's option table (format 1) |
| `settings.catalogue` | settings | no | Every option's text and Orca's tab layout (format 2) |
| `settings.view` | settings | no | A settings form for the current values (format 1) |
| `settings.edit` | settings | no | What an edit writes, with Orca's edit handlers, questions and notices |

### 6.1 `hello`

```ts
params: { protocol: { major: 2, minMinor?: number }, client: { name: string, version: string } }
result: {
  protocol: { major: 2, minor: 0 },
  engine: {
    name: string,                // "Muon3D Slicer Engine (based on OrcaSlicer)"
    version: string,             // this release, e.g. "0.2.0"
    orca: { version: string, commit: string, repository: string },
    license: 'AGPL-3.0-only',
    source: string,              // this build's source: the repository at the commit the host was built from
    notice: string,              // URL of NOTICE, served next to the host
    canary: string,              // a string unique to the host (a client's own bundle must not contain it)
    commit: string,              // the engine repository's commit the host was built from
  },
  capabilities: string[],        // every op, and the sub-features below
  variants: ('st' | 'mt')[],     // what can run here
  limits: { maxThreads: number, maxHeapBytes: number },
  formats: { definitions: 1, catalogue: 2, toolpaths: 1, settingsView: 1 },
}
```

A client SHOULD say `hello` first and check the answer (`negotiate(hello, { minMinor, required })`). A different
`protocol.major` fails with `ProtocolMismatch`. An About or licences screen can show `engine.name`, `version`,
`license`, `source` and `notice`.

**Capabilities** (2.0): the ten op names, plus

| Capability | Means |
|---|---|
| `toolpaths.v1` | `slice` returns toolpaths format 1 |
| `slice.toolpathExtras` | `SliceParams.output.toolpathExtras` and `SliceResult.toolpathExtras` |
| `mesh.indexed` | `Mesh.indices` (indexed meshes) in `slice` and `check` |
| `settings.view.v1` | `settings.view` format 1 |
| `cancel.cooperative` | (not in 2.0) a running request can be cancelled and the engine stays loaded |

A client MUST send an op, or a field, only when `hello` lists its capability (the 2.0 ops and fields above are
always there). Unknown capability strings MUST be ignored.

### 6.2 `load`

```ts
params: { variant?: 'st' | 'mt' | 'auto', threads?: number, base?: string }
result: { variant: 'st' | 'mt', initMs: number }
```

Loads the engine now instead of on the first op that needs it (a warm-up). `threads` caps `mt`'s threads; `base`
names another folder with the engine files (default: the host's own). State messages report the download
(`loading`, with bytes) and the result (`ready` or `fatal`). A second `load` answers with the first's result.
Fails with `NotLoaded` when the engine cannot load, `BadRequest` for a variant other than the loaded one or `mt`
where it cannot run.

### 6.3 `status`

`params: {}`; result: the `HostState` (section 4), with `heapBytes` when ready and known.

### 6.4 `cancel`

```ts
params: { target: number }         // the id of the request to cancel
result: { accepted: boolean }
```

A request still queued is taken out of its lane and ends with error `Cancelled` (sent before the `cancel`'s result);
`accepted` is true. A request that is running or has finished cannot be cancelled here: `accepted` is false. To stop a
running slice, end the host (terminate the worker) and start another; the engine's download comes from the browser's
cache.

### 6.5 `slice`

```ts
params: {
  configs: { machine: Config, process: Config, filaments: Config[] },   // flattened presets (section 8)
  objects: PlateObject[],
  output?: { toolpaths?: boolean, toolpathExtras?: boolean },          // both default true
}
PlateObject = { name: string, mesh: Mesh, config?: ConfigPatch }
result: {
  gcode: Uint8Array,                 // as Orca writes it
  stats: GcodeStats,
  toolpaths: Toolpaths | null,       // null when output.toolpaths is false
  toolpathExtras: ToolpathExtras | null,
  warnings: EngineWarning[],
  timings: { load: number, slice: number, export: number, total: number },   // ms
  heapBytes?: number,
}
```

- `objects[].name` is the name Orca writes in the G-code (`EXCLUDE_OBJECT_DEFINE NAME=...`); Orca's CLI uses the STL
  file name, e.g. `"Benchy.stl"`.
- `objects[].mesh` is in bed coordinates (mm, +Z up, origin at the printable area's front-left), resting on z = 0:
  the client applies its placement. A soup (no `indices`) is 9 floats per triangle; an indexed mesh is expanded.
- `objects[].config` is the object's own settings (a per-object key: `objectKeys` or `regionKeys` of
  `config.definitions`) in Orca's text, applied as Orca's 3MF loader does. An unknown key or a bad value fails the
  job with -5, naming the object.
- The configs are the presets exactly as Orca's CLI takes them: inheritance resolved (no `inherits`),
  `from: "system"`, a `type`, overrides already applied.
- Progress comes as `progress` messages, Orca's warnings as `warning` messages (and in `warnings`).
- The same request gives the same G-code bytes on every host of one release, `st` and `mt` alike, the
  `; generated by` header line (which holds the time) aside.

### 6.6 `check`

```ts
params: { configs: ConfigSet, objects: Array<{ name: string, mesh: Mesh }> }
result: {
  objects: Array<{
    name: string,
    inside: boolean,                                   // fully inside the printable volume (Orca's check_outside)
    exclusionHits: Array<{ extruder: number, region: number, triangles: Float32Array }>,
  }>,
  heapBytes?: number,
}
```

`exclusionHits` names each exclusion volume an object intersects, with the intersecting surface (bed coordinates, a
triangle soup) for drawing. The host keeps meshes between checks internally, so repeating a check with a moved
object is fast.

### 6.7 `config.definitions`

`params: {}`; result: Orca's option table, format 1 (`ConfigDefinitions`): every FFF and common option (type,
labels, tooltip, unit, limits, enum values and labels, default, mode, GUI hints) and the key sets libslic3r defines:
which preset stores each key (`presetKeys`), per-extruder and per-variant keys, the filament override keys, and the
keys an object (`objectKeys`) or a part (`regionKeys`) can override. Read from the very engine that slices.

### 6.8 `settings.catalogue`

`params: { locale?: string }` (only English exists); result: the settings catalogue, format 2
(`SettingsCatalogue`): every option's definition trimmed for forms (label, full label, tooltip, unit, category,
mode, limits, enum values and labels, default, slot kind, per-object flag) and the layout of Orca's Process, Filament
and Printer tabs (pages, groups, lines, the options of each line, which slot a line edits, Orca's own widgets), and
Orca's plate settings dialog. It describes Orca only: what one app lets its users edit is that app's own policy.
Needs no wasm.

### 6.9 `settings.view` and `settings.edit`

Section 7.

## 7. Settings

The settings service evaluates Orca's own settings logic, ported into the engine: its rules (which rows are hidden
or greyed for the current values, narrowed enums, labels Orca changes), the checks Orca shows as dialogs, the values
Orca changes along with an edit, the tabs' layout behaviour (rows per mode, pages per printer, one Extruder page per
nozzle, the nozzle picker, the machine limits' silent column, the filament overrides), an object's settings (the
object-scope part of Orca's object settings) and a plate's settings. A client renders the documents generically and
applies the writes; it holds no Orca logic.

The client keeps the values (its presets, its overrides) and sends them with each request. Presets travel once and
then by hash.

### 7.1 Inputs

Every `settings.view` and `settings.edit` request carries:

```ts
{
  presets: { machine: ConfigRef, process: ConfigRef, filament: ConfigRef },   // the filament of slot 0
  overrides?: { process?: ConfigPatch, filament?: ConfigPatch, machine?: ConfigPatch },   // the user's changes
  plate?: ConfigPatch,           // the active plate's own settings (curr_bed_type, print_sequence, spiral_mode, ...)
  object?: ConfigPatch,          // scope 'object': the object's own settings
  objects?: Array<{ id: string, settings?: ConfigPatch }>,   // scope 'plate': the plate's objects
  env?: {
    mode?: 'simple' | 'advanced' | 'expert',   // default 'advanced'
    vendor?: string,                            // the printer's vendor folder; 'BBL' turns on Orca's Bambu rules
    filamentCount?: number,                     // default 1
    supportsWrappingDetection?: boolean,
    bedType?: { default: string, selectable: boolean },   // the printer's plate type
    objectCount?: number,                       // scope 'plate' (default: objects.length)
    extruder?: number,                          // the nozzle whose values per-variant rows show (default 0)
    frequent?: string[],                        // scope 'object': the add list's "Frequent" group
  },
}
ConfigRef = { hash: string, config?: Config }
```

- **Configs by hash.** `hash` is any string the client derives from a config's content; two different configs MUST
  NOT share one (`configHash(config)` in the package). Send `config` the first time; later send the hash alone. The
  host keeps the last 32 configs; a hash it does not hold fails with `NotCached`, and the client sends the configs
  again. `SettingsClient` in the package does all of this.
- **Overrides** are Orca's serialized text of the whole value: comma-separated slots for a vector (`"0.4,0.6"`; one
  value means every slot), `"1"`/`"0"` for booleans, `"15%"`, points `"10x20"`, text lists as Orca writes them.
  `"nil"` leaves a slot of a nullable option unset (filament overrides).

### 7.2 `settings.view`

```ts
params: SettingsInput & {
  scope: 'process' | 'filament' | 'machine' | 'object' | 'plate',
  version?: number,        // echoed: the client's revision of the values
  omit?: string[],         // keys the client never shows (its own policy): left out of the form and the state
  form?: string,           // the formId the client holds: the form is then left out
  values?: boolean,        // include each cell's value text
}
result: SettingsView
```

A **document** has a static part, the `form` (text and layout: it depends only on the engine build, the scope and
`omit`), and the dynamic state for the current values:

```ts
interface SettingsView {
  format: 1,
  scope: 'process' | 'filament' | 'machine' | 'object' | 'plate',
  version: number | null,
  formId: string,
  form?: SettingsForm,       // left out when the request named this formId
  tab?: TabView,             // preset scopes
  object?: ObjectView,       // scope 'object'
  plate?: PlateView,         // scope 'plate'
  issues: SettingIssue[],
}
```

The client caches the form under `formId` and sends that id as `form` with later requests, so a per-edit response
carries only the dynamic state (a few kilobytes). The host answers the dynamic state within 5 ms at p95, messaging
included (the conformance suite measures it).

#### The form

```ts
interface SettingsForm {
  format: 1, id: string, scope: string, omit: string[],
  options: Record<string, FormOption>,     // every option the rows use
  pages?: FormPage[],                      // preset scopes: every page, every mode
  categories?: { title: string, keys: string[] }[],   // 'object': what an object can have, by Orca category
  frequent?: string[],                     // 'object': Orca's frequent object settings
  lines?: FormLine[],                      // 'plate': one row per option
}
interface FormOption {
  key: string, type: OrcaOptionType, control: ControlKind, label: string, fullLabel?: string, tooltip?: string,
  unit?: string, mode: 'simple' | 'advanced' | 'expert' | 'develop', category?: string, min?: number, max?: number,
  maxLiteral?: number, ratioOver?: string, enum?: { value: string, label: string }[], openEnum?: true,
  multiline?: true, code?: true, serialized?: true, nullable?: true, slots?: SlotKind, readOnly?: true,
  default?: string | string[],
}
interface FormPage { id: string, title: string, groups: FormGroup[], repeat?: 'extruder', when?: { key: string, oneOf: string[] }, other?: true }
interface FormGroup { id: string, title: string, lines: FormLine[] }
interface FormLine {
  id: string,                  // unique in the form: "<page>/<group>/<n>"
  label: string, tooltip?: string, mode: string,
  options: { key: string, label: string, index?: number | 'extruder', tooltip?: string }[],
  widget?: 'bedShape' | 'excludeArea' | 'ramming' | 'compatible' | 'custom',   // Orca shows its own control here
  overrideOf?: { scope: 'machine' | 'process', key: string },   // a filament override row
  modeColumns?: true,          // a machine limit: normal and silent columns
}
```

`control` is the control a cell edits one slot with: `number`, `floatOrPercent` (a number or a percentage),
`bool`, `enum`, `suggest` (a text box with suggestions: values beyond `enum` are allowed), `text`, `code`
(multi-line), `color`, `point`. `unit` is Orca's side text ("mm/s", "mm/s or %"). A row's tooltip is the line's,
else its first option's.

For scope `object`, `options[key].label` is a label that stands on its own ("Outer wall speed", where the tab shows
"Outer wall" under a Speed heading).

#### A preset tab: `TabView`

```ts
interface TabView {
  pages: ViewPage[],           // the page strip, in order
  inactivePages: string[],     // form pages this printer does not have (their `when` fails)
  extruders: number,           // the printer's nozzles
  extruder: number,            // the nozzle per-variant rows show
}
interface ViewPage {
  id: string,                  // the form page's id, or "<page>#<n>" for nozzle n's Extruder page
  page: string, title: string, extruder?: number,
  nozzlePicker?: true,         // rows of per-variant settings, several nozzles: show a nozzle picker
  issues?: number,             // warnings and errors about settings on the page
  groups: { id: string, lines: ViewLine[] }[],
  hiddenLines?: string[],      // rows Orca's rules hide now (a search shows them greyed)
}
interface ViewLine { id: string, label?: string, cells: ViewCell[], locked?: true }
interface ViewCell {
  key: string,
  index?: number,              // the slot the cell edits; absent: the option as a whole
  label?: string,              // "Normal"/"Silent" for the machine limits' two columns
  disabled?: true,             // greyed out
  choices?: string[],          // the enum values offered now, in this order
  value?: string,              // (values) the slot's text in effect
  inherited?: string,          // (values) a filament override row: what an unset (nil) slot uses
}
```

**Rendering.** For each `ViewPage` in `pages` (the page strip): for each group, look up the form group by
`(page, group.id)` for its title; for each line, look up the `FormLine` by `line.id`. The row's label is
`line.label ?? formLine.label`. Each cell is one control: its option is `form.options[cell.key]`; its label in a row
of several is `cell.label ?? formLine.options[i].label`. Only what the state lists is shown: rows hidden by the mode
or by Orca's rules, and pages the printer does not have, are not in it.

- A row with `overrideOf` is a filament override: a checkbox (greyed when `locked`) switches the slot between the
  filament's own value and `"nil"` (unset, which uses `inherited`).
- `nozzlePicker`: the page's per-variant rows show nozzle `extruder`'s values; the picker sends `env.extruder`.
- An Extruder page (`extruder` set) is one per nozzle; its cells' `index` is that nozzle's slot.
- Machine limits (`modeColumns`) with the printer's silent mode on come as two cells per option, "Normal" (slot
  i) and "Silent" (slot i + 1); with it off, one cell.

Example (M1 presets, Advanced, `layer_height` overridden to 0.5, values on; trimmed):

```json
{
  "format": 1, "scope": "process", "version": 12, "formId": "process:d56c473211924b2f",
  "tab": {
    "pages": [{
      "id": "quality", "page": "quality", "title": "Quality", "issues": 1,
      "groups": [{
        "id": "quality.layer-height",
        "lines": [
          { "id": "quality/quality.layer-height/0", "cells": [{ "key": "layer_height", "value": "0.5" }] },
          { "id": "quality/quality.layer-height/1", "cells": [{ "key": "initial_layer_print_height", "value": "0.2" }] }
        ]
      }],
      "hiddenLines": ["quality/quality.seam/4", "quality/quality.seam/5"]
    }],
    "inactivePages": [], "extruders": 1, "extruder": 0
  },
  "issues": [{
    "id": "layer-height-limits", "scope": "process", "key": "layer_height",
    "keys": ["layer_height", "min_layer_height", "max_layer_height"], "severity": "warning",
    "message": "Layer height is outside the limits set in Printer Settings -> Extruder -> Layer height limits, this may cause printing quality issues.",
    "fix": { "layer_height": "0.32" }, "fixLabel": "Adjust to 0.32 mm", "checkedOn": ["layer_height"]
  }]
}
```

with the form (sent once; trimmed):

```json
{
  "format": 1, "id": "process:d56c473211924b2f", "scope": "process", "omit": [],
  "options": {
    "layer_height": { "key": "layer_height", "type": "float", "control": "number", "label": "Layer height",
      "mode": "simple", "tooltip": "This is the height for each layer. ...", "unit": "mm", "category": "Quality",
      "min": 0, "default": "0.2" },
    "seam_position": { "key": "seam_position", "type": "enum", "control": "enum", "label": "Seam position",
      "mode": "simple", "enum": [{ "value": "nearest", "label": "Nearest" }, { "value": "aligned", "label": "Aligned" }],
      "default": "aligned" }
  },
  "pages": [{ "id": "quality", "title": "Quality", "groups": [{ "id": "quality.layer-height", "title": "Layer height",
    "lines": [{ "id": "quality/quality.layer-height/0", "label": "Layer height", "mode": "simple",
      "options": [{ "key": "layer_height", "label": "Layer height" }] }] }] }]
}
```

A filament override row (Expert):

```json
{ "id": "setting-overrides/setting-overrides.retraction/0",
  "cells": [{ "key": "filament_retraction_length", "index": 0, "disabled": true, "value": "nil", "inherited": "0.4" }] }
```

#### An object's settings: `ObjectView`

```ts
interface ObjectView {
  groups: { title: string, rows: ObjectRow[] }[],   // the object's own settings by category; unknown keys last ("Other")
  add: { title: string, keys: string[] }[],        // the add list: "Frequent", then every category (develop options in Expert only)
  limits: { layerHeight: { min?: number, max?: number } },
}
interface ObjectRow {
  key: string,
  unknown?: true,                    // not a setting an object can have (keep it, show it by key, removable)
  label?: string,                    // Orca renamed it for the current values
  disabled?: 'rules' | 'support',    // greyed by Orca's rules, or a support setting while supports are off
  choices?: string[],
  value?: string, inherited?: string,  // (values) its own value, and the value without it (the plate's, else global)
}
```

A row's label is `row.label ?? form.options[key].label`. Issues are those the object's own settings cause (on one of
its settings, or new with them); `fixable` is false when a fix touches a setting an object cannot have (apply it to
the global settings instead).

#### A plate's settings: `PlateView`

```ts
interface PlateView { rows: { key: string, value?: string, global: string, choices?: string[] }[] }
```

One row per option of Orca's plate settings dialog (`form.lines`): the plate's own value, or none ("same as
global", showing `global`). Issue `spiral-vase-by-object` (an error) says Orca refuses spiral vase with several
objects printed layer by layer; its fix is `print_sequence: "by object"`.

#### Issues

```ts
interface SettingIssue {
  id: string,                  // stable id of the check: an open set
  scope: 'process' | 'filament' | 'machine',   // the preset the keys and the fix belong to
  key: string, keys: string[], // the row it is shown on; every key involved
  severity: 'error' | 'warning' | 'info',
  message: string,             // Orca's English text
  fix?: ConfigPatch, fixLabel?: string,        // Orca's "Yes", or its automatic reset: apply with settings.edit
  alternative?: { label: string, values: ConfigPatch },   // Orca's "No", when it also changes values
  triggers?: string[],         // severity 'info', a silent rewrite: editing one of these keys applies `fix`
  checkedOn?: string[],        // a check Orca makes only when one of these keys is edited
  fixable?: boolean,           // scope 'object' (above)
}
```

`error`: Orca refuses the value and resets it (an OK-only dialog). `warning`: Orca asks or warns. `info`: Orca changes
values silently; `settings.edit` already applies those when the user edits a trigger, so a client normally shows only
errors and warnings. None of them blocks slicing.

### 7.3 `settings.edit`

```ts
params: SettingsInput & {
  scope: 'process' | 'filament' | 'machine' | 'object' | 'plate',
  edit:
    | { set: string, value: string, index?: number }     // the user set slot `index` of `set` (absent: the whole value)
    | { apply: ConfigPatch, objects?: { id: string, values: ConfigPatch }[] }   // a fix's or a choice's values
    | { reset: { key: string, index?: number }[] }       // back to the preset's (preset scopes), or remove (object, plate)
    | { add: string },                                   // scope 'object': add a setting with its current value
  version?: number,
  view?: boolean | { omit?: string[], form?: string, values?: boolean },   // also return the document after the edit
}
result: {
  version: number | null,
  writes: Record<string, string | null>,   // the edited scope's store: text to set, or null to remove
  objects?: { id: string, writes: Record<string, string | null> }[],   // scope 'plate': writes to its objects
  prompts: SettingPrompt[],
  notices: string[],                       // what Orca told the user about a value it changed at once
  view?: SettingsView,                     // params.view: the document with the writes applied
}
SettingPrompt = {
  id: string, scope: string, key: string, message: string,
  choices: { label: string, values: ConfigPatch, objects?: { id: string, values: ConfigPatch }[] }[],
  blocking?: true,
}
```

- **`set`** runs Orca's edit handlers: the edited value (Orca may clamp or replace it, e.g. a layer height of 0
  becomes the printer's minimum, with a notice), the values Orca changes along with it, and the silent rewrites the
  edit starts, all in the edited scope. `index` edits one slot; a value standing for every slot is spread first.
- **`writes`** is what the client applies to its store, in one undo step: preset scopes write the preset's overrides
  (null: the override goes, the preset's value is back); `object` writes the object's settings; `plate` the plate's.
  A write that changes nothing is left out. For an object, only keys an object can have are written.
- **`prompts`** are Orca's questions about the edit. The edit is already in `writes`; the first choice is Orca's
  default (usually `values: {}`: keep it); another choice's `values` are applied with `{ apply }`. A `blocking` prompt
  (turning spiral vase on for a plate) wrote nothing: its first choice makes the edit (with `objects`: what each of
  the plate's objects gets), the other cancels it.
- **`apply`** writes whole values, without handlers (a fix, an answer). For an object, values an object cannot have
  fail with `BadRequest`.
- **Version stamps.** The host echoes `version`. A client keeps one serial queue of edits, sends each with the
  revision it was made on, applies the writes optimistically, and drops a result (or a view) older than its current
  revision. Two edits in one event go in order.

Example (`set` of `sparse_infill_rotate_template` with a gyroid infill):

```json
{
  "version": null,
  "writes": { "sparse_infill_rotate_template": "0,90" },
  "prompts": [{
    "id": "sparse-infill-rotate-template", "scope": "process", "key": "sparse_infill_rotate_template",
    "message": "Infill patterns are typically designed to handle rotation automatically ... Are you sure you want to enable this option?",
    "choices": [{ "label": "Enable", "values": {} }, { "label": "Cancel", "values": { "sparse_infill_rotate_template": "" } }]
  }],
  "notices": []
}
```

## 8. Data types

```ts
type ConfigValue = string | string[];              // Orca's text: a string, or one string per slot
type Config = Record<string, ConfigValue>;         // a preset, as Orca's preset .json files hold it
type ConfigPatch = Record<string, string>;         // single values in Orca's serialized text
interface ConfigSet { machine: Config; process: Config; filaments: Config[] }
interface Mesh { positions: Float32Array; indices?: Uint32Array }   // mm; a soup without indices

interface GcodeStats {
  printTimeSeconds: number | null; printTimeText: string | null; firstLayerTimeText: string | null;
  filamentMm: number | null; filamentCm3: number | null; filamentG: number | null; filamentCost: number | null;
  layers: number | null; maxZ: number | null;
}

interface Toolpaths {                               // format 1
  format: 1;
  layerCount: number;
  layerZ: Float32Array;                             // print height of each layer
  extrusions: SegmentSet & { roleIndex: Uint8Array; width: Uint8Array; height: Uint8Array };
  travels: SegmentSet;
  roles: { name: string; lengthMm: number }[];      // as named after ';TYPE:', first-seen order
  lineWidth: number | null;                         // the width most of the length is printed at
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
}
interface SegmentSet {
  positions: Float32Array;                          // 6 floats a segment: x0 y0 z0 x1 y1 z1, layer order
  layerStart: Uint32Array;                          // layerCount + 1 entries: each layer's first segment; last = count
  count: number;
}
interface ToolpathExtras {                          // parallel to extrusions
  feedrate: Float32Array; fanSpeed: Uint8Array; temperature: Uint16Array; time: Float32Array; height: Float32Array;
}
```

Width and height codes: 0.01 mm steps up to 2 mm (code 200), then 0.05 mm steps up to 4.75 mm (255); 0 unknown
(use `lineWidth`). A segment's z is the top of its bead.

**Option keys are data, not protocol.** An Orca upgrade may add or remove options; a client MUST tolerate unknown
keys and missing ones.

## 9. Compatibility

1. **Major** = breaking, **minor** = additive. A host speaks one major (two during a planned transition). A client
   names the lowest minor it needs in `hello`.
2. **Requests:** new fields are optional, and their defaults keep the old behaviour. Hosts ignore unknown fields. A
   client sends a new op or field only when `hello` lists its capability.
3. **Responses:** new fields may appear; clients ignore unknown ones. String enums (warning kinds, stages, roles,
   issue and prompt ids) are open sets. Unknown error codes are handled generically.
4. **Data formats** carry their own `format` number (definitions 1, catalogue 2, toolpaths 1, settings view 1). A new
   format ships as a new capability the client opts into.
5. **Deprecation:** an op or field is marked deprecated for at least one minor before a major removes it.
6. **Conformance:** the engine repository runs every op through every transport against `packages/protocol`
   (`npm run test:conformance`; the engine part with `npm run test:engine`). A client's fake engine type-checks
   against the same package.

The package's version follows the protocol: 2.0.x is protocol 2.0.

## 10. A client in brief

With the package:

```ts
import { EngineConnection, SettingsClient, workerTransport } from '@muon3d/slicer-engine-protocol';

const engine = new EngineConnection(workerTransport(new Worker(hostUrl, { type: 'module' })), {
  onState: (s) => console.log('engine', s.state),
});
await engine.open({ name: 'my-app', version: '1.0.0' }, { required: ['slice', 'settings.view'] });

const sliced = await engine.request('slice', { configs, objects: [{ name: 'Cube.stl', mesh: { positions } }] }, {
  onProgress: (p) => console.log(p.percent, p.message),
});

const settings = new SettingsClient(engine);          // better: on a host of its own
const view = await settings.view({ scope: 'process', presets: { machine, process, filament }, overrides, env: { mode: 'advanced' } });
const edit = await settings.edit({ scope: 'process', presets: { machine, process, filament }, overrides, edit: { set: 'layer_height', value: '0.12' }, view: true });
```

Without it, over any transport: send `{ v: 2, id: 1, op: 'hello', params: { protocol: { major: 2 }, client } }`, keep a
map of open ids, route `progress` and `warning` by id, resolve on `result`, reject on `error`, watch `state`
messages. [`examples/node-cli`](../examples/node-cli) and [`examples/settings-cli`](../examples/settings-cli) are
complete clients.
