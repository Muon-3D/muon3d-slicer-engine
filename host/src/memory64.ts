// Kept apart from bridge.ts so the host core can ask at startup without evaluating the engine runtime graph
// (core.ts loads engineRuntime.ts on the first engine op).

/**
 * Whether this engine can run 'mt64': a module with a shared 64-bit memory validates (WebAssembly Memory64 with
 * threads: Chrome 133, Firefox 134, Node 24; not Safari). The module is the header, then a memory section with one
 * memory whose limits flags are 0x07 (has a maximum, shared, 64-bit), initial 1 page, maximum 1 page.
 */
export function memory64Supported(): boolean {
  try {
    return WebAssembly.validate(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x04, 0x01, 0x07, 0x01, 0x01]));
  } catch {
    return false;
  }
}
