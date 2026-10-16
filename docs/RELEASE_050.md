# Engine 0.5.0 / protocol 2.3.0 release handoff

Jack approved this takeover on 16 October 2026: "Yes, do it and tell Harry".
Codex 43 prepared the source and this runbook. No PR merge, tag, workflow dispatch,
release creation, publication, deployment or printer action was performed.

## On hold: main has released 0.5.0 and 0.6.0 (16 October 2026)

Do not run the sequence below as written. Main published
[v0.5.0](https://github.com/Muon-3D/muon3d-slicer-engine/releases/tag/v0.5.0) at `ed35130` (12:15 UTC)
and has since moved to 0.6.0 / protocol 2.4 (`351518f`: mt64, and `tbb::scalable_allocator` on malloc),
all without #4 or #5. Both PRs conflict with main (#4: protocol, host, conformance and the engine test
runner; #5 also `engine/bridge/slice_job.cpp`). Rebase them onto main and give them unused engine and
protocol versions before any tag. Never replace an existing tag or its assets.

The mt crash hold is resolved: it was V8's lag in showing a grown shared heap to other threads' atomic
accesses, older than both PRs. The host now grows the mt heap between jobs
(`docs/performance/mt-crash-2026-10-16`). Main's host does not have that change yet.

## Supervisor sequence after review

1. Merge engine #4, then #5 using merge commits. #5 includes #4 and current main so
   both capabilities, painting and the protocol-manifest minor fix survive. Do not squash
   away that ancestry. #5 sets package.json and its lock to 0.5.0, the protocol package
   to 2.3.0 and PROTOCOL to 2.3. Do not publish an intermediate #4-only runtime.
2. Restore a healthy self-hosted Linux runner selected by the repo variable LINUX_RUNS_ON.
   This run did not change that variable or the runner. Required software: Node 24, npm,
   git, gh, Docker daemon/permission, g++, jq, GNU tar/gzip/xz, sha256sum, Python 3,
   network access for locked dependencies and source fetches, and the toolchain prerequisites.
   The workflow installs libarchive-tools with sudo; the composite action prepares Emscripten
   6.0.10 and dependency prefixes. Allow disk and time for two clean builds plus two offline rebuilds.
3. In a clean supervisor checkout on the reviewed main commit (bash):

   ```bash
   git fetch origin main
   git checkout --detach origin/main
   test "$(node -p 'require("./package.json").version')" = 0.5.0
   test "$(node -p 'require("./packages/protocol/package.json").version')" = 2.3.0
   git tag -a v0.5.0 -m "Muon3D Slicer Engine 0.5.0"
   git push origin v0.5.0
   gh workflow run release.yml --repo Muon-3D/muon3d-slicer-engine --ref main -f tag=v0.5.0
   gh run list --repo Muon-3D/muon3d-slicer-engine --workflow release.yml --limit 3
   ```

   Tag creation alone no longer launches or publishes a release. The manual workflow checks
   tag/version/HEAD agreement and main ancestry, builds and tests st then mt in separate fresh
   directories, checks notices and profiles, creates a draft, verifies its downloads, and rebuilds
   wasm/glue and the host from the source assets. The engine rebuild containers have no network
   and start with empty Emscripten caches. Provenance attestation runs last. It never publishes.
   A failed run retains any draft for inspection; it refuses to replace an existing release.
   Do not push a second tag or delete/overwrite a draft blindly to conceal a failed gate.
4. Require workflow success, review the logs and hashes, and verify from the self-hosted checkout:

   ```bash
   bash tools/release/verify-release.sh v0.5.0 supervisor-verify
   gh attestation verify supervisor-verify/assets/muon3d-slicer-engine-0.5.0.tgz --repo Muon-3D/muon3d-slicer-engine
   gh release view v0.5.0 --repo Muon-3D/muon3d-slicer-engine --json isDraft,assets
   ```

   Confirm hello advertises slice.field, slice.printChecks, slice.gravity and paint.v1,
   protocol 2.3, and the assembled manifest names exactly the reviewed tag commit. The combined
   test suite includes a real slice returning both outputs and matching gravity, as well as
   the existing print-check on/off G-code parity and painting goldens. A clean combined binary,
   notices/profile regeneration checks, and offline reproducibility remain mandatory.
5. Only after the supervisor accepts that evidence, publish deliberately:

   ```bash
   gh release edit v0.5.0 --repo Muon-3D/muon3d-slicer-engine --draft=false --latest
   ```

6. Finalize the app's existing draft pin PR in its own clean checkout:

   ```bash
   node scripts/fetch-engine.mjs --pin 0.5.0
   node scripts/fetch-profiles.mjs --pin 0.5.0
   node -e "const fs=require('fs');const p='package-lock.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));delete j.packages['node_modules/@muon3d/slicer-engine-protocol'];fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');"
   npm install --package-lock-only --ignore-scripts --no-audit --no-fund
   npm ci
   npm run typecheck
   npm test -- --test-concurrency=1
   node scripts/check-boundary.mjs source pins fingerprints
   npm run build
   node scripts/check-boundary.mjs built references notices
   git diff --check
   git add engine.lock.json profiles.lock.json package.json package-lock.json
   git commit -s -m "chore(engine): verify published 0.5.0 release pins"
   git push
   ```

   Check that every TODO-HASH is gone before merging the app PR. Run applicable localhost host,
   smoke and strength gates from the final composed app stack, then one actual engine-produced
   field -> simulator result and a fresh candidate -> solve -> apply -> ordinary reslice, plus
   print-check display/fix acceptance. No fixture substitutes for this path. VPS header/bundle
   selection and simulator stack release holds remain separate; this does not deploy the app.

## Expected assets and hash authority

- muon3d-slicer-engine-0.5.0.tgz (the exact runtime the app downloads).
- muon3d-slicer-profiles-0.5.0.tgz (must pair with that engine, including gravity).
- muon3d-slicer-engine-protocol-2.3.0.tgz (Apache-2.0 protocol only).
- muon3d-slicer-engine-0.5.0-source.tar.gz.
- orcaslicer-2d1163eb6f-source.tar.xz.
- third-party-sources-<content-key>.tar.
- SHA256SUMS covering exactly those six assets. Read the actual source asset basename from
  sources.json/manifest.source; source-bundles.sh uses its pinned naming convention.

The release byte hashes cannot be known until the final merged commit is built. All future
app checksums/integrity/index fingerprints are deliberately TODO-HASH, never old release hashes.
The authority is the verified draft's SHA256SUMS, the per-file runtime manifest, offline matching
rebuilds and GitHub provenance. fetch-engine --pin computes npm SHA-512 integrity from the
protocol tarball after checking its SHA-256; fetch-profiles --pin records the real hashed index.
A local protocol tarball hash is diagnostic only, not a substitute for the published asset.

The runtime includes LICENSE, NOTICE, THIRD-PARTY-NOTICES.md and SOURCE.md with source URLs and
hashes. There is no SBOM asset generated by the existing release tools; do not invent one.
GitHub Release assets are used, not Actions artifacts. The old Build workflow still uses hosted
runners and upload-artifact: its runtime/edge path is not usable while org artifact storage is full.
This manual release route does not depend on Build artifacts or edge. Do not dispatch the old
artifact path as a workaround, and do not treat its missing runtime check as a green release gate.

## Review and performance limits

The field export allocated a dense bounding grid without a limit and could lose a successful slice.
It now preflights an allocation estimate (256 MiB, 255 objects, 65535 layers) and reports an optional
slice_field warning while preserving G-code. The estimate is field allocation only, not process peak
memory. Explicit gravity wins over notes; recognized legacy notes drive both paths; unspecified
field gravity stays null. Slenderness now uses linear running moments with the same discrete formula.
M1 threshold constants remain provisional; no calibration or physical safety claim is made.

Harry's available SPEC section 3.5 is docs/design/2026-10-14-painting/SPEC.md in the app: first frame
150 ms, adjacency 300 ms, pointer p95 4 ms, frame p95 16.7 ms (tablet 33 ms), release 20 ms,
undo 50 ms, fill 8 ms, editor 40 MB and request conversion 50 ms. These are development-PC
Chromium/painting budgets, not per-field-export or per-print-check budgets. The engine's
WASM_ENGINE_SPEC section 8 separately requires Benchy ST <=20 s / MT <=7 s, peak <=1 GB,
placement <=50 ms and <=8 MB Brotli per variant. Additional work stays in the engine worker,
but CPU contention, WASM heap plus field allocations, message transfer and full slice wall time
still need idle-machine measurements at the final combined commit. Do not relabel the prior
PR fixture timings or this loaded laptop's results as evidence that those budgets pass.
