// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ocppRequestSchemaPath,
  schemaToCommandDef,
  type CommandFieldDef,
  type OcppCommandVersion,
  type OcppRequestSchema,
} from '@evtivity/lib/ocpp-command-schema';
import { ActionRegistry } from '../generated/v2_1/registry.js';
import { ActionRegistry as ActionRegistry16 } from '../generated/v1_6/registry.js';

// The CSMS Advanced Command form starts from the stub of the command's schema
// (GET /v1/ocpp/commands/:version/:action/schema). Check it for every action.
const schemasRoot = path.resolve(import.meta.dirname, '../../../../schemas');

function readSchema(relativePath: string): string | null {
  const file = path.join(schemasRoot, relativePath);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

type Validator = { validateRequest: (payload: unknown) => boolean };

// The stub leaves required strings empty for the operator. Fill them the way
// an operator would, so the payload can be checked against the OCPP validator.
function fillStrings(fields: CommandFieldDef[], payload: Record<string, unknown>): void {
  for (const field of fields) {
    const value = payload[field.name];
    if (value === undefined) continue;
    payload[field.name] = fillValue(field, value);
  }
}

function fillValue(field: CommandFieldDef, value: unknown): unknown {
  if (field.type === 'string' && value === '') {
    return field.format === 'uri' ? 'https://example.com/file' : 'x';
  }
  if (field.type === 'object') {
    fillStrings(field.fields ?? [], value as Record<string, unknown>);
  }
  if (field.type === 'array') {
    return (value as unknown[]).map((item) => {
      if (field.fields != null) {
        fillStrings(field.fields, item as Record<string, unknown>);
        return item;
      }
      return field.item != null ? fillValue(field.item, item) : item;
    });
  }
  return value;
}

function actionsWithSchema(
  version: OcppCommandVersion,
  registry: Record<string, Validator>,
): Array<[string, OcppRequestSchema, Validator]> {
  const result: Array<[string, OcppRequestSchema, Validator]> = [];
  for (const [action, entry] of Object.entries(registry)) {
    const content = readSchema(ocppRequestSchemaPath(version, action));
    if (content == null) continue;
    result.push([action, JSON.parse(content) as OcppRequestSchema, entry]);
  }
  return result;
}

describe.each([
  ['ocpp2.1' as const, ActionRegistry as unknown as Record<string, Validator>, 90],
  ['ocpp1.6' as const, ActionRegistry16 as unknown as Record<string, Validator>, 28],
])('OCPP command stubs (%s)', (version, registry, minActions) => {
  it('reads a request schema for the registry actions', () => {
    expect(actionsWithSchema(version, registry).length).toBeGreaterThanOrEqual(minActions);
  });

  it('builds a stub that passes the OCPP request validator once its strings are filled', () => {
    const failures: string[] = [];
    for (const [action, schema, entry] of actionsWithSchema(version, registry)) {
      const def = schemaToCommandDef(action, version, schema);
      const payload = structuredClone(def.example);
      fillStrings(def.fields, payload);
      if (!entry.validateRequest(payload)) failures.push(`${action}: ${JSON.stringify(payload)}`);
    }
    expect(failures).toEqual([]);
  });
});
