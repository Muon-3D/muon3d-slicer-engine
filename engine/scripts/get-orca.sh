#!/usr/bin/env bash
# =====================================================================================================
# get-orca.sh: check out the exact OrcaSlicer source the engine is built from (scripts/orca/pin.sh).
#
#   bash engine/scripts/get-orca.sh           # into $ORCA_SRC, unless a checkout is already there
#   bash engine/scripts/get-orca.sh --check   # only check the checkout in $ORCA_SRC
#
# Fetches the pinned base commit alone (depth 1), applies the patches in scripts/orca/ as
# the same commits they were made from (author, committer and dates from each patch), names the result
# branch muon3d-wasm, and checks that HEAD is ORCA_PINNED_COMMIT, the commit the engine reports. Line
# endings are checked out as git stores them (core.autocrlf false), the same on every OS.
#
# An existing checkout is never changed, only checked: HEAD must be ORCA_PINNED_COMMIT and the sources the
# engine uses (src, deps_src, resources, version.inc) must have no uncommitted changes.
#
# Environment:
#   ORCA_WASM_ROOT  default ~/OrcaWasm
#   ORCA_SRC        default $ORCA_WASM_ROOT/orca
#   ORCA_GIT_URL    where to fetch the base commit from (default: ORCA_BASE_REPO in pin.sh)
# =====================================================================================================
set -euo pipefail

CHECK_ONLY=0
[[ ${1:-} == --check ]] && CHECK_ONLY=1

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=toolchain.sh
source "$SCRIPT_DIR/toolchain.sh"
# shellcheck source=orca/pin.sh
source "$SCRIPT_DIR/orca/pin.sh"
ORCA_WASM_ROOT=$(mixed_path "${ORCA_WASM_ROOT:-$ORCAWASM_DEFAULT_ROOT}")
ORCA_SRC=$(mixed_path "${ORCA_SRC:-$ORCA_WASM_ROOT/orca}")
ORCA_GIT_URL=${ORCA_GIT_URL:-$ORCA_BASE_REPO}

die() { echo "get-orca: $*" >&2; exit 1; }

# ---- An existing checkout: check it -----------------------------------------------------------------------
if [[ -e $ORCA_SRC ]]; then
  head=$(git -C "$ORCA_SRC" rev-parse HEAD 2>/dev/null) || die "$ORCA_SRC exists but is not a git checkout."
  [[ $head == "$ORCA_PINNED_COMMIT" ]] ||
    die "$ORCA_SRC is at $head, but the engine is built from $ORCA_PINNED_COMMIT (branch $ORCA_BRANCH). Check that" \
        "commit out there, or move the folder aside and run this script again."
  changes=$(git -C "$ORCA_SRC" status --porcelain --untracked-files=no -- src deps_src resources version.inc)
  [[ -z $changes ]] || die "$ORCA_SRC is at $ORCA_PINNED_COMMIT but has uncommitted changes:"$'\n'"$changes"
  echo "OK: $ORCA_SRC is at $ORCA_PINNED_COMMIT ($ORCA_BRANCH), no changes in the sources the engine uses."
  exit 0
fi
(( CHECK_ONLY == 0 )) || die "no checkout in $ORCA_SRC (run without --check to get one)."

# ---- A new checkout -------------------------------------------------------------------------------------------
WORK=$ORCA_SRC.partial
rm -rf "$WORK"
mkdir -p "$(dirname "$ORCA_SRC")"
git init -q "$WORK"
git -C "$WORK" config core.autocrlf false    # the files as git stores them, on every OS
git -C "$WORK" config core.longpaths true     # Windows: Orca's resources nest deep
git -C "$WORK" remote add origin "$ORCA_GIT_URL"

echo "==== fetching $ORCA_BASE_COMMIT from $ORCA_GIT_URL"
if ! git -C "$WORK" fetch --depth 1 origin "$ORCA_BASE_COMMIT"; then
  # A server that does not hand out commits by id: fetch the PR's history and look for the pinned commit.
  echo "fetching by commit id failed; trying $ORCA_BASE_REF" >&2
  git -C "$WORK" fetch --depth 50 origin "$ORCA_BASE_REF"
  git -C "$WORK" cat-file -e "$ORCA_BASE_COMMIT^{commit}" 2>/dev/null ||
    die "$ORCA_BASE_COMMIT is not in the last 50 commits of $ORCA_BASE_REF any more; fetch it from a mirror (ORCA_GIT_URL)."
fi
git -C "$WORK" -c advice.detachedHead=false checkout -q "$ORCA_BASE_COMMIT"

for patch in "${ORCA_PATCHES[@]}"; do
  file=$SCRIPT_DIR/orca/$patch
  [[ -f $file ]] || die "missing $file"
  # The committer of each commit was its author, at the author's date: recreate exactly that.
  author=$(sed -n '2,/^$/ s/^From: //p' "$file" | head -1)
  [[ $author == *" <"*">" ]] || die "no author in $patch"
  email=${author##*<}
  echo "==== applying $patch"
  GIT_COMMITTER_NAME=${author% <*} GIT_COMMITTER_EMAIL=${email%>} \
    git -C "$WORK" am -q --whitespace=nowarn --committer-date-is-author-date "$(mixed_path "$file")"
done
git -C "$WORK" checkout -q -b "$ORCA_BRANCH"

head=$(git -C "$WORK" rev-parse HEAD)
[[ $head == "$ORCA_PINNED_COMMIT" ]] ||
  die "the patches gave $head instead of $ORCA_PINNED_COMMIT (left in $WORK). A patch does not match its commit," \
      "or git was set to sign commits (commit.gpgsign)."
mv "$WORK" "$ORCA_SRC"
echo "OK: $ORCA_SRC at $ORCA_PINNED_COMMIT ($ORCA_BRANCH)"
