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
  minimum?: number;
  maximum?: number;
  maxLength?: number;
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
  minimum?: number | undefined;
  maximum?: number | undefined;
  maxLength?: number | undefined;
  objectFields?: ResolvedField[] | undefined;
  arrayItemFields?: ResolvedField[] | undefined;
}

function commandFieldToResolved(field: CommandFieldDef): ResolvedField {
  const resolved: ResolvedField = {
    name: field.name,
    kind: field.type,
    required: field.required,
    description: field.description || undefined,
    minimum: field.minimum,
    maximum: field.maximum,
    maxLength: field.maxLength,
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

export interface ValidationIssue {
  key: string;
  params?: Record<string, number | string>;
}

// Errors keyed by dotted field path ("evse.id", "messageInfo.0.priority").
export type ValidationErrors = Record<string, ValidationIssue>;

function fieldPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}.${name}`;
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function validateField(
  field: ResolvedField,
  value: unknown,
  path: string,
  errors: ValidationErrors,
): void {
  if (isMissing(value)) {
    if (field.required) {
      errors[path] = { key: 'validation.required' };
    }
    return;
  }

  switch (field.kind) {
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors[path] = { key: 'validation.invalidNumber' };
        return;
      }
      if (field.kind === 'integer' && !Number.isInteger(value)) {
        errors[path] = { key: 'validation.invalidNumber' };
        return;
      }
      if (field.minimum != null && value < field.minimum) {
        errors[path] = { key: 'validation.min', params: { min: field.minimum } };
        return;
      }
      if (field.maximum != null && value > field.maximum) {
        errors[path] = { key: 'validation.max', params: { max: field.maximum } };
      }
      return;
    }
    case 'boolean':
      if (typeof value !== 'boolean') {
        errors[path] = { key: 'validation.invalidValue' };
      }
      return;
    case 'enum':
      if (
        typeof value !== 'string' ||
        (field.enumValues != null && !field.enumValues.includes(value))
      ) {
        errors[path] = { key: 'validation.invalidValue' };
      }
      return;
    case 'datetime':
      if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
        errors[path] = { key: 'validation.invalidValue' };
      }
      return;
    case 'string':
      if (typeof value !== 'string') {
        errors[path] = { key: 'validation.invalidValue' };
        return;
      }
      if (field.maxLength != null && value.length > field.maxLength) {
        errors[path] = { key: 'validation.maxLength', params: { max: field.maxLength } };
      }
      return;
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors[path] = { key: 'validation.invalidValue' };
        return;
      }
      if (field.objectFields != null) {
        validateFields(field.objectFields, value as Record<string, unknown>, path, errors);
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors[path] = { key: 'validation.invalidValue' };
        return;
      }
      if (field.required && value.length === 0) {
        errors[path] = { key: 'validation.required' };
        return;
      }
      if (field.arrayItemFields != null) {
        value.forEach((item, index) => {
          const itemPath = `${path}.${String(index)}`;
          if (typeof item !== 'object' || item == null || Array.isArray(item)) {
            errors[itemPath] = { key: 'validation.invalidValue' };
            return;
          }
          validateFields(
            field.arrayItemFields ?? [],
            item as Record<string, unknown>,
            itemPath,
            errors,
          );
        });
      }
      return;
    }
    default:
      return;
  }
}

function validateFields(
  fields: ResolvedField[],
  payload: Record<string, unknown>,
  parentPath: string,
  errors: ValidationErrors,
): void {
  for (const field of fields) {
    validateField(field, payload[field.name], fieldPath(parentPath, field.name), errors);
  }
}

// Validates a command payload against the schema-derived field definitions.
// Works for both the generated form (after formValuesToPayload) and raw JSON
// mode, since both produce the same payload shape.
export function validatePayload(
  payload: Record<string, unknown>,
  fields: ResolvedField[],
): ValidationErrors {
  const errors: ValidationErrors = {};
  validateFields(fields, payload, '', errors);
  return errors;
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
            .filter((item) => item != null && Object.keys(item).length > 0);
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
