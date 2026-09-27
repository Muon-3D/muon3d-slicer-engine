# Contributing

Thank you for helping. A few rules keep the engine's licensing clear.

## Licences

| Path | Licence |
|---|---|
| everything, unless listed below | AGPL-3.0-only (`LICENSE`) |
| `packages/protocol/` | Apache-2.0 (`packages/protocol/LICENSE`) |
| `orca/` | a submodule: OrcaSlicer's own licence (AGPL-3.0) and file headers |

`REUSE.toml` records the same per path. Keep every existing copyright header, and keep upstream headers on any
code copied from OrcaSlicer or its dependencies. Contributions are accepted under the licence of the folder they go
into.

## Sign your commits (DCO)

Every commit must carry a `Signed-off-by:` line, which certifies the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): that you wrote the change, or otherwise
have the right to submit it under the licence of the folder it goes into.

```bash
git commit -s -m "Bridge: ..."
```

## Before you open a pull request

```bash
npm ci
npm run check          # no import outside the repository, and the type check
npm test               # unit tests (the engine tests skip without a built engine)
npm run test:engine    # with both variants built (engine/scripts/README.md)
```

A change to the bridge, the CMake files or the pin needs both variants rebuilt and `npm run test:engine` green on
each. A change to `packages/protocol` must be additive while the protocol major stays the same.

## OrcaSlicer itself

The engine builds OrcaSlicer out of tree and never edits `orca/`. A fix that cannot be an out-of-tree patch
(`engine/cmake/OrcaSourcePatches.cmake`, listed in `engine/PATCHES.md`) belongs upstream in
[OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer) first; open an issue here and we will carry it on the
`muon3d-wasm` branch of <https://github.com/Muon-3D/OrcaSlicer> until it lands.
