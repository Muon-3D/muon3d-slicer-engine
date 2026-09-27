#!/usr/bin/env bash
# =====================================================================================================
# get-orca.sh: check out the exact OrcaSlicer source the engine is built from: the orca/ submodule at
# the commit this repository pins (scripts/orca/pin.sh), or check an existing checkout.
#
#   bash engine/scripts/get-orca.sh             # git submodule update --init orca (shallow)
#   bash engine/scripts/get-orca.sh --check     # only check the checkout in $ORCA_SRC
#   ORCA_REFERENCE=<path to an Orca clone> bash engine/scripts/get-orca.sh
#                                               # borrow objects from a local clone (no 1.3 GB fetch)
#
# Line endings are checked out as git stores them (core.autocrlf false in the submodule), the same on
# every OS. A checkout that is already there is never changed, only checked: HEAD must be the pinned
# commit and the sources the engine uses (src, deps_src, resources, version.inc) must have no
# uncommitted changes.
#
# Environment:
#   ORCA_SRC        the checkout to use or check (default: the orca/ submodule of this repository)
#   ORCA_REFERENCE  an existing Orca clone to borrow objects from (git submodule update --reference)
# =====================================================================================================
set -euo pipefail

CHECK_ONLY=0
[[ ${1:-} == --check ]] && CHECK_ONLY=1

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=toolchain.sh
source "$SCRIPT_DIR/toolchain.sh"
REPO_DIR=$(dir_path "$SCRIPT_DIR/../..")
# shellcheck source=orca/pin.sh
source "$SCRIPT_DIR/orca/pin.sh"
SUBMODULE=$REPO_DIR/orca
ORCA_SRC=$(mixed_path "${ORCA_SRC:-$SUBMODULE}")

die() { echo "get-orca: $*" >&2; exit 1; }

check() {
  local head changes
  head=$(git -C "$ORCA_SRC" rev-parse HEAD 2>/dev/null) || die "$ORCA_SRC is not a git checkout."
  [[ $head == "$ORCA_PINNED_COMMIT" ]] ||
    die "$ORCA_SRC is at $head, but the engine is built from $ORCA_PINNED_COMMIT ($ORCA_TAG). Run" \
        "git submodule update orca (or check that commit out there)."
  changes=$(git -C "$ORCA_SRC" status --porcelain --untracked-files=no -- src deps_src resources version.inc)
  [[ -z $changes ]] || die "$ORCA_SRC is at $ORCA_PINNED_COMMIT but has uncommitted changes:"$'\n'"$changes"
  echo "OK: $ORCA_SRC is at $ORCA_PINNED_COMMIT ($ORCA_TAG), no changes in the sources the engine uses."
}

if [[ -e $ORCA_SRC/.git ]]; then
  check
  exit 0
fi
(( CHECK_ONLY == 0 )) || die "no checkout in $ORCA_SRC (run without --check to get one)."
[[ $ORCA_SRC == "$(mixed_path "$SUBMODULE")" ]] ||
  die "no checkout in $ORCA_SRC: this script only fetches the orca/ submodule; unset ORCA_SRC to use it."

REFERENCE=()
[[ -n ${ORCA_REFERENCE:-} ]] && REFERENCE=(--reference "$(mixed_path "$ORCA_REFERENCE")")
echo "==== fetching $ORCA_REPO at $ORCA_PINNED_COMMIT into orca/"
# core.autocrlf false: the files as git stores them, on every OS. core.longpaths: Orca's resources nest deep.
git -C "$REPO_DIR" -c core.autocrlf=false -c core.longpaths=true \
  submodule update --init --depth 1 "${REFERENCE[@]}" orca
git -C "$SUBMODULE" config core.autocrlf false
git -C "$SUBMODULE" config core.longpaths true
check
