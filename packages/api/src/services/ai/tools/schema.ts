// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * JSON schema helpers for tool arguments: cleaning OpenAPI schemas for a
 * model, deriving the strict-compatible form, and undoing the strict form's
 * nulls before validation.
 */

import type { JsonSchema } from './catalog-types.js';

/** Keywords a model never needs (and some providers reject). */
const DROPPED_KEYWORDS = new Set([
  'default',
  'examples',
  'example',
  'title',
  '$schema',
  'readOnly',
]);

/** Keywords the strict tool modes accept. Others are dropped from the strict form. */
const STRICT_KEYWORDS = new Set([
  'type',
  'enum',
  'description',
  'items',
  'properties',
  'required',
  'additionalProperties',
  'anyOf',
  'pattern',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Removes keywords a model does not need, recursively. Never mutates `schema`. */
export function cleanSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DROPPED_KEYWORDS.has(key)) continue;
    if (key === 'properties' && isObject(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, isObject(v) ? cleanSchema(v) : v]),
      );
    } else if ((key === 'items' || key === 'additionalProperties') && isObject(value)) {
      out[key] = cleanSchema(value);
    } else if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
      out[key] = value.map((v: unknown) => (isObject(v) ? cleanSchema(v) : v));
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** `schema` plus null (the strict form of an optional or OpenAPI-nullable field). */
function withNull(schema: JsonSchema): JsonSchema {
  const type = schema['type'];
  const out: JsonSchema = { ...schema };
  if (typeof type === 'string') out['type'] = [type, 'null'];
  else if (Array.isArray(type) && !type.includes('null'))
    out['type'] = [...(type as unknown[]), 'null'];
  else if (type === undefined) return { anyOf: [schema, { type: 'null' }] };
  if (Array.isArray(schema['enum']) && !schema['enum'].includes(null)) {
    out['enum'] = [...(schema['enum'] as unknown[]), null];
  }
  return out;
}

/**
 * The strict-compatible form of a cleaned schema: every object closed and
 * every property required, optional properties nullable. Null when the
 * schema cannot be strict (a free-form object, `oneOf`, `allOf`, an array
 * without items).
 */
export function toStrictSchema(schema: JsonSchema): JsonSchema | null {
  if ('oneOf' in schema || 'allOf' in schema) return null;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (STRICT_KEYWORDS.has(key)) out[key] = value;
  }
  const nullable = schema['nullable'] === true;
  if (Array.isArray(schema['anyOf'])) {
    const variants: JsonSchema[] = [];
    for (const v of schema['anyOf'] as unknown[]) {
      if (!isObject(v)) return null;
      const strict = toStrictSchema(v);
      if (strict === null) return null;
      variants.push(strict);
    }
    out['anyOf'] = variants;
  }
  const type = schema['type'];
  if (type === 'object') {
    const props = schema['properties'];
    if (!isObject(props) || Object.keys(props).length === 0) return null;
    const required = new Set(
      Array.isArray(schema['required']) ? (schema['required'] as string[]) : [],
    );
    const strictProps: Record<string, JsonSchema> = {};
    for (const [name, prop] of Object.entries(props)) {
      if (!isObject(prop)) return null;
      const strict = toStrictSchema(prop);
      if (strict === null) return null;
      strictProps[name] = required.has(name) ? strict : withNull(strict);
    }
    out['properties'] = strictProps;
    out['required'] = Object.keys(strictProps);
    out['additionalProperties'] = false;
  } else if (type === 'array') {
    const items = schema['items'];
    if (!isObject(items)) return null;
    const strict = toStrictSchema(items);
    if (strict === null) return null;
    out['items'] = strict;
  }
  return nullable ? withNull(out) : out;
}

/**
 * Drops the nulls a strict-mode model sends for optional fields it did not
 * mean to set. A null stays where the operation itself accepts null
 * (`nullable: true`, such as clearing a station's site).
 */
export function dropStrictNulls(value: unknown, schema: JsonSchema): unknown {
  if (Array.isArray(value)) {
    const items = schema['items'];
    return isObject(items) ? value.map((v: unknown) => dropStrictNulls(v, items)) : value;
  }
  if (!isObject(value)) return value;
  const props = isObject(schema['properties']) ? schema['properties'] : {};
  const required = new Set(
    Array.isArray(schema['required']) ? (schema['required'] as string[]) : [],
  );
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const prop = props[key];
    const propSchema = isObject(prop) ? prop : {};
    if (v === null && !required.has(key) && propSchema['nullable'] !== true) continue;
    out[key] = dropStrictNulls(v, propSchema);
  }
  return out;
}

const CONTAINER_TYPES = new Set(['object', 'array', 'boolean', 'null']);

/** Whether a property can hold a secret value: a string, a number, or an untyped value. */
function holdsScalar(schema: unknown): boolean {
  if (!isObject(schema)) return true;
  for (const key of ['anyOf', 'oneOf']) {
    const variants = schema[key];
    if (Array.isArray(variants)) return variants.some((v: unknown) => holdsScalar(v));
  }
  const type = schema['type'];
  const types = Array.isArray(type) ? (type as unknown[]) : [type];
  if (type === undefined) return !('properties' in schema) && !('items' in schema);
  return types.some((t) => typeof t !== 'string' || !CONTAINER_TYPES.has(t));
}

/**
 * Every property name in `schema`, at any depth, whose value can be a
 * string or a number (the response field list the secret gate checks).
 * Objects, arrays and booleans are walked, not listed: a secret is a scalar.
 */
export function collectFieldNames(schema: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(schema)) {
    for (const s of schema) collectFieldNames(s, out);
    return out;
  }
  if (!isObject(schema)) return out;
  const props = schema['properties'];
  if (isObject(props)) {
    for (const [name, prop] of Object.entries(props)) {
      if (holdsScalar(prop)) out.add(name);
      collectFieldNames(prop, out);
    }
  }
  for (const key of ['items', 'additionalProperties', 'anyOf', 'oneOf', 'allOf']) {
    collectFieldNames(schema[key], out);
  }
  return out;
}

/**
 * Removes properties from an object schema (omitted or pinned arguments).
 * Never mutates `schema`.
 */
export function withoutProperties(schema: JsonSchema, names: readonly string[]): JsonSchema {
  if (names.length === 0) return schema;
  const props = isObject(schema['properties']) ? schema['properties'] : {};
  const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
  return {
    ...schema,
    properties: Object.fromEntries(Object.entries(props).filter(([k]) => !names.includes(k))),
    required: required.filter((r) => !names.includes(r)),
  };
}

/** Restricts a property to a set of values (a `case.sessionIds` pin). */
export function withPropertyEnum(
  schema: JsonSchema,
  name: string,
  values: readonly string[],
): JsonSchema {
  const props = isObject(schema['properties']) ? schema['properties'] : {};
  const prop: JsonSchema = isObject(props[name]) ? { ...props[name] } : { type: 'string' };
  // The enum replaces the id pattern.
  delete prop['pattern'];
  return { ...schema, properties: { ...props, [name]: { ...prop, enum: [...values] } } };
}
