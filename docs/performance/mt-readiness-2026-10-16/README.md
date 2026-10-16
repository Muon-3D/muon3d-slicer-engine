# MT settings and crash readiness, 16 October 2026

**Ready to merge: no (#4 and #5).** The unchanged gate still fails, the original MT crash remains unexplained, and both PRs conflict with current main. Upstream has already published 0.5.0 without either PR.

## Revisions and method

Jack approved takeover from Harry on 16 October. Own worktrees under `C:/Users/jack/codex48-engine-*`; no peer worktree edits. Sources: #4 `d57c540`, #5 `0b29300`, current main `ed35130`, handoff-era main control `76e06a8`. Node 24.21.0, Windows, 16 logical CPUs on the loaded shared laptop. No engine/toolchain build.

Sixteen interleaved rounds, alternating main/#4/#5-MT/#5-ST and the reverse. Each batch runs the original four-target conformance gate with its original defaults: 40 warmups, 200 timed requests, four scopes, messaging included, strict p95 <5 ms. All failures/outliers retained. Values below are milliseconds; the median p95 is the median of 16 per-run p95s. No new production optimization was made.

| Revision / variant | Target | Median p50 | Median p95 | p95 IQR | p95 range | >=5 ms |
|---|---|---:|---:|---|---|---:|
| main / mt | node-worker | 4.340 | 6.965 | 6.165-10.788 | 2.24-19.00 | 14/16 |
| main / mt | built-host | 4.215 | 6.975 | 5.890-11.318 | 5.09-23.45 | 16/16 |
| field / mt | node-worker | 4.120 | 6.860 | 4.670-9.220 | 3.43-32.04 | 12/16 |
| field / mt | built-host | 4.320 | 7.265 | 5.870-10.133 | 4.59-59.39 | 15/16 |
| checks / mt | node-worker | 4.005 | 6.685 | 4.905-10.120 | 3.55-39.07 | 12/16 |
| checks / mt | built-host | 4.115 | 6.985 | 5.935-11.547 | 4.06-26.20 | 14/16 |
| checks / st | node-worker | 4.290 | 7.210 | 5.588-14.297 | 3.05-48.16 | 13/16 |
| checks / st | built-host | 4.350 | 7.230 | 6.465-12.898 | 4.27-44.74 | 15/16 |


At least one budgeted target failed in 16/16 main, 15/16 #4 MT, 14/16 #5 MT and 15/16 #5 ST batches. These are loaded-machine observations, not idle-machine SPEC qualification or proof that a failing gate is acceptable. The comparison does not establish an MT-specific extra cost. `ENGINE_VARIANT` is consumed by the subsequent engine load test; the filtered gate runs before that load. During this campaign main's dist carried the same cached binary metadata as #4, but each built host came from its own source and no binary was loaded. Before the loaded-engine probes/full main tests, main received its exact verified published runtime.

The LF-normalized gate body hashes to `b4939526220d567ee12648ea9ff7842428e6e267decb191bb44532bc5ef8fa4f` on all four revisions. No gate, timing code, percentile, fixture, target, threshold or benchmark concurrency was changed.

## Actual MT boundary and CPU/allocation profiles

`settings-mt-probe.mjs` instruments engine imports, `SharedArrayBuffer` constructors, `WebAssembly.Memory` constructors, MT helper-worker creation and helper-worker `postMessage`. It exercises 1,041 real views and 1,000 edits with views, in four scopes. It runs on main and #5 before and after explicit MT load. In every case the settings-phase delta is zero in all five counters. Both unloaded hosts stay idle; both loaded hosts stay ready. Explicit MT load is a positive control: each allocates one WASM memory, imports the engine and starts six helpers (two requested threads plus four reserves). No claim is made that ordinary client/host transport messages disappear.

CPU/heap profiles cover the warmed 1,000 views plus 1,000 edits. Their hot settings functions are `tabView`, `lineRef`, `lineOptions` and rule evaluation. Sampled allocation traffic is about 1.946 GB on main and 1.842-1.844 GB on #5, with essentially the same total before/after MT load. This is sampling traffic, not peak memory; four instrumented runs are diagnostic, not a timing benchmark. Raw `.cpuprofile`/`.heapprofile` files and logs remain in `C:/Users/jack/codex48-engine-evidence`. The machine-readable summary is committed here.

Source tracing agrees: settings dispatch enters the settings lane/service; engine initialization, WASM shared memory and Emscripten's pool are reached by explicit engine operations. #4 and #5's settings service code is identical. The existing Codex 45 lazy-import regression remains intact. There is no evidenced settings-triggered MT work to remove, so a speculative production patch would not be justified.

## Crash investigation

Original evidence: `C:/Users/jack/codex45-engine-evidence/pr4-engine-mt.log`. After a successful MT load, the first in-process `slice: G-code, stats, toolpaths format 1, progress that never goes back` reported `worker sent an error! undefined:undefined: memory access out of bounds`; the host then returned `The slicing engine crashed: unwind`. Thirteen engine assertions cascaded from that fatal instance; two additional failures were latency assertions. That log contains no useful WASM stack/offset. Preserve it; absence in a later run is not a fix.

Full MT suites run with `--test-concurrency=1`, matching the failing local Codex 45 validation and bounding RAM. This is separate from the unchanged-default timing campaign. Every full-suite exit and assertion remains recorded:

| Run | Exit | Pass | Fail | Skip | Seconds | Crash lines |
|---|---:|---:|---:|---:|---:|---:|
| mt-full-00-field | 1 | 148 | 2 | 6 | 174.48 | 0 |
| mt-full-00-main-control | 1 | 142 | 2 | 6 | 178.92 | 0 |


Focused fresh-process first-slice repetitions: `{"field": {"failures": 0, "runs": 0}, "main": {"failures": 0, "runs": 0}, "main-control": {"failures": 0, "runs": 0}}`. Each focused attempt uses the real in-process transport, client, presets, 241 settings views, one edit, a fresh default-sized MT pool, and the original first cube slice assertions followed by a bare slice. It is narrower than a full suite and is reported separately. Worker errors capture their stack, free memory and parent memory; uncaught parent errors capture their stack. Successful focus logs also record worker count and memory. No golden, failure or crash is suppressed. A focused failure stops the recorded harness for inspection.

These results do not establish that the original crash is pre-existing on main. The historical main control shares the exact #4 C++ binary inputs; current main uses its own published binary. A failure on either control would require its own diagnosis. Without a reproduced crash/root cause, keep the crash hold open. Do not call this fixed, attributable to load, or a proven baseline defect.

## Runtime provenance and reproducibility

#4 reuses the Codex 45 SHA-256-verified runtime from Build 38880290886, binary source `4132760f1ccebafbb63325c77da60eec816c5f12`; #5 reuses Build 38881491825, source `6409ec0`. Per-variant glue/WASM hashes were verified again against the archived manifest. `git diff` confirms production `engine/` inputs match their PR source, and #4's production engine inputs match historical main (only the test runner list differs). The Orca pin is `2d1163eb6f5228de605150e3b4800081947070eb`.

Current main's published `muon3d-slicer-engine-0.5.0.tgz` hashes to `1f1b2cfcad370881655269f5540e381f87358aceb0f967e6434e91525359832f`, verified against its `SHA256SUMS`; its manifest source is exactly `ed35130d5aaa8f8226c48604cb5a0ccd3497023b`. Per-variant hashes were checked before use. Each local host was bundled from its own source. Cached binaries and small host bundles are not clean-build/offline-reproducibility qualification.

The recorded `campaign.py`, `analyse.py`, `settings-mt-probe.mjs`, `first-slice-probe.mjs` and `profile-summary.py` accompany raw JSON results. The campaign assumes this laptop's named worktrees/cache locations; the two probes accept an explicit repository root. Reproduction commands (PowerShell, Node 24):

```powershell
python C:/Users/jack/codex48-engine-evidence/campaign.py latency
python C:/Users/jack/codex48-engine-evidence/analyse.py
python C:/Users/jack/codex48-engine-evidence/campaign.py probe
python C:/Users/jack/codex48-engine-evidence/campaign.py repeat
```

## Composition, CI and decisions

Read-only `git merge-tree --write-tree` reports conflicts for both PRs against main `ed35130`. #4: `docs/PROTOCOL.md`, `engine/scripts/test-engine.mjs`, `host/src/bridge.ts`, `host/src/core.ts`, `host/src/ops.ts`, `packages/protocol/src/ops.ts`, `test/conformance/conformance.test.ts`. #5 also conflicts in `engine/bridge/slice_job.cpp`. #4+#5 alone compose cleanly. No merge was performed.

The already-published [0.5.0 release](https://github.com/Muon-3D/muon3d-slicer-engine/releases/tag/v0.5.0) points to `ed35130` and was published at 12:15:41 UTC. It uses protocol 2.3 for support avoidance/path-conflict details. #5's `docs/RELEASE_050.md` now puts its historical tag/publish sequence on hold. The supervisor must reconcile the new main features and assign unused engine/protocol versions and pins. Existing tags/assets must not be replaced.

Inherited legacy CI on the pre-documentation heads: #4 changes/checks/ST/MT/runtime passed; #5 changes/checks/ST passed, MT failed only the unchanged 7.19 ms gate (138 pass, one fail, five skip), runtime skipped. These hosted Build results do not satisfy the required bigbox lane. Required fresh self-hosted checks, composed clean runtime, offline rebuilds and idle-machine SPEC acceptance remain pending. No workflow/runner changes, dispatches or Actions artifact uploads were made. No CI wait.

Decisions: retain every red measurement; distinguish a variant label from actual engine work; use instrumented positive controls outside timing measurements; reuse only verified matching binaries; run crash tests serially with many fresh first slices; preserve an unexplained hold instead of guessing; document main/version drift without merging or selecting a replacement release number. Commits use signoff and normal pushes. No merges, tag/release changes, production or printer actions.

The documentation-fold review found no existing internal settings-latency/MT clause to change. This investigation ships no product feature and resolves no product invariant. Evidence stays with these source PRs; no speculative internal specification mark is added.
