// The engine ops' params and results: protocol v2's shapes checked and converted to the bridge's and back
// (bridge.ts). A request the host cannot use fails with BadRequest, naming what is wrong.
import type { Config, ConfigSet, Mesh } from '../../packages/protocol/src/data.ts';
import type { CheckParams, CheckResult, PlateObject, SliceParams, SliceResult } from '../../packages/protocol/src/ops.ts';
import type { CheckJob, CheckOutput, EngineObject, SliceJob, SliceOutput } from './bridge.ts';

/** A request the host refuses (BadRequest). */
export class BadRequest extends Error {
  readonly detail?: string;
  constructor(message: string, detail?: string) {
    super(message);
    if (detail !== undefined) this.detail = detail;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function config(value: unknown, what: string): Config {
  if (!isObject(value)) throw new BadRequest(`${what} must be a preset: a map of setting keys to text or lists of text.`);
  return value as Config;
}

function configSet(value: unknown): ConfigSet {
  if (!isObject(value)) throw new BadRequest('"configs" must be { machine, process, filaments }.');
  const filaments = value.filaments;
  if (!Array.isArray(filaments) || filaments.length === 0) throw new BadRequest('"configs.filaments" must list at least one filament preset.');
  return {
    machine: config(value.machine, '"configs.machine"'),
    process: config(value.process, '"configs.process"'),
    filaments: filaments.map((f, i) => config(f, `"configs.filaments[${i}]"`)),
  };
}

/** A mesh as a triangle soup: an indexed mesh is expanded (the bridge reads soups, as Orca's STL import does). */
export function soup(mesh: unknown, what: string): Float32Array {
  if (!isObject(mesh) || !(mesh.positions instanceof Float32Array)) throw new BadRequest(`${what}.mesh.positions must be a Float32Array.`);
  const { positions, indices } = mesh as unknown as Mesh;
  if (indices === undefined) {
    if (positions.length % 9 !== 0) throw new BadRequest(`${what}.mesh.positions must hold 9 floats per triangle (it has ${positions.length}).`);
    return positions;
  }
  if (!(indices instanceof Uint32Array)) throw new BadRequest(`${what}.mesh.indices must be a Uint32Array.`);
  if (indices.length % 3 !== 0) throw new BadRequest(`${what}.mesh.indices must hold 3 indices per triangle.`);
  if (positions.length % 3 !== 0) throw new BadRequest(`${what}.mesh.positions must hold 3 floats per vertex.`);
  const vertices = positions.length / 3;
  const out = new Float32Array(indices.length * 3);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (v >= vertices) throw new BadRequest(`${what}.mesh.indices refers to vertex ${v}; the mesh has ${vertices}.`);
    out[i * 3] = positions[v * 3];
    out[i * 3 + 1] = positions[v * 3 + 1];
    out[i * 3 + 2] = positions[v * 3 + 2];
  }
  return out;
}

function objects(value: unknown, withConfig: boolean): EngineObject[] {
  if (!Array.isArray(value)) throw new BadRequest('"objects" must be a list of plate objects.');
  return value.map((o: PlateObject, i) => {
    const what = `"objects[${i}]"`;
    if (!isObject(o) || typeof o.name !== 'string' || o.name === '') throw new BadRequest(`${what} needs a "name".`);
    const out: EngineObject = { name: o.name, positions: soup(o.mesh, what) };
    if (withConfig && o.config !== undefined) {
      if (!isObject(o.config) || Object.values(o.config).some((v) => typeof v !== 'string')) throw new BadRequest(`${what}.config must map setting keys to text.`);
      if (Object.keys(o.config).length > 0) out.config = o.config;
    }
    return out;
  });
}

export function sliceJob(params: SliceParams): SliceJob {
  if (!isObject(params)) throw new BadRequest('slice needs { configs, objects }.');
  const { machine, process, filaments } = configSet(params.configs);
  const output = isObject(params.output) ? params.output : {};
  return {
    machine,
    process,
    filaments,
    objects: objects(params.objects, true),
    toolpaths: output.toolpaths !== false,
    toolpathExtras: output.toolpathExtras !== false,
  };
}

export function checkJob(params: CheckParams): CheckJob {
  if (!isObject(params)) throw new BadRequest('check needs { configs, objects }.');
  const { machine, process, filaments } = configSet(params.configs);
  return { machine, process, filaments, objects: objects(params.objects, false) };
}

export function sliceResult(output: SliceOutput, heapBytes: number | undefined): SliceResult {
  const paths = output.toolpaths;
  const result: SliceResult = {
    gcode: output.gcode,
    stats: output.stats,
    toolpaths: paths && {
      format: 1,
      layerCount: paths.layerCount,
      layerZ: paths.layerZ,
      extrusions: paths.extrusions,
      travels: paths.travels,
      roles: paths.roles.map((name, i) => ({ name, lengthMm: paths.roleLength[i] ?? 0 })),
      lineWidth: paths.lineWidth,
      bounds: paths.bounds,
    },
    toolpathExtras: output.toolpathExtras,
    warnings: output.warnings,
    timings: output.timings,
  };
  if (heapBytes !== undefined) result.heapBytes = heapBytes;
  return result;
}

export function checkResult(output: CheckOutput, heapBytes: number | undefined): CheckResult {
  const result: CheckResult = {
    objects: output.objects.map((o) => ({
      name: o.name,
      inside: o.inside,
      exclusionHits: o.exclusionHits.map((h) => ({ extruder: h.extruder, region: h.regionIndex, triangles: h.triangles })),
    })),
  };
  if (heapBytes !== undefined) result.heapBytes = heapBytes;
  return result;
}
