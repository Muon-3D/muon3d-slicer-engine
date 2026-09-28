// settings.edit: what an edit writes, with Orca's edit handlers, questions and notices, per scope.
//   preset scopes  model.ts planEdit / planValues / planResetAll (the preset's overrides)
//   object         object.ts objectLayerHeight + planObjectEdit / planObjectValues / planObjectAdd
//   plate          plate.ts: the spiral vase question (blocking) with its object writes, the print
//                  sequence questions
// The writes are what a client applies to its store in one undo step; `writes` never holds a no-op.
import type { SettingScope } from '../../../packages/protocol/src/catalogue.ts';
import type { ConfigPatch } from '../../../packages/protocol/src/data.ts';
import type { SettingPrompt, SettingsEdit, SettingsEditResult, SettingsScope } from '../../../packages/protocol/src/settings.ts';
import { currentOf, effectiveWrites, planEdit, planResetAll, planValues, rulesEnv, type SettingsState } from './model.ts';
import {
  effectiveObjectWrites,
  inheritedValue,
  objectLayerHeight,
  objectRulesEnv,
  objectSettingKeys,
  planObjectAdd,
  planObjectEdit,
  planObjectValues,
  type ObjectWrites,
} from './object.ts';
import { plateEditPrompts, plateRulesEnv, spiralQuestion, SPIRAL_NO, SPIRAL_YES, vaseObjectWrites } from './plate.ts';
import type { RulePrompt } from './rules.ts';
import { isOn, withSlot } from './text.ts';

