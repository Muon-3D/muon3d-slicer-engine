// Reads the engine's configDefinitions() export (engine/bridge/config_def.cpp): OrcaSlicer's option table
// and the key sets libslic3r defines (ConfigDefinitions, format 1, in packages/protocol), taken from the
// very build that slices. The result of the op config.definitions, and the settings catalogue generator's
// input.
import { CONFIG_DEFINITIONS_FORMAT, type ConfigDefinitions } from '../../packages/protocol/src/definitions.ts';
import type { OrcaEngineModule } from './bridge.ts';

export { CONFIG_DEFINITIONS_FORMAT };
export type { ConfigDefinitions, OrcaOptionDefinition } from '../../packages/protocol/src/definitions.ts';

/**
 * Calls the engine's configDefinitions() and parses it. Throws when the engine predates the export
 * ("rebuild the engine"), when it reports an error, or when the format is not this module's.
 */
export function readConfigDefinitions(engine: Pick<OrcaEngineModule, 'configDefinitions'>): ConfigDefinitions {
  if (typeof engine.configDefinitions !== 'function') {
    throw new Error('This engine build has no configDefinitions(): rebuild the engine (engine/scripts/build.sh).');
  }
  const parsed = JSON.parse(engine.configDefinitions()) as Partial<ConfigDefinitions> & { error?: string };
  if (parsed.error) throw new Error(parsed.error);
  if (parsed.format !== CONFIG_DEFINITIONS_FORMAT || typeof parsed.options !== 'object' || parsed.options === null) {
    throw new Error(`The engine's option definitions have format ${String(parsed.format)}; this code reads format ${CONFIG_DEFINITIONS_FORMAT}.`);
  }
  return parsed as ConfigDefinitions;
}
