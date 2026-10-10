// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  ocppRequestSchemaPath,
  schemaToCommandDef,
  type CommandFieldDef,
  type OcppCommandVersion,
  type OcppRequestSchema,
} from '@evtivity/lib/ocpp-command-schema';
import { CSMS_ACTIONS, CSMS_ACTIONS_16 } from '../ocpp-command-actions';
import {
  formToPayloadJson,
  formValuesToPayload,
  payloadToFormValues,
  resolveFields,
  validatePayload,
} from '../ocpp-schema';

// Every command of the Advanced Command form, with the schema the API serves
// for it (GET /v1/ocpp/commands/:version/:action/schema).
const SCHEMAS = import.meta.glob<string>('../../../../../schemas/ocpp-*/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const now = new Date('2026-05-06T07:08:09.000Z');

function commandDef(version: OcppCommandVersion, action: string) {
  const content = SCHEMAS[`../../../../../schemas/${ocppRequestSchemaPath(version, action)}`];
  if (content == null) throw new Error(`No schema for ${version} ${action}`);
  const schema = JSON.parse(content) as OcppRequestSchema;
  return schemaToCommandDef(action, version, schema, now);
}

// The operator fills the strings the stub leaves empty.
function fill(
  fields: CommandFieldDef[],
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    const field = fields.find((f) => f.name === key);
    result[key] = field == null ? value : fillValue(field, value);
  }
  return result;
}

function fillValue(field: CommandFieldDef, value: unknown): unknown {
  if (field.type === 'string' && value === '') {
    return field.format === 'uri' ? 'https://example.com/file' : 'x';
  }
  if (field.type === 'object') return fill(field.fields ?? [], value as Record<string, unknown>);
  if (field.type === 'array') {
    return (value as unknown[]).map((item) => {
      if (field.fields != null) return fill(field.fields, item as Record<string, unknown>);
      return field.item != null ? fillValue(field.item, item) : item;
    });
  }
  return value;
}

const commands = [
  ...CSMS_ACTIONS.map((action) => ['ocpp2.1' as const, action] as const),
  ...CSMS_ACTIONS_16.map((action) => ['ocpp1.6' as const, action] as const),
];

describe.each(commands)('Advanced Command %s %s', (version, action) => {
  const def = commandDef(version, action);
  const fields = resolveFields(def);

  it('shows the schema minimal payload in advanced mode while the form is empty', () => {
    expect(JSON.parse(formToPayloadJson({}, def, now))).toEqual(def.example);
  });

  it('accepts the minimal payload once the operator fills its empty strings', () => {
    const stubErrors = Object.values(validatePayload(def.example, fields));
    expect(stubErrors.every((issue) => issue.key === 'validation.required')).toBe(true);
    expect(validatePayload(fill(def.fields, def.example), fields)).toEqual({});
  });

  it('keeps the form and advanced mode in sync both ways', () => {
    const payload = fill(def.fields, def.example);
    const values = payloadToFormValues(payload, fields);
    expect(formValuesToPayload(values, fields)).toEqual(payload);
    expect(JSON.parse(formToPayloadJson(values, def, now))).toEqual(payload);
  });
});
