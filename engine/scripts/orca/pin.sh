# shellcheck shell=bash
# The OrcaSlicer source the engine is built from (sourced by scripts/get-orca.sh and scripts/build.sh).
#
# Branch muon3d-wasm = OrcaSlicer PR #13777 (feat-3D-Exclusion-Volumes) at ORCA_BASE_COMMIT, plus the
# commits in ORCA_PATCHES (made with `git format-patch --binary --full-index --no-signature`), which
# get-orca.sh applies as the very same commits. ORCA_PINNED_COMMIT is the result: compiled into the
# engine (version(), the worker's `ready` message) and written to web/public/engine/manifest.json as
# orcaCommit, so it must name a commit anyone can reproduce (AGPL source offer).
#
# Moving to a newer PR head (it has moved on: 7481fdcdae on 2026-09-24 touches Brim.cpp, PrintConfig and
# the exclusion-volume geometry) is a deliberate step: rebase the patches, update these values, rebuild
# and re-test both variants.
ORCA_BASE_REPO=https://github.com/OrcaSlicer/OrcaSlicer.git
ORCA_BASE_REF=refs/pull/13777/head           # where ORCA_BASE_COMMIT came from; used if the SHA cannot be fetched
ORCA_BASE_COMMIT=432debfc74a7e62e84b1af420804c47590ace43f   # "Restore shared printer option variable"
ORCA_PATCHES=(0001-Muon3D-M1-profiles.patch)  # in engine/scripts/orca/, applied in order
ORCA_PINNED_COMMIT=2d1163eb6f5228de605150e3b4800081947070eb # HEAD after the patches
ORCA_BRANCH=muon3d-wasm
