# The intermittent mt crash, and the mt settings gate, 16 October 2026

Follows `docs/performance/mt-readiness-2026-10-16` (Codex 48), which left both as holds. Jack approved the
takeover from Harry on 16 October. Revisions: #4 `d57c540` (before) and `90f7847` (after), #5 `0b29300`
(before) and the cherry-pick of the same fix (after), main `76e06a8` (the #4 binary's main) and `ed35130`
(published 0.5.0). Node 24.21.0 on Jack's Windows laptop (16 logical CPUs, shared with other sessions).

## 1. The crash

### Symptom

An mt engine in a fresh process dies in its first slice: "memory access out of bounds" from a pthread
(`worker sent an error!`) with "unwind" on the engine's own thread, or the trap on the engine's thread
itself. The host reports `The slicing engine crashed: …`. Seen in Codex 45's full mt suite and once in 50 of
Codex 48's first-slice probes; never twice in a row, never on a second slice.

### Root cause

V8 (Node, and Chrome, which shares it) bounds-checks a wasm **atomic** access against the memory size the
accessing thread last saw. A thread learns of another thread's `memory.grow` only when it handles the
interrupt V8 sends it. Until then an atomic access to the new pages traps "memory access out of bounds".
Plain loads and stores do not trap, because V8's trap handler covers them with guard pages.

The mt engine starts with a 256 MB shared heap (`-sINITIAL_MEMORY=256MB`, `-sALLOW_MEMORY_GROWTH=1`). Its
first slice grows it to about 840 MB to 1 GB (measured: 836 MiB, and 840–1042 MB on 2 to 24 threads) while
every TBB thread runs. Growth on one thread, and an atomic access to the new pages from another, is
the race.

Evidence:

- `growrace/`: a 15-line wasm module and driver. The main thread grows a shared memory one page at a time and
  publishes each new page number with an atomic store. A worker waits for the number and reads the new page
  at once. With an **atomic** load it traps within 64–256 grows, every run, on Node 24.21 and Node 22.23.
  With a **plain** load it never traps, unless the trap handler is turned off (`--disable-wasm-trap-handler`).
  If the main thread waits 50 µs between growing and publishing, the trap goes away. It also never traps
  when the reader is asleep in `memory.atomic.wait32` and is woken after the grow, even with no wait.
  So the hazard is growth while other threads are running.
- Every captured engine trap (20 of 20) is the same instruction class at the same site: `i32.atomic.load`
  of a block header in wasm function 2400 of the #4 binary (2410 on main's 0.5.0, 2422 on #5). It is
  tbbmalloc's backend: a bitmap over 512 free-list bins, 12-byte bins with a byte spin lock, and
  `tryLockBlock`'s load, `< 2` test and cmpxchg to 0 (constants 16383 = slab size − 1, 1/2/4 MiB).
  libslic3r's `Points` allocate through `tbb::scalable_allocator`. The disassembly is in `llvm-objdump` of
  the published wasm (offsets 0x163b1e and 0x16382c).
- Growth is the trigger. With the heap grown before the first slice, `--disable-wasm-trap-handler` runs (which make all
  accesses bounds-checked) went from 2 crashes in 25 to 0 in 25 (`results/ab-pregrow-notrap.jsonl`).

### Not from #4

#4 changes no engine code, and its wasm is byte-identical to main `76e06a8`'s (sha256 `9b6607ee…`). The
first-slice path differs from main only by the lazy runtime import. Matched, interleaved runs crash on
both mains in the same way (below). It predates the slice field.

### Fix (host only; no engine rebuild)

`host/src/bridge.ts` `SharedHeapReserve`, used by `core.ts`. The host grows the mt heap itself, between
jobs, while the engine's threads are parked or winding down. It grows the heap to 1280 MB when the engine
starts. After a job that still grew the heap, it keeps that job's growth free above the size the job
reached before the next job. Under Node the host now finds the memory through the module's `wasmMemory`,
so `heapBytes` is reported there too.

### Fail loudly

A job that grows the heap anyway logs `Engine host: the engine's shared heap grew from A MB to B MB while
its threads ran …`. A crash after such growth carries the same words in the error's `detail`.

`test/sharedHeap.e2e.test.ts` (mt, in `npm run test:engine`) asserts that neither of two slices grows the
shared heap. It fails before the fix (`results/red-sharedHeap.txt`: "slice 1 grew the shared heap from 256
to 836.25 MiB while its threads ran") and passes after it (`results/green-sharedHeap.txt`).
`host/test/bridge.test.ts` covers the reserve: shared memory only, no compounding, the maximum, a refused
grow, and the growth named on a crash.

### Before and after

Natural crash rates on this laptop depend on its load: 2 in 30, 2 in 25, then 0 in 40 and 0 in 20 for the
same unfixed code at quieter times. That is too few for a before/after. The amplified runs use the same
binaries with one diagnostic change to the glue: it grows to exactly the size requested instead of 20 %
over (`dist-amp`, `_emscripten_resize_heap`). That gives many more growth events and so more chances to
hit the race, without changing what any thread does. Every run is a fresh process. The runs are
interleaved and every failure is kept (`results/ab-*.jsonl`, `results/crash-logs/`).

| Arm | Crashed / runs |
|---|---:|
| #4 before (`d57c540`) | 11 / 60 |
| #5 before (`0b29300`) | 1 / 20 |
| main `76e06a8` (#4's binary) | 1 / 30 |
| main `ed35130` (0.5.0 as published) | 3 / 30 |
| **#4 after** | **0 / 45** |
| **#5 after** | **0 / 20** |

Unfixed total: 16 crashed in 140 runs. Fixed total: 0 in 65 (one-sided Fisher exact p = 0.0017).
Interleaved with each other, #4 before and the mains crash at rates the samples cannot tell apart (0/15,
0/15 and 2/15 in one batch; 1/15 and 1/15 in another).

### What is left

The reserve covers a first slice of small and medium plates. A plate that needs more heap still grows it
during the job and runs the old risk; the host now logs that and names it on a crash. A nine-cylinder
test plate grew the 0.5.0-era heap to 3.5 GB.

Main has since moved to 0.6.0 (`351518f`). It routes `tbb::scalable_allocator` to malloc and keeps objects
over 4 MiB out of mimalloc's arenas. That removes this site and slows growth, but not the hazard: any
atomic access, in mimalloc's cross-thread frees or in TBB's task pools, to pages grown during a job is
exposed. Main's host has no reserve. Closing it completely needs one of these:

- a `heapSize()` binding in the engine (the bridge already declares it) reporting sbrk, so that the host
  can keep a measured reserve, or grow to the maximum without the app recycling the engine on `heapBytes`;
- or a V8 change.

On Windows, growing commits memory: this reserve adds up to about 0.4 GB of commit (untouched pages) over a
first cube slice's natural 0.85 GB.

## 2. The mt settings gate (#5's 7.19 ms)

Nothing mt runs on the settings path:

- Settings ops go to the settings lane and service.
- The engine runtime, the WebAssembly memory, the SharedArrayBuffer and Emscripten's pthread pool are
  reached only by engine ops (`core.ts` `engineOp`). `status` stays `idle` through settings, which the
  conformance suite asserts.
- Codex 48's instrumented probe counted zero imports, SharedArrayBuffers, memories, workers and worker
  messages during 1,041 views and 1,000 edits.
- This fix adds nothing there either: the reserve is made at engine load and around engine jobs.

What differs in the mt job is the CPU the engine tests take around the gate. In CI
(`results/ci-gate-excerpts.txt`):

- #5's mt job failed only node-worker's gate, at p95 7.19 ms with p50 1.28 ms. In the same run, #5's st job
  gave 2.88 ms, #4's mt job 1.20 ms and #4's st job passed.
- The node-worker gate runs in the conformance process right after the in-process and byte-stream hosts
  have loaded mt engines and sliced on them.
- Other test files slice on mt engines at the same time: `node --test` runs files in parallel on the
  4-vCPU runner, and #5 adds `printChecks.test.ts`.
- An mt engine also keeps about one core busy for 1–3 s after each job on 16 threads, against about 1 s
  for st (`mt-stress.mjs --idle-cpu`; the engine's own thread is idle then, event-loop utilisation 0).

That is contention for the runner's CPUs, not work on the settings path, so there is nothing to defer to
the first slice.

`gate-after-slice.mjs` and `gate.py` run the unchanged gate procedure right after an st or mt slice in the
same process. Local numbers taken while other sessions loaded the laptop are meaningless:
p95 11–300 ms for every arm, including the arm with no engine (`results/gate-pr5*.jsonl`). The gate, its
timing code and its threshold are unchanged. Whether to run the mt engine tests with less file parallelism
in CI changes how the gate is measured, so that is Jack's call.

## Reproduce

Paths assume Jack's laptop (`ab.py` names Codex's Node 24 runtime). Build the host with `node host/build.mjs`.
Each `cfg-*.json` names worktrees and an engine folder: a copy of `dist/` whose `engine-mt.mjs` prints
worker stacks (`dist-diag`), or that one with the exact-growth change (`dist-amp`). The edits, to a copy of
`engine-mt.mjs` only: `worker.onerror=e=>{` gains `err("MT_WORKER_STACK "+(e&&e.stack));` (dist-diag), and
`var overGrownHeapSize=oldSize*(1+.2/cutDown);` becomes `var overGrownHeapSize=requestedSize;` (dist-amp).

```sh
node growrace/grow.mjs atomic 4000      # traps; `plain` and `blocked` do not (grow.wasm: wasm-as --enable-threads grow.wat)
python ab.py fix-amp 25 results/cfg-fix-amp.json
ENGINE_VARIANT=mt node --test test/sharedHeap.e2e.test.ts
```
