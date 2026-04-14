// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import fs from 'node:fs';
import path from 'node:path';

export interface JsonSchemaProperty {
  name: string;
  type?: string | undefined;
  $ref?: string | undefined;
  format?: string | undefined;
  maxLength?: number | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  default?: unknown;
  description?: string | undefined;
  isArray: boolean;
  arrayItems?: { $ref?: string | undefined; type?: string | undefined } | undefined;
  minItems?: number | undefined;
  maxItems?: number | undefined;
  enumValues?: string[] | undefined;
}

export interface JsonSchemaDefinition {
  name: string;
  description?: string | undefined;
  javaType?: string | undefined;
  type: string;
  additionalProperties?: boolean | undefined;
  properties: JsonSchemaProperty[];
  required: string[];
  enumValues?: string[] | undefined;
}

export interface ParsedSchema {
  fileName: string;
  schemaId: string;
  definitions: Map<string, JsonSchemaDefinition>;
  rootProperties: JsonSchemaProperty[];
  rootRequired: string[];
  rawSchema: Record<string, unknown>;
}

function parseProperty(
  name: string,
  raw: Record<string, unknown>,
  syntheticDefs?: Map<string, JsonSchemaDefinition>,
  contextName?: string,
): JsonSchemaProperty {
  if (raw['type'] === 'array') {
    const items = raw['items'] as Record<string, unknown> | undefined;

    // Handle inline object items (e.g. MeterValues.meterValue[].type=object)
    if (
      items != null &&
      items['type'] === 'object' &&
      items['properties'] != null &&
      syntheticDefs != null
    ) {
      const syntheticName = deriveSyntheticTypeName(name, contextName);
      const syntheticDef = parseDefinition(syntheticName, items, syntheticDefs, syntheticName);
      syntheticDefs.set(syntheticName, syntheticDef);
      return {
        name,
        type: 'array',
        isArray: true,
        arrayItems: { $ref: syntheticName },
        minItems: typeof raw['minItems'] === 'number' ? raw['minItems'] : undefined,
        maxItems: typeof raw['maxItems'] === 'number' ? raw['maxItems'] : undefined,
        description: typeof raw['description'] === 'string' ? raw['description'] : undefined,
      };
    }

    return {
      name,
      type: 'array',
      isArray: true,
      arrayItems: items
        ? {
            $ref: typeof items['$ref'] === 'string' ? extractRefName(items['$ref']) : undefined,
            type: typeof items['type'] === 'string' ? items['type'] : undefined,
          }
        : undefined,
      minItems: typeof raw['minItems'] === 'number' ? raw['minItems'] : undefined,
      maxItems: typeof raw['maxItems'] === 'number' ? raw['maxItems'] : undefined,
      description: typeof raw['description'] === 'string' ? raw['description'] : undefined,
    };
  }

  if (typeof raw['$ref'] === 'string') {
    return {
      name,
      $ref: extractRefName(raw['$ref']),
      isArray: false,
      description: typeof raw['description'] === 'string' ? raw['description'] : undefined,
    };
  }

  // Handle inline object properties (e.g. idTagInfo with type=object and properties)
  if (raw['type'] === 'object' && raw['properties'] != null && syntheticDefs != null) {
    const syntheticName = deriveSyntheticTypeName(name, contextName);
    const syntheticDef = parseDefinition(syntheticName, raw, syntheticDefs, syntheticName);
    syntheticDefs.set(syntheticName, syntheticDef);
    return {
      name,
      $ref: syntheticName,
      isArray: false,
      description: typeof raw['description'] === 'string' ? raw['description'] : undefined,
    };
  }

  return {
    name,
    type: typeof raw['type'] === 'string' ? raw['type'] : 'string',
    isArray: false,
    format: typeof raw['format'] === 'string' ? raw['format'] : undefined,
    maxLength: typeof raw['maxLength'] === 'number' ? raw['maxLength'] : undefined,
    minimum: typeof raw['minimum'] === 'number' ? raw['minimum'] : undefined,
    maximum: typeof raw['maximum'] === 'number' ? raw['maximum'] : undefined,
    default: raw['default'],
    description: typeof raw['description'] === 'string' ? raw['description'] : undefined,
    enumValues: Array.isArray(raw['enum']) ? (raw['enum'] as string[]) : undefined,
  };
}

