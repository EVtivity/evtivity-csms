// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  buildCommandStub,
  type CommandDef,
  type CommandFieldDef,
} from '@evtivity/lib/ocpp-command-schema';

// The API response of /v1/ocpp/commands/{version}/{action}/schema.
export type CommandSchema = CommandDef;

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
  multipleOf?: number | undefined;
  maxLength?: number | undefined;
  format?: string | undefined;
  minItems?: number | undefined;
  maxItems?: number | undefined;
  objectFields?: ResolvedField[] | undefined;
  /** Properties of an array's object items. */
  arrayItemFields?: ResolvedField[] | undefined;
  /** The item of an array of strings, numbers, booleans or enum values. */
  arrayItem?: ResolvedField | undefined;
}

function commandFieldToResolved(field: CommandFieldDef): ResolvedField {
  const resolved: ResolvedField = {
    name: field.name,
    kind: field.type,
    required: field.required,
    description: field.description || undefined,
    minimum: field.minimum,
    maximum: field.maximum,
    multipleOf: field.multipleOf,
    maxLength: field.maxLength,
    format: field.format,
    minItems: field.minItems,
    maxItems: field.maxItems,
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

  if (field.type === 'array' && field.item != null) {
    resolved.arrayItem = commandFieldToResolved(field.item);
  }

  return resolved;
}

export function resolveFields(schema: CommandSchema): ResolvedField[] {
  return schema.fields.map(commandFieldToResolved);
}

/** The schema's minimal payload (required fields only), pretty-printed. */
export function generateJsonStub(schema: CommandSchema, now: Date = new Date()): string {
  return JSON.stringify(buildCommandStub(schema.fields, now), null, 2);
}

// Whether the operator entered anything: a value other than an empty string,
// null or undefined, at any depth.
function hasEnteredValue(value: unknown): boolean {
  if (value === '' || value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.some(hasEnteredValue);
  if (typeof value === 'object') return Object.values(value).some(hasEnteredValue);
  return true;
}

/**
 * The advanced mode JSON for the form: the payload the form would send, or the
 * schema's minimal payload while the form is empty.
 */
export function formToPayloadJson(
  values: Record<string, unknown>,
  schema: CommandSchema,
  now: Date = new Date(),
): string {
  if (!hasEnteredValue(values)) return generateJsonStub(schema, now);
  return JSON.stringify(formValuesToPayload(values, resolveFields(schema)), null, 2);
}

export interface ValidationIssue {
  key: string;
  params?: Record<string, number | string>;
}

// Errors keyed by dotted field path ("evse.id", "messageInfo.0.priority").
export type ValidationErrors = Record<string, ValidationIssue>;

// OCPP 2.1 allows a vendor `customData` object on every object; the form
// leaves it out. Every other property must be a field of the schema.
const ALLOWED_EXTRA_KEYS = new Set(['customData']);

function fieldPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}.${name}`;
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function isMultipleOf(value: number, step: number): boolean {
  const quotient = value / step;
  return Math.abs(quotient - Math.round(quotient)) < 1e-9;
}

function validateNumber(field: ResolvedField, value: unknown): ValidationIssue | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { key: 'validation.invalidNumber' };
  }
  if (field.kind === 'integer' && !Number.isInteger(value)) {
    return { key: 'validation.invalidNumber' };
  }
  if (field.multipleOf != null && !isMultipleOf(value, field.multipleOf)) {
    return { key: 'validation.invalidNumber' };
  }
  if (field.minimum != null && value < field.minimum) {
    return { key: 'validation.min', params: { min: field.minimum } };
  }
  if (field.maximum != null && value > field.maximum) {
    return { key: 'validation.max', params: { max: field.maximum } };
  }
  return null;
}

function validateString(field: ResolvedField, value: unknown): ValidationIssue | null {
  if (typeof value !== 'string') return { key: 'validation.invalidValue' };
  if (field.maxLength != null && value.length > field.maxLength) {
    return { key: 'validation.maxLength', params: { max: field.maxLength } };
  }
  if (field.format === 'uri' && !URL.canParse(value)) {
    return { key: 'validation.invalidUrl' };
  }
  return null;
}

function validateArray(
  field: ResolvedField,
  value: unknown,
  path: string,
  errors: ValidationErrors,
): void {
  if (!Array.isArray(value)) {
    errors[path] = { key: 'validation.invalidValue' };
    return;
  }
  if (field.required && value.length === 0) {
    errors[path] = { key: 'validation.required' };
    return;
  }
  if (field.minItems != null && value.length < field.minItems) {
    errors[path] = { key: 'validation.minItems', params: { min: field.minItems } };
    return;
  }
  if (field.maxItems != null && value.length > field.maxItems) {
    errors[path] = { key: 'validation.maxItems', params: { max: field.maxItems } };
    return;
  }
  value.forEach((item: unknown, index) => {
    const itemPath = `${path}.${String(index)}`;
    if (field.arrayItem != null) {
      validateField(field.arrayItem, item, itemPath, errors);
      return;
    }
    if (field.arrayItemFields == null) return;
    if (typeof item !== 'object' || item == null || Array.isArray(item)) {
      errors[itemPath] = { key: 'validation.invalidValue' };
      return;
    }
    validateFields(field.arrayItemFields, item as Record<string, unknown>, itemPath, errors);
  });
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

  let issue: ValidationIssue | null = null;
  switch (field.kind) {
    case 'integer':
    case 'number':
      issue = validateNumber(field, value);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') issue = { key: 'validation.invalidValue' };
      break;
    case 'enum':
      if (
        typeof value !== 'string' ||
        (field.enumValues != null && !field.enumValues.includes(value))
      ) {
        issue = { key: 'validation.invalidValue' };
      }
      break;
    case 'datetime':
      if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
        issue = { key: 'validation.invalidValue' };
      }
      break;
    case 'string':
      issue = validateString(field, value);
      break;
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value)) {
        issue = { key: 'validation.invalidValue' };
      } else if (field.objectFields != null) {
        validateFields(field.objectFields, value as Record<string, unknown>, path, errors);
      }
      break;
    case 'array':
      validateArray(field, value, path, errors);
      break;
    default:
      break;
  }
  if (issue != null) errors[path] = issue;
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
  const known = new Set(fields.map((field) => field.name));
  for (const key of Object.keys(payload)) {
    if (!known.has(key) && !ALLOWED_EXTRA_KEYS.has(key)) {
      errors[fieldPath(parentPath, key)] = { key: 'validation.unknownField' };
    }
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value != null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// The payload value of one form value, or undefined when the form leaves it out.
function toPayloadValue(field: ResolvedField, value: unknown): unknown {
  if (value === '' || value === undefined || value === null) {
    return field.required && field.kind === 'boolean' ? false : undefined;
  }

  switch (field.kind) {
    case 'integer':
      return Math.round(Number(value));
    case 'number':
      return Number(value);
    case 'boolean':
      return Boolean(value);
    case 'datetime': {
      // An unparseable value stays as typed, so validation reports it.
      const date = new Date(value as string);
      return Number.isNaN(date.getTime()) ? value : date.toISOString();
    }
    case 'object': {
      const record = asRecord(value);
      if (record == null || field.objectFields == null) return undefined;
      const nested = formValuesToPayload(record, field.objectFields);
      return Object.keys(nested).length > 0 || field.required ? nested : undefined;
    }
    case 'array': {
      if (!Array.isArray(value)) return undefined;
      const items = value
        .map((item: unknown) => {
          if (field.arrayItem != null) return toPayloadValue(field.arrayItem, item);
          const record = asRecord(item);
          if (field.arrayItemFields != null && record != null) {
            const nested = formValuesToPayload(record, field.arrayItemFields);
            return Object.keys(nested).length > 0 ? nested : undefined;
          }
          return item === '' || item == null ? undefined : item;
        })
        .filter((item) => item !== undefined);
      return items.length > 0 ? items : undefined;
    }
    default:
      return value;
  }
}

export function formValuesToPayload(
  values: Record<string, unknown>,
  fields: ResolvedField[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const converted = toPayloadValue(field, values[field.name]);
    if (converted !== undefined) result[field.name] = converted;
  }
  return result;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

// The datetime-local input value (local time, whole seconds) of an ISO date.
function toDatetimeLocal(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function toFormValue(field: ResolvedField, value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  switch (field.kind) {
    case 'datetime':
      return toDatetimeLocal(value);
    case 'object': {
      const record = asRecord(value);
      return record != null && field.objectFields != null
        ? payloadToFormValues(record, field.objectFields)
        : value;
    }
    case 'array':
      if (!Array.isArray(value)) return value;
      return value.map((item: unknown) => {
        if (field.arrayItem != null) return toFormValue(field.arrayItem, item);
        const record = asRecord(item);
        return record != null && field.arrayItemFields != null
          ? payloadToFormValues(record, field.arrayItemFields)
          : item;
      });
    default:
      return value;
  }
}

/**
 * The form values of a payload (the inverse of formValuesToPayload): ISO dates
 * become datetime-local values. Properties that are not form fields are left
 * out, since the form cannot show them.
 */
export function payloadToFormValues(
  payload: Record<string, unknown>,
  fields: ResolvedField[],
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const value = toFormValue(field, payload[field.name]);
    if (value !== undefined) values[field.name] = value;
  }
  return values;
}
