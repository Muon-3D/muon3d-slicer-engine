// Which slot of a "variant" option belongs to which nozzle. Printers with several nozzle variants
// (the Bambu Lab H2D: two direct drive extruders, each with a Standard and a High Flow nozzle) store
// their speeds, retraction and filament values once per (extruder, nozzle variant): slot i of the
// printer's retraction_length belongs to extruder printer_extruder_id[i] with the nozzle
// printer_extruder_variant[i]. Orca's tabs find the slot they edit with
// DynamicPrintConfig::get_index_for_extruder (libslic3r/PrintConfig.cpp); this is a port of it.
//
// Pure (no imports but types) so it runs under plain Node in tests.
import type { SettingScope } from '../../../tools/settings-catalogue/types.ts';

/**
 * extruder_variant_keys (Tab.cpp): per preset, the option naming each slot's extruder (none for a
 * filament, which Orca no longer ties to an extruder) and the option naming its variant.
 */
export const VARIANT_KEYS: Readonly<Record<SettingScope, { id: string | null; variant: string }>> = {
  process: { id: 'print_extruder_id', variant: 'print_extruder_variant' },
  filament: { id: null, variant: 'filament_extruder_variant' },
  machine: { id: 'printer_extruder_id', variant: 'printer_extruder_variant' },
};

/**
 * get_extruder_variant_string: "Direct Drive Standard". A Hybrid nozzle reads as Standard, as in
 * get_index_for_extruder (presets have no Hybrid variant).
 */
export function extruderVariantString(extruderType: string, nozzleVolumeType: string): string {
  return `${extruderType} ${nozzleVolumeType === 'Hybrid' ? 'Standard' : nozzleVolumeType}`;
}

export interface VariantTable {
  /** The variant option's slots ("Direct Drive Standard", …). */
  variants: readonly string[];
  /** The id option's slots (1-based extruder numbers), or null when the preset has none. */
  ids: readonly string[] | null;
  /** The printer's extruder_variant_list, which numbers the variants when the id list is short. */
  extruderVariantList?: readonly string[] | null;
}

/**
 * DynamicPrintConfig::get_index_for_extruder: the slot of extruder `extruder` (1-based) with the
 * nozzle `variant`, times `stride` (2 for the machine limits' normal/silent pairs); -1 when the
 * preset has none.
 */
export function indexForExtruder(table: VariantTable, extruder: number, variant: string, stride = 1): number {
  const { variants, ids } = table;
  const complete = ids !== null && ids.length >= variants.length;
  // generated_extruder_id: numbers the variants through extruder_variant_list.
  const generatedId = (target: number): number => {
    const list = table.extruderVariantList;
    if (!list) return 0;
    let n = 0;
    for (let e = 0; e < list.length; e++) {
      for (const v of list[e].split(',').map((s) => s.trim())) {
        if (v === '') continue;
        if (n === target) return e + 1;
        n++;
      }
    }
    return 0;
  };
  for (let i = 0; i < variants.length; i++) {
    if (variants[i].trim() !== variant) continue;
    if (ids === null) return i * stride;
    const id = complete ? Number.parseInt(ids[i], 10) : generatedId(i);
    if (id === extruder) return i * stride;
  }
  return -1;
}