function extractRefName(ref: string): string {
  const parts = ref.split('/');
  return parts[parts.length - 1] ?? ref;
}

function deriveSyntheticTypeName(propName: string, contextName?: string): string {
  const base = propName.charAt(0).toUpperCase() + propName.slice(1);
  // If base already ends with "Type", keep it; otherwise append "Type"
  const typeName = base.endsWith('Type') ? base : `${base}Type`;
  // Avoid collisions by prefixing with context when nested
  if (contextName != null && !typeName.startsWith(contextName.replace('Type', ''))) {
    return typeName;
  }
  return typeName;
}

function parseDefinition(
  name: string,
  raw: Record<string, unknown>,
  syntheticDefs?: Map<string, JsonSchemaDefinition>,
  contextName?: string,
): JsonSchemaDefinition {
  const def: JsonSchemaDefinition = {
    name,
    description: typeof raw['description'] === 'string' ? raw['description'] : undefined,
    javaType: typeof raw['javaType'] === 'string' ? raw['javaType'] : undefined,
    type: typeof raw['type'] === 'string' ? raw['type'] : 'object',
    additionalProperties:
      typeof raw['additionalProperties'] === 'boolean' ? raw['additionalProperties'] : undefined,
    properties: [],
    required: Array.isArray(raw['required']) ? (raw['required'] as string[]) : [],
  };

  if (Array.isArray(raw['enum'])) {
    def.enumValues = raw['enum'] as string[];
  }

  if (raw['properties'] != null && typeof raw['properties'] === 'object') {
    const props = raw['properties'] as Record<string, Record<string, unknown>>;
    for (const [propName, propSchema] of Object.entries(props)) {
      def.properties.push(parseProperty(propName, propSchema, syntheticDefs, contextName));
    }
  }

  return def;
}

export function parseSchemaFile(filePath: string): ParsedSchema {
  const content = fs.readFileSync(filePath, 'utf-8');
  const raw = JSON.parse(content) as Record<string, unknown>;
  const fileName = path.basename(filePath);

  const definitions = new Map<string, JsonSchemaDefinition>();

  // Parse explicit definitions section (OCPP 2.1 style)
  if (raw['definitions'] != null && typeof raw['definitions'] === 'object') {
    const defs = raw['definitions'] as Record<string, Record<string, unknown>>;
    for (const [defName, defSchema] of Object.entries(defs)) {
      definitions.set(defName, parseDefinition(defName, defSchema, definitions, defName));
    }
  }

  // Parse root properties, synthesizing definitions for inline objects
  const rootProperties: JsonSchemaProperty[] = [];
  if (raw['properties'] != null && typeof raw['properties'] === 'object') {
    const props = raw['properties'] as Record<string, Record<string, unknown>>;
    for (const [propName, propSchema] of Object.entries(props)) {
      rootProperties.push(parseProperty(propName, propSchema, definitions));
    }
  }

  return {
    fileName,
    schemaId:
      typeof raw['$id'] === 'string' ? raw['$id'] : typeof raw['id'] === 'string' ? raw['id'] : '',
    definitions,
    rootProperties,
    rootRequired: Array.isArray(raw['required']) ? (raw['required'] as string[]) : [],
    rawSchema: raw,
  };
}

export function parseAllSchemas(schemasDir: string): ParsedSchema[] {
  const files = fs.readdirSync(schemasDir).filter((f: string) => f.endsWith('.json'));
  files.sort();
  return files.map((f: string) => parseSchemaFile(path.join(schemasDir, f)));
}
