// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * OCPP command schemas for the CSMS Advanced Command form. Browser-safe, so
 * the CSMS imports it via `@evtivity/lib/ocpp-command-schema`.
 *
 * `schemaToCommandDef` turns an OCPP 2.1 `<Action>Request.json` or OCPP 1.6
 * `<Action>.json` schema into form fields. OCPP 2.1 schemas reference
 * `definitions`; OCPP 1.6 schemas nest objects and array items inline. Both
 * resolve to the same field shape. `buildCommandStub` builds the minimal
 * payload: every required field, at the smallest value the schema accepts.
 */

export type OcppCommandVersion = 'ocpp1.6' | 'ocpp2.1';

export type CommandFieldType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'object'
  | 'array'
  | 'datetime';

export interface CommandFieldDef {
  name: string;
  type: CommandFieldType;
  required: boolean;
  values?: string[];
  default?: unknown;
  description: string;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  maxLength?: number;
  /** String format other than date-time (`uri`). */
  format?: string;
  minItems?: number;
  maxItems?: number;
  /** Object properties, or the properties of an array's object items. */
  fields?: CommandFieldDef[] | undefined;
  /** The item of an array of strings, numbers, booleans or enum values. */
  item?: CommandFieldDef | undefined;
}

export interface CommandDef {
  action: string;
  version: OcppCommandVersion;
  fields: CommandFieldDef[];
  example: Record<string, unknown>;
}

interface SchemaNode {
  $ref?: string;
  type?: string;
  format?: string;
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  required?: string[];
}

export interface OcppRequestSchema {
  properties?: Record<string, SchemaNode>;
  required?: string[];
  definitions?: Record<string, SchemaNode>;
}

/** The schema file of an action's request, relative to the repo `schemas/` folder. */
export function ocppRequestSchemaPath(version: OcppCommandVersion, action: string): string {
  return version === 'ocpp1.6' ? `ocpp-1.6/${action}.json` : `ocpp-2.1/${action}Request.json`;
}

function cleanDescription(desc: string | undefined): string {
  if (desc == null) return '';
  return desc.replace(/\r\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function numericConstraints(node: SchemaNode): Partial<CommandFieldDef> {
  return {
    ...(node.minimum != null && { minimum: node.minimum }),
    ...(node.maximum != null && { maximum: node.maximum }),
    ...(node.multipleOf != null && { multipleOf: node.multipleOf }),
  };
}

function resolveNode(
  name: string,
  prop: SchemaNode,
  required: boolean,
  definitions: Record<string, SchemaNode>,
  refChain: readonly string[],
): CommandFieldDef {
  let node = prop;
  let chain = refChain;
  if (prop.$ref != null) {
    const defName = prop.$ref.replace('#/definitions/', '');
    const def = definitions[defName];
    // An unknown or recursive reference has no fields to offer: a plain string.
    if (def == null || refChain.includes(defName)) {
      return { name, type: 'string', required, description: '' };
    }
    node = def;
    chain = [...refChain, defName];
  }
  const description = cleanDescription(prop.description ?? node.description);

  if (node.enum != null) {
    return {
      name,
      type: 'enum',
      required,
      values: node.enum,
      default: node.enum[0],
      description,
    };
  }

  if (node.type === 'object' || node.properties != null) {
    return {
      name,
      type: 'object',
      required,
      description,
      fields: resolveProperties(node.properties ?? {}, node.required ?? [], definitions, chain),
    };
  }

  if (node.type === 'array') {
    const field: CommandFieldDef = {
      name,
      type: 'array',
      required,
      description,
      ...(node.minItems != null && { minItems: node.minItems }),
      ...(node.maxItems != null && { maxItems: node.maxItems }),
    };
    if (node.items != null) {
      const item = resolveNode(name, node.items, true, definitions, chain);
      if (item.type === 'object') field.fields = item.fields;
      else field.item = item;
    }
    return field;
  }

  if (node.type === 'string' && node.format === 'date-time') {
    return { name, type: 'datetime', required, description };
  }

  if (node.type === 'integer' || node.type === 'number') {
    return { name, type: node.type, required, description, ...numericConstraints(node) };
  }

  if (node.type === 'boolean') {
    return { name, type: 'boolean', required, description };
  }

  return {
    name,
    type: 'string',
    required,
    description,
    ...(node.maxLength != null && { maxLength: node.maxLength }),
    ...(node.format != null && { format: node.format }),
  };
}

function resolveProperties(
  properties: Record<string, SchemaNode>,
  required: string[],
  definitions: Record<string, SchemaNode>,
  refChain: readonly string[],
): CommandFieldDef[] {
  const fields: CommandFieldDef[] = [];
  for (const [name, prop] of Object.entries(properties)) {
    // OCPP 2.1 vendor extension: never part of the form.
    if (name === 'customData') continue;
    fields.push(resolveNode(name, prop, required.includes(name), definitions, refChain));
  }
  return fields;
}

/** The smallest value of a field the schema accepts (strings stay empty for the operator). */
export function stubFieldValue(field: CommandFieldDef, now: Date = new Date()): unknown {
  switch (field.type) {
    case 'enum':
      return field.values?.[0] ?? '';
    case 'integer':
    case 'number': {
      let value = 0;
      if (field.minimum != null && value < field.minimum) value = field.minimum;
      if (field.maximum != null && value > field.maximum) value = field.maximum;
      return value;
    }
    case 'boolean':
      return false;
    case 'datetime':
      // Whole seconds, so the value survives the form's datetime-local input.
      return new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString();
    case 'array': {
      // A required array starts with one item: the form treats an empty one as missing.
      const count = Math.max(field.minItems ?? 0, field.required ? 1 : 0);
      const items: unknown[] = [];
      for (let i = 0; i < count; i++) {
        if (field.fields != null) items.push(buildCommandStub(field.fields, now));
        else if (field.item != null) items.push(stubFieldValue(field.item, now));
      }
      return items;
    }
    case 'object':
      return buildCommandStub(field.fields ?? [], now);
    default:
      return '';
  }
}

/** The minimal payload: every required field at its stub value. */
export function buildCommandStub(
  fields: CommandFieldDef[],
  now: Date = new Date(),
): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.required) stub[field.name] = stubFieldValue(field, now);
  }
  return stub;
}

export function schemaToCommandDef(
  action: string,
  version: OcppCommandVersion,
  schema: OcppRequestSchema,
  now: Date = new Date(),
): CommandDef {
  const fields = resolveProperties(
    schema.properties ?? {},
    schema.required ?? [],
    schema.definitions ?? {},
    [],
  );
  return { action, version, fields, example: buildCommandStub(fields, now) };
}
