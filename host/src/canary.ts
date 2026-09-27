// A string unique to the engine host. The host reports it in its `ready` message, and the build writes it
// into dist/manifest.json. A client checks that its own bundle does not contain it (nor the host file's
// hash): the client must start the host by URL and never bundle it.
export const HOST_CANARY = 'muon3d-slicer-engine-host/844fdc97-4424-430e-9280-f7b49fa01568';
