#!/usr/bin/env bash
# =====================================================================================================
# setup-toolchain.sh: installs the build toolchain on a Linux x86-64 machine (the CI runners), into
# $ORCA_WASM_ROOT, and prints the folders to put on PATH. Idempotent: what is there already is kept.
#
#   ORCA_WASM_ROOT=~/OrcaWasm bash tools/ci/setup-toolchain.sh
#
#   $ORCA_WASM_ROOT/emsdk          Emscripten $EMSDK_VERSION (installed and activated)
#   $ORCA_WASM_ROOT/tools/cmake    CMake $CMAKE_VERSION (Kitware's Linux build)
#   $ORCA_WASM_ROOT/tools/bin      Ninja $NINJA_VERSION and ccache $CCACHE_VERSION
#
# The versions below are part of the toolchain cache key (.github/actions/toolchain), so changing one
# rebuilds the dependency prefixes. They match the Windows development setup (engine/scripts/README.md).
# Also needed, from the system: git, curl, unzip, python3, bsdtar (package libarchive-tools), xz.
# =====================================================================================================
set -euo pipefail

EMSDK_VERSION=6.0.10
CMAKE_VERSION=3.31.6
NINJA_VERSION=1.12.1
CCACHE_VERSION=4.10.2   # engine builds in build.yml only (EM_COMPILER_WRAPPER); releases build without it

ROOT=${ORCA_WASM_ROOT:?set ORCA_WASM_ROOT}
mkdir -p "$ROOT/tools/bin"

if [[ ! -f $ROOT/emsdk/.emscripten ]]; then
  echo "==== emsdk $EMSDK_VERSION -> $ROOT/emsdk"
  rm -rf "$ROOT/emsdk"
  git clone --quiet --depth 1 https://github.com/emscripten-core/emsdk.git "$ROOT/emsdk"
  (cd "$ROOT/emsdk" && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION")
  # The downloaded archives are not needed once installed (and would double the cache).
  rm -rf "$ROOT/emsdk/downloads" "$ROOT/emsdk/.git"
fi

if [[ ! -x $ROOT/tools/cmake/bin/cmake ]]; then
  echo "==== cmake $CMAKE_VERSION -> $ROOT/tools/cmake"
  rm -rf "$ROOT/tools/cmake" && mkdir -p "$ROOT/tools/cmake"
  curl -fsSL --retry 3 \
    "https://github.com/Kitware/CMake/releases/download/v$CMAKE_VERSION/cmake-$CMAKE_VERSION-linux-x86_64.tar.gz" |
    tar -xz -C "$ROOT/tools/cmake" --strip-components=1
fi

if [[ ! -x $ROOT/tools/bin/ninja ]]; then
  echo "==== ninja $NINJA_VERSION -> $ROOT/tools/bin"
  curl -fsSL --retry 3 -o "$ROOT/tools/ninja.zip" \
    "https://github.com/ninja-build/ninja/releases/download/v$NINJA_VERSION/ninja-linux.zip"
  unzip -o -q "$ROOT/tools/ninja.zip" -d "$ROOT/tools/bin" && rm "$ROOT/tools/ninja.zip"
fi

if [[ ! -x $ROOT/tools/bin/ccache ]]; then
  echo "==== ccache $CCACHE_VERSION -> $ROOT/tools/bin"
  curl -fsSL --retry 3 \
    "https://github.com/ccache/ccache/releases/download/v$CCACHE_VERSION/ccache-$CCACHE_VERSION-linux-x86_64.tar.xz" |
    tar -xJ -C "$ROOT/tools/bin" --strip-components=1 "ccache-$CCACHE_VERSION-linux-x86_64/ccache"
fi

"$ROOT/tools/cmake/bin/cmake" --version | head -1
"$ROOT/tools/bin/ccache" --version | head -1
"$ROOT/tools/bin/ninja" --version
echo "PATH+=$ROOT/tools/cmake/bin:$ROOT/tools/bin"
