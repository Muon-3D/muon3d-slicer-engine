# shellcheck shell=bash
# The OrcaSlicer source the engine is built from (sourced by scripts/get-orca.sh and scripts/build.sh).
#
# The pin is the orca/ submodule: its commit in this repository's HEAD (`git rev-parse HEAD:orca`), a
# commit of branch muon3d-wasm of the Muon3D fork, tagged muon3d-wasm/<date> so it stays reachable for
# as long as its source is owed (AGPL-3.0 section 6). That commit is compiled into the engine (version(),
# the worker's `ready` message) and written to dist/manifest.json as orcaCommit.
#
# muon3d-wasm = OrcaSlicer PR #13777 (feat-3D-Exclusion-Volumes) at ORCA_BASE_COMMIT, plus one commit
# with the Muon3D M1 profiles. Moving the pin is a deliberate step: the new commit is pushed and tagged
# on the fork first, then `git -C orca checkout <tag>`, ORCA_TAG below updated, both variants rebuilt
# and re-tested, and the submodule change committed.
#
# Needs REPO_DIR (this repository's root) set by the caller.
: "${REPO_DIR:?set REPO_DIR before sourcing pin.sh}"
ORCA_REPO=https://github.com/Muon-3D/OrcaSlicer.git   # also in .gitmodules
ORCA_BRANCH=muon3d-wasm
ORCA_TAG=muon3d-wasm/2026-09-24                      # tag on ORCA_REPO naming the pinned commit
# Upstream base of the branch, named in SOURCE.md and NOTICE: everything after it is Muon3D's.
ORCA_BASE_REPO=https://github.com/OrcaSlicer/OrcaSlicer.git
ORCA_BASE_REF=refs/pull/13777/head
ORCA_BASE_COMMIT=432debfc74a7e62e84b1af420804c47590ace43f   # "Restore shared printer option variable"
# The committed pin; a pin that is staged but not committed yet (while moving it) counts too. A release's
# source bundle is not a git checkout: it names its commits in SOURCE_COMMITS (tools/release/source-bundles.sh).
if [[ ! -e $REPO_DIR/.git && -f $REPO_DIR/SOURCE_COMMITS ]]; then
  ORCA_PINNED_COMMIT=$(sed -n 's/^orca=//p' "$REPO_DIR/SOURCE_COMMITS")
  [[ -n $ORCA_PINNED_COMMIT ]] || { echo "pin.sh: no orca= line in $REPO_DIR/SOURCE_COMMITS" >&2; exit 1; }
else
  ORCA_PINNED_COMMIT=$(git -C "$REPO_DIR" rev-parse -q --verify HEAD:orca 2>/dev/null ||
                       git -C "$REPO_DIR" rev-parse -q --verify :orca 2>/dev/null) || {
    echo "pin.sh: no orca submodule in $REPO_DIR" >&2
    exit 1
  }
fi
