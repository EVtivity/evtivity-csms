// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Types matching the API response from /v1/ocpp/commands/{version}/{action}/schema

interface CommandFieldDef {
  name: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'enum' | 'object' | 'array' | 'datetime';
  required: boolean;
  values?: string[];
  default?: unknown;
  description: string;
  fields?: CommandFieldDef[];
}

export interface CommandSchema {
  action: string;
  version: string;
  fields: CommandFieldDef[];
  example: Record<string, unknown>;
}

// Internal field representation used by SchemaForm

type FieldKind =
  | 'enum'
  | 'string'
  | 'datetime'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array';

export interface ResolvedField {
  name: string;
  kind: FieldKind;
  required: boolean;
  description?: string | undefined;
  enumValues?: string[] | undefined;
  objectFields?: ResolvedField[] | undefined;
  arrayItemFields?: ResolvedField[] | undefined;
}

function commandFieldToResolved(field: CommandFieldDef): ResolvedField {
  const resolved: ResolvedField = {
    name: field.name,
    kind: field.type as FieldKind,
    required: field.required,
    description: field.description || undefined,
  };

  if (field.type === 'enum' && field.values != null) {
    resolved.enumValues = field.values;
  }

  if (field.type === 'object' && field.fields != null) {
    resolved.objectFields = field.fields.map(commandFieldToResolved);
  }

  if (field.type === 'array' && field.fields != null) {
    resolved.arrayItemFields = field.fields.map(commandFieldToResolved);
  }

  return resolved;
}

export function resolveFields(schema: CommandSchema): ResolvedField[] {
  return schema.fields.map(commandFieldToResolved);
}

export function generateJsonStub(schema: CommandSchema): string {
  return JSON.stringify(schema.example, null, 2);
}

export function formValuesToPayload(
  values: Record<string, unknown>,
  fields: ResolvedField[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    const value = values[field.name];

    if (value === '' || value === undefined || value === null) {
      if (field.required && field.kind === 'boolean') {
        result[field.name] = false;
      }
      continue;
    }

    switch (field.kind) {
      case 'integer':
        result[field.name] = Math.round(Number(value));
        break;
      case 'number':
        result[field.name] = Number(value);
        break;
      case 'boolean':
        result[field.name] = Boolean(value);
        break;
      case 'datetime':
        result[field.name] = new Date(value as string).toISOString();
        break;
      case 'object':
        if (field.objectFields != null && typeof value === 'object') {
          const nested = formValuesToPayload(value as Record<string, unknown>, field.objectFields);
          if (Object.keys(nested).length > 0 || field.required) {
            result[field.name] = nested;
          }
        }
        break;
      case 'array':
        if (Array.isArray(value)) {
          const items = value
            .map((item: unknown) => {
              if (field.arrayItemFields != null && typeof item === 'object' && item != null) {
                return formValuesToPayload(item as Record<string, unknown>, field.arrayItemFields);
              }
              return item;
            })
            .filter((item) => item != null && Object.keys(item as object).length > 0);
          if (items.length > 0) {
            result[field.name] = items;
          }
        }
        break;
      default:
        result[field.name] = value;
        break;
    }
  }

  return result;
}
