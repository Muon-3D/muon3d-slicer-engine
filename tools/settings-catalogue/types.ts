// Types of the OrcaSlicer settings catalogue (data/settings-catalogue.json, format 2), which
// `npm run gen:settings` (tools/settings-catalogue/generate.ts) builds from the engine's option
// definitions and the layout of Orca's settings tabs (src/slic3r/GUI/Tab.cpp). They are the result type
// of the op settings.catalogue, so they live in the protocol package (packages/protocol/src/catalogue.ts).
export type * from '../../packages/protocol/src/catalogue.ts';
