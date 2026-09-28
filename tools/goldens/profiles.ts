// Reads OrcaSlicer's vendor profiles (orca/resources/profiles) and flattens presets the way the
// Muon3D Slicer app and Orca's CLI take them: the whole `inherits` chain merged (parent first, the
// child's keys win), `inherits` removed, stamped as a complete system preset (name, from: "system",
// type, instantiation: "true"). A parent is looked up in the preset's own vendor first, then in
// OrcaFilamentLibrary, then in every other vendor (as Orca's PresetBundle does for filaments).
//
// Used only by the golden recorders (tools/goldens/record-*.ts); the recorded presets are committed,
// so the tests do not need the Orca checkout.
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../../packages/protocol/src/data.ts';

export type PresetType = 'machine' | 'process' | 'filament';

export const FILAMENT_LIBRARY = 'OrcaFilamentLibrary';

const LIST_KEYS: Record<PresetType | 'machine_model', string> = {
  machine_model: 'machine_model_list',
  machine: 'machine_list',
  process: 'process_list',
  filament: 'filament_list',
};

export interface Vendor {
  name: string;
  dir: string;
  lists: Record<PresetType, Map<string, string>>;
}

export class ProfileTree {
  readonly root: string;
  readonly vendors = new Map<string, Vendor>();
  private readonly raw = new Map<string, Config>();

  constructor(root: string) {
    this.root = root;
    for (const file of fs.readdirSync(root).filter((n) => n.endsWith('.json')).sort()) {
      const name = file.slice(0, -'.json'.length);
      const index = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) as Record<string, unknown>;
      const dir = path.join(root, name);
      const lists = { machine: new Map(), process: new Map(), filament: new Map() } as Vendor['lists'];
      for (const type of ['machine', 'process', 'filament'] as const) {
        for (const entry of (index[LIST_KEYS[type]] as Array<{ name: string; sub_path: string }> | undefined) ?? []) {
          lists[type].set(entry.name, path.join(dir, entry.sub_path));
        }
      }
      this.vendors.set(name, { name, dir, lists });
    }
  }

  private read(file: string): Config {
    let config = this.raw.get(file);
    if (!config) {
      config = JSON.parse(fs.readFileSync(file, 'utf8')) as Config;
      this.raw.set(file, config);
    }
    return config;
  }

  /** The unflattened preset file. */
  file(type: PresetType, vendor: string, name: string): Config {
    const file = this.vendors.get(vendor)?.lists[type].get(name);
    if (!file) throw new Error(`no ${type} "${name}" in vendor ${vendor}`);
    return this.read(file);
  }

  private findParent(type: PresetType, vendor: Vendor, name: string): { vendor: Vendor; file: string } | null {
    const candidates = [vendor, this.vendors.get(FILAMENT_LIBRARY), ...this.vendors.values()];
    for (const v of candidates) {
      const file = v?.lists[type].get(name);
      if (v && file) return { vendor: v, file };
    }
    return null;
  }

  /** The flattened preset (see the top of this file). */
  flatten(type: PresetType, vendorName: string, name: string): Config {
    const vendor = this.vendors.get(vendorName);
    const leaf = vendor?.lists[type].get(name);
    if (!vendor || !leaf) throw new Error(`no ${type} "${name}" in vendor ${vendorName}`);
    const chain: Config[] = [];
    const seen = new Set<string>();
    let node: { vendor: Vendor; file: string } | null = { vendor, file: leaf };
    while (node) {
      if (seen.has(node.file)) throw new Error(`circular inherits chain at ${node.file}`);
      seen.add(node.file);
      const preset = this.read(node.file);
      chain.push(preset);
      const inherits = typeof preset.inherits === 'string' ? preset.inherits.trim() : '';
      if (!inherits) break;
      node = this.findParent(type, node.vendor, inherits);
      if (!node) throw new Error(`${type} "${name}" inherits "${inherits}", which is missing`);
    }
    const merged: Config = {};
    for (let i = chain.length - 1; i >= 0; i--) Object.assign(merged, chain[i]);
    delete merged.inherits;
    merged.name = name;
    merged.from = 'system';
    merged.type = type;
    merged.instantiation = 'true';
    return merged;
  }

  /** Presets of a vendor that a user can pick (instantiation "true"), sorted by name. */
  instantiable(type: PresetType, vendorName: string): string[] {
    const vendor = this.vendors.get(vendorName);
    if (!vendor) return [];
    const out: string[] = [];
    for (const [name, file] of vendor.lists[type]) {
      const preset = this.read(file);
      if (String(preset.instantiation ?? '') === 'true') out.push(name);
    }
    return out.sort();
  }
}

const listOf = (value: Config[string] | undefined): string[] =>
  (Array.isArray(value) ? value : (value ?? '').split(';')).map((s) => s.trim()).filter(Boolean);

/** Whether a flattened process or filament names `machine` in compatible_printers (an empty list suits every printer). */
export function listsPrinter(preset: Config, machine: string, emptyMeansAll: boolean): boolean {
  const list = listOf(preset.compatible_printers);
  return list.length === 0 ? emptyMeansAll : list.includes(machine);
}
