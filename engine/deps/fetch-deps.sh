#!/usr/bin/env bash
# Fetch, hash-check and extract the third-party sources the wasm engine's dependencies are built from.
# Windows-native (Git Bash); idempotent, so re-running only does what is missing.
#
#   bash engine/deps/fetch-deps.sh                    # everything
#   bash engine/deps/fetch-deps.sh boost libjpeg-turbo # selected packages
#
# Layout (ORCA_WASM_ROOT defaults to ~/OrcaWasm; big files stay out of the repo and any synced folder):
#   $ORCA_WASM_ROOT/deps-src/_archives/<file>        downloaded archive
#   $ORCA_WASM_ROOT/deps-src/<name>-<version>/       extracted source, top-level folder stripped
#
# The expected hashes live in SHA256SUMS next to this script (sha256sum format) and are the single
# source of truth: an archive whose hash is not listed there, or does not match, stops the script.
# Pass RECORD_NEW=1 once to append the hash of a newly added archive (and review it before committing).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ORCA_WASM_ROOT=$(cygpath -m "${ORCA_WASM_ROOT:-$HOME/OrcaWasm}")   # accepts /x/... or X:/... forms
SRC=$ORCA_WASM_ROOT/deps-src
ARC=$SRC/_archives
SUMS=$HERE/SHA256SUMS
RECORD_NEW=${RECORD_NEW:-0}
# Windows' own bsdtar (libarchive): handles .zip/.tar.gz/.tar.bz2 and --strip-components. Git's GNU tar
# cannot read .zip.
BSDTAR=${BSDTAR:-/c/Windows/System32/tar.exe}

# name | version | url | where the pin comes from
DEPS=(
  "boost|1.84.0|https://github.com/boostorg/boost/releases/download/boost-1.84.0/boost-1.84.0.tar.gz|orca deps/Boost/Boost.cmake"
  "oneTBB|2021.12.0|https://github.com/uxlfoundation/oneTBB/archive/refs/tags/v2021.12.0.zip|bump from orca deps/TBB/TBB.cmake (2021.5.0 has no wasm support; hash recorded here)"
  "CGAL|5.6.3|https://github.com/CGAL/cgal/releases/download/v5.6.3/CGAL-5.6.3.zip|orca deps/CGAL/CGAL.cmake"
  "eigen|5.0.1|https://gitlab.com/libeigen/eigen/-/archive/5.0.1/eigen-5.0.1.zip|orca deps/Eigen/Eigen.cmake"
  "cereal|1.3.0|https://github.com/USCiLab/cereal/archive/refs/tags/v1.3.0.zip|orca deps/Cereal/Cereal.cmake"
  "nlopt|2.5.0|https://github.com/stevengj/nlopt/archive/v2.5.0.tar.gz|orca deps/NLopt/NLopt.cmake"
  "libnoise|1.0|https://github.com/SoftFever/Orca-deps-libnoise/archive/refs/tags/1.0.zip|orca deps/libnoise/libnoise.cmake"
  "qhull|8.0.2|https://github.com/qhull/qhull/archive/v8.0.2.zip|orca deps/Qhull/Qhull.cmake"
  "libjpeg-turbo|3.0.1|https://github.com/libjpeg-turbo/libjpeg-turbo/archive/refs/tags/3.0.1.zip|orca deps/JPEG/JPEG.cmake"
  # Optional (WITH_GMP=1 in build-deps.sh only); same file as Orca's SoftFever mirror.
  "gmp|6.2.1|https://ftp.gnu.org/gnu/gmp/gmp-6.2.1.tar.bz2|orca deps/GMP/GMP.cmake"
  "mpfr|4.2.2|https://ftp.gnu.org/gnu/mpfr/mpfr-4.2.2.tar.bz2|orca deps/MPFR/MPFR.cmake"
)

mkdir -p "$ARC"
want=("$@")

for entry in "${DEPS[@]}"; do
  IFS='|' read -r name ver url pin <<<"$entry"
  if [[ ${#want[@]} -gt 0 && " ${want[*]} " != *" $name "* ]]; then continue; fi

  base=$(basename "$url")
  # GitHub tag archives are called v1.3.0.zip / 1.0.zip: prefix the package name to keep them unique.
  case "$base" in v[0-9]*|[0-9]*) base="$name-$base" ;; esac
  file=$ARC/$base
  dest=$SRC/$name-$ver

  if [[ ! -s "$file" ]]; then
    echo "[fetch] $name $ver <- $url"
    curl -fsSL --retry 3 --retry-delay 5 -o "$file.part" "$url"
    mv "$file.part" "$file"
  fi

  got=$(sha256sum "$file" | cut -d' ' -f1)
  expect=$(awk -v f="$base" '$2 == f { print $1 }' "$SUMS")
  if [[ -z "$expect" ]]; then
    if [[ $RECORD_NEW == 1 ]]; then
      printf '%s  %s\n' "$got" "$base" >> "$SUMS"
      echo "[new]   $name $ver sha256 $got recorded in SHA256SUMS ($pin)"
    else
      echo "[FAIL]  $base is not listed in $SUMS (got $got); re-run with RECORD_NEW=1 to add it" >&2
      exit 1
    fi
  elif [[ "${got,,}" != "${expect,,}" ]]; then
    echo "[FAIL]  $name: sha256 $got != expected $expect" >&2
    exit 1
  else
    echo "[ok]    $name $ver ($pin)"
  fi

  # .extracted records what the folder was extracted from; a hash change forces a fresh extract.
  if [[ ! -f "$dest/.extracted" ]] || ! grep -q "sha256=$got" "$dest/.extracted"; then
    rm -rf "$dest"; mkdir -p "$dest"
    # Windows bsdtar cannot create symlinks; the only one in these archives is a doc image in nlopt.
    excl=()
    [[ $name == nlopt ]] && excl=(--exclude '*/doc/nlopt-mkdocs-theme/img/favicon.png')
    "$BSDTAR" -xf "$(cygpath -w "$file")" -C "$(cygpath -w "$dest")" --strip-components=1 "${excl[@]}"
    echo "$url sha256=$got" > "$dest/.extracted"
    echo "[x]     extracted -> $dest"
  fi
done
echo "fetch-deps: done ($SRC)"
