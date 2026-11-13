# Settings latency review, 16 October 2026

The optimized PRs have median per-run p95 below 5 ms on both worker targets. Neither is consistently green: keep both draft PRs on hold. No merges, tags, releases or printer actions were performed.

## Method and measurements

Windows on the shared 16 GB laptop, Node 24.21.0. Main 76e06a8; before #4 0a3f5e8 and #5 ef62300; after source fixes #4 bfcfa4b and #5 3b5b79b. Each phase ran 16 rounds, alternating main/#4/#5 then #5/#4/main. The same existing conformance test and transports ran on all revisions. Each target used the original 40 warmups and 200 timed requests, four cycling scopes, client hashing/caching, worker messaging, percentile calculation and strict p95 < 5 ms assertion. There were 3,200 timed requests per target/revision/phase (76,800 total across four transports and two phases). All runs, including failures and large outliers, are retained. Logs print two decimal places; summaries use those existing outputs.

Command in each checkout, invoked without extra test concurrency, CPU affinity, priority, timing instrumentation, retries or threshold overrides:

```sh
node --test '--test-name-pattern=settings.view: the dynamic state within' test/conformance/conformance.test.ts
```

Values below are milliseconds. A median is the median of 16 per-run p95s, not a pooled request p95. IQR uses Python statistics.quantiles (exclusive); range is min-max. The in-process and byte-stream diagnostic results, all p50s, timestamps, run order and exits are in the adjacent JSON files.
Only node-worker and built-host enforce the 5 ms assertion; in-process and byte-stream are diagnostic. JSON summary `failures` counts p95 >= 5 (including diagnostic targets); actual command exits are retained in the per-run data and checked against worker threshold failures. No worker result rounded to exactly 5.00 ms.

The takeover's historical gate figures were 5.91 ms for #4 and 5.73 ms for #5. They are not used as the local before baseline because the environments and loads differ.

| Revision | Target | Before median p95 | Before IQR; range | After median p95 | After IQR; range | Failures before -> after |
|---|---|---:|---|---:|---|---:|
| main | node-worker | 12.52 | 6.22-25.11; 5.48-108.50 | 6.04 | 3.96-10.65; 3.02-19.18 | 16/16 -> 9/16 |
| main | built-host | 13.08 | 6.86-27.78; 2.95-93.91 | 5.61 | 3.70-8.81; 2.55-39.10 | 15/16 -> 8/16 |
| PR #4 | node-worker | 15.75 | 6.12-28.57; 3.39-77.52 | 3.94 | 2.69-6.85; 2.46-42.02 | 14/16 -> 7/16 |
| PR #4 | built-host | 12.09 | 6.39-21.18; 3.89-50.92 | 4.55 | 2.90-7.10; 2.41-51.85 | 14/16 -> 7/16 |
| PR #5 | node-worker | 13.90 | 7.40-19.00; 4.87-81.29 | 3.91 | 3.17-5.17; 2.64-90.38 | 15/16 -> 5/16 |
| PR #5 | built-host | 9.85 | 6.83-15.86; 4.51-47.66 | 3.71 | 2.93-5.69; 2.40-17.58 | 14/16 -> 5/16 |

At least one gate target failed in 16/16 main runs, 14/16 #4 runs and 15/16 #5 runs; after, at least one failed in 9/16 main runs, 8/16 #4 runs and 6/16 #5 runs (out of 16 each).

Main itself was far above the unchanged gate before and remained above it in the after campaign. Its median p95 also fell substantially between campaigns, so the absolute PR before/after improvement cannot all be credited to code. The overlapping before distributions do not establish a new warmed settings regression caused by either capability. Interleaving balances drift but cannot make a shared scheduler deterministic. Some diagnostic commands/tests and other sessions ran during these campaigns; no laptop-load control or outlier filtering was applied.

## What the code and profiles establish

The settings service, model/view implementation and protocol client were byte-identical on main and the two original heads. Config hashes already use an immutable-object WeakMap; static capabilities are built once; settings replies never walk field buffers or run field/check serialization. The field builder is called only from a slice with sliceField requested. Print checks run in the C++ slice, never in settings. There was no measured evidence of new per-change field/check work.

There was a real eager import regression: #4 made bridge.ts and ops.ts import the field builder/codec, and core.ts loaded that entire engine graph for a settings worker. Main's built entry was 42,461 bytes versus #4's 63,423 and #5's 64,274. The fix moves the graph into a cached dynamic engineRuntime import on the first engine operation. A small shared BadRequest class preserves error identity. Settings requests do not touch the runtime promise. A loader-hook test first failed on the original branch and now proves views/edits work while all bridge/ops/profiles/config-definition/field modules are forbidden. This removes startup/compilation work; it is not presented as a warmed p95 explanation. The #4 built entry falls to 19,526 bytes; #5 to 19,831. Slicing pays for the separate engine chunk once. Field sampling and check allocations remain confined to their existing slice paths; default print-check behavior is preserved.

