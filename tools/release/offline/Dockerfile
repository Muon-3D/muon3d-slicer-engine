# The container a release's source assets are rebuilt in (tools/release/rebuild-offline.sh): Emscripten's own
# emsdk image, plus the generally available build tools the scripts use. Nothing of the engine or its
# dependencies is in it; the rebuild runs with the network off and an empty Emscripten cache.
#
#   docker build -t engine-offline tools/release/offline
FROM emscripten/emsdk:6.0.10

ARG CMAKE_VERSION=3.31.6
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git libarchive-tools ninja-build xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/cmake \
 && curl -fsSL "https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-linux-x86_64.tar.gz" \
    | tar -xz -C /opt/cmake --strip-components=1
ENV PATH=/opt/cmake/bin:$PATH
