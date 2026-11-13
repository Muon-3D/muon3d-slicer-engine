/** A malformed request, usable without loading the engine's ops or field exporter. */
export class BadRequest extends Error {
  readonly detail?: string;
  readonly objects?: string[];
  constructor(message: string, detail?: string, objects?: string[]) {
    super(message);
    if (detail !== undefined) this.detail = detail;
    if (objects !== undefined) this.objects = objects;
  }
}