CPU and allocation profiles of 4,000 real service views identified existing layout/rule allocation churn. The fixes reuse the nozzle's variant index within one view (scalar closure state; no added map or array per change), and avoid flattening every page into arrays/a Set merely to count zero issues. No whole-view cache or benchmark-specific shortcut was added. Each new view recomputes against current presets/overrides. The new regression test observed 200 variant-table reads before and one after for 200 row resolutions, and checks independent silent slots, nozzle switches and changed overrides. Existing view/rule goldens verify output equivalence.
The direct service profile used #4 before/after; #5 has byte-identical settings code, verified by git diff.

V8 sampling at 16 KiB, including objects collected by major/minor GC, estimated 1,656,892,160 allocated bytes before versus 1,509,603,744 after over the same 4,000 views: 8.9% less allocation traffic. These are sampled allocation estimates, not retained/peak memory. CPU samples in indexForExtruder fell from 61 to 9; total samples 4,003 to 2,419. Profiled wall times (6.50 vs 3.84 s) are diagnostic only, with profiler overhead and changing load. Raw profiles/logs remain in C:/Users/jack/codex45-engine-evidence, not in the release package.

## Validation and limits

- `pr4-validation-host`: exit 0; 
- `pr4-imports`: exit 0; 
- `pr4-types`: exit 0; 
- `pr4-protocol-types`: exit 0; 
- `pr4-tests`: exit 1; tests 197, pass 194, fail 2, cancelled 0, skipped 1
- `pr4-engine-st`: exit 1; tests 156, pass 148, fail 2, cancelled 0, skipped 6
- `pr4-engine-mt`: exit 1; tests 156, pass 135, fail 15, cancelled 0, skipped 6
- `pr5-validation-host`: exit 0; 
- `pr5-imports`: exit 0; 
- `pr5-types`: exit 0; 
- `pr5-protocol-types`: exit 0; 
- `pr5-tests`: exit 1; tests 198, pass 195, fail 2, cancelled 0, skipped 1
- `pr5-engine-st`: exit 1; tests 169, pass 161, fail 2, cancelled 0, skipped 6
- `pr5-engine-mt`: exit 1; tests 169, pass 161, fail 2, cancelled 0, skipped 6

PR #4 MT hit a memory-access crash on the first in-process slice, causing 13 engine test failures plus two latency failures (135 pass, 15 fail, six skip). One full MT conformance control on the unmodified #4 host at 0a3f5e8 with the same verified binary did not reproduce the memory-access failure: tests 100, pass 95, fail 2, cancelled 0, skipped 3. Its cause remains unresolved; do not attribute it to load or call it baseline. Keep the MT hold pending independent reproduction and fresh Linux CI validation. No crash was hidden, skipped or converted into a pass. A paired repeat of the patched #4 MT conformance immediately after the original-host control completed with tests 100, pass 95, fail 2, cancelled 0, skipped 3; it failed only the two latency assertions and did not reproduce the memory-access error. The original failed run remains in the table; this repeat does not clear the unexplained crash.

Existing successful runtime artifacts were downloaded from Build runs 38880290886 (#4) and 38881491825 (#5), checked against their SHA256SUMS and per-variant manifest hashes, then combined with the new local host. Their source commits are the GitHub test merges 4132760 and 6409ec0. Those commits were fetched and engine/, the Orca pin/submodule and toolchain inputs compared byte-for-byte to the new branches: no differences. This reuses the matching binary for unchanged C++; it is not a new clean source build, offline reproducibility result or release qualification. Engine fixture files run serially to limit RAM. The 16-round gate campaigns above use the original command without concurrency changes.

No conformance test, target, threshold, preset fixture, golden or measurement code was modified. The unchanged gate-body SHA-256 (LF-normalized read) is b4939526220d567ee12648ea9ff7842428e6e267decb191bb44532bc5ef8fa4f. Both patch applications are signed off and preserve painting, capability negotiation, protocol versions and C++ code. git merge-tree reports a clean composition of the two updated branches. Ordinary pushes only.

Decisions: retain all failed measurements; distinguish startup imports from warmed work; optimize only profiled repeated work; retain per-request cache invalidation; use matching existing WASM binaries because large builds are forbidden on this loaded laptop; do not change CI workflows/runners or dispatch builds; leave both drafts and merge/release holds intact. Self-hosted bigbox checks remain pending until capacity returns. Existing older Build results are historical evidence, not checks of these heads. Final CI status is recorded in the PR comments.

Release 0.5.0 still follows docs/RELEASE_050.md on #5, including clean combined runtime, idle-machine SPEC performance and supervisor acceptance. No internal product specification was marked built: these are unmerged engine changes and a load-sensitive development gate. Evidence belongs with the source PRs; the documentation-fold review found no existing internal settings-latency clause to update.