/** A request the service refuses; `code` is the protocol's error code. */
export class SettingsRequestError extends Error {
  readonly code: number;
  readonly detail?: string;
  constructor(code: number, message: string, detail?: string) {
    super(message);
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

const BAD_REQUEST = 5;

const toPrompt = (p: RulePrompt): SettingPrompt => ({
  id: p.id,
  scope: p.scope,
  key: p.key,
  message: p.message,
  choices: p.choices.map((c) => ({ label: c.label, values: { ...c.values } })),
});

export interface EditInput {
  state: SettingsState;
  object?: ConfigPatch;
  objects?: Array<{ id: string; settings?: ConfigPatch }>;
}

type Planned = Omit<SettingsEditResult, 'version' | 'view'>;

export function planSettingsEdit(scope: SettingsScope, edit: SettingsEdit, input: EditInput): Planned {
  if (scope === 'object') return objectEdit(edit, input);
  if (scope === 'plate') return plateEdit(edit, input);
  return presetEdit(scope, edit, input.state);
}

function presetEdit(scope: SettingScope, edit: SettingsEdit, state: SettingsState): Planned {
  if ('set' in edit) {
    const plan = planEdit(state, scope, edit.set, edit.index, edit.value, rulesEnv(state));
    return { writes: effectiveWrites(state, scope, plan.writes), prompts: plan.prompts.map(toPrompt), notices: plan.notice ? [plan.notice] : [] };
  }
  if ('apply' in edit) return { writes: effectiveWrites(state, scope, planValues(state, scope, edit.apply)), prompts: [], notices: [] };
  if ('reset' in edit) return { writes: effectiveWrites(state, scope, planResetAll(state, scope, edit.reset)), prompts: [], notices: [] };
  throw new SettingsRequestError(BAD_REQUEST, `"add" is an edit of an object's settings, not of the ${scope} settings.`);
}

function objectEdit(edit: SettingsEdit, { state, object: settings }: EditInput): Planned {
  const known = objectSettingKeys(state.catalogue, state.filamentCount ?? 1).keys;
  if ('set' in edit) {
    const key = edit.set;
    if (!known.has(key)) throw new SettingsRequestError(BAD_REQUEST, `"${key}" cannot be set per object.`);
    let value = edit.value;
    if (edit.index !== undefined) {
      const current = settings && Object.hasOwn(settings, key) ? settings[key] : inheritedValue(state, key);
      value = withSlot(key, current, edit.index, value);
    }
    const checked = key === 'layer_height' ? objectLayerHeight(state, value) : { text: value };
    const plan = planObjectEdit(state, settings, key, checked.text, objectRulesEnv(state, settings), known);
    return { writes: plan.writes, prompts: plan.prompts.map(toPrompt), notices: checked.notice ? [checked.notice] : [] };
  }
  if ('apply' in edit) {
    const writes = planObjectValues(settings, edit.apply, known);
    if (!writes) throw new SettingsRequestError(BAD_REQUEST, 'These values include settings an object cannot have: apply them to the global settings.');
    return { writes, prompts: [], notices: [] };
  }
  if ('reset' in edit) {
    const writes: ObjectWrites = {};
    for (const { key } of edit.reset) writes[key] = null;
    return { writes: effectiveObjectWrites(settings, writes), prompts: [], notices: [] };
  }
  if (!known.has(edit.add)) throw new SettingsRequestError(BAD_REQUEST, `"${edit.add}" cannot be set per object.`);
  return { writes: planObjectAdd(state, settings, edit.add, known), prompts: [], notices: [] };
}

const withoutNoops = (own: ConfigPatch, writes: Record<string, string | null>) =>
  Object.fromEntries(Object.entries(writes).filter(([k, v]) => (Object.hasOwn(own, k) ? own[k] : null) !== v));

function plateEdit(edit: SettingsEdit, { state, objects = [] }: EditInput): Planned {
  const own = state.plateSettings ?? {};
  const objectCount = objects.length;
  if ('set' in edit) {
    const { set: key, value } = edit;
    // PartPlate::set_spiral_vase_mode: turning spiral vase on asks first; nothing changes until the answer.
    if (key === 'spiral_mode' && isOn(value)) {
      const spiral = own.spiral_mode !== undefined ? isOn(own.spiral_mode) : isOn(currentOf(state, 'process', 'spiral_mode'));
      if (!spiral) {
        const known = objectSettingKeys(state.catalogue, state.filamentCount ?? 1).keys;
        const writes = vaseObjectWrites(objects, (k) => currentOf(state, 'process', k), known);
        const byObject = new Map<string, ConfigPatch>();
        for (const w of writes) byObject.set(w.id, { ...byObject.get(w.id), [w.key]: w.value });
        const i3 = currentOf(state, 'machine', 'printer_structure') === 'i3';
        return {
          writes: {},
          prompts: [
            {
              id: 'spiral-vase-plate',
              scope: 'process',
              key,
              message: spiralQuestion(i3),
              blocking: true,
              choices: [
                { label: SPIRAL_YES, values: { spiral_mode: '1' }, ...(byObject.size ? { objects: [...byObject].map(([id, values]) => ({ id, values })) } : {}) },
                { label: SPIRAL_NO, values: {} },
              ],
            },
          ],
          notices: [],
        };
      }
    }
    const prompts = plateEditPrompts(key, value, plateRulesEnv(state, own, objectCount)).map(toPrompt);
    return { writes: withoutNoops(own, { [key]: value }), prompts, notices: [] };
  }
  if ('apply' in edit) {
    const result: Planned = { writes: withoutNoops(own, { ...edit.apply }), prompts: [], notices: [] };
    if (edit.objects?.length) {
      result.objects = edit.objects.map(({ id, values }) => {
        const settings = objects.find((o) => o.id === id)?.settings ?? {};
        return { id, writes: withoutNoops(settings, { ...values }) };
      });
    }
    return result;
  }
  if ('reset' in edit) return { writes: withoutNoops(own, Object.fromEntries(edit.reset.map(({ key }) => [key, null]))), prompts: [], notices: [] };
  throw new SettingsRequestError(BAD_REQUEST, '"add" is an edit of an object\'s settings, not of a plate\'s.');
}
