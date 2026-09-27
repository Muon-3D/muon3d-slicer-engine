// SPDX-License-Identifier: Apache-2.0
// @muon3d/slicer-engine-protocol: the types a client needs to drive the Muon3D Slicer Engine's worker
// host. Type-only; nothing here runs, so importing it bundles no engine code.
export type * from './v1.ts';

/** The protocol major version these types describe. */
export type ProtocolVersion = 1;
