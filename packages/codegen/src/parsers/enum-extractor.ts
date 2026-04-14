// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { JsonSchemaProperty, ParsedSchema } from './schema-parser.js';

export interface EnumDefinition {
  name: string;
  typeName: string;
  values: string[];
  description?: string | undefined;
}

function deriveEnumTypeName(defName: string): string {
  return defName.endsWith('EnumType') ? defName.slice(0, -'Type'.length) : defName;
}

function deriveInlineEnumName(propName: string, schemaFileName: string): string {
  const base = propName.charAt(0).toUpperCase() + propName.slice(1);
  // Use the schema's action name as context to avoid collisions
  const action = schemaFileName
    .replace('.json', '')
    .replace(/Request$/, '')
    .replace(/Response$/, '');
  return `${action}${base}Enum`;
}

function extractInlineEnumsFromProperties(
  properties: JsonSchemaProperty[],
  schemaFileName: string,
  enums: EnumDefinition[],
  seen: Set<string>,
): void {
  for (const prop of properties) {
    if (prop.enumValues != null && prop.enumValues.length > 0) {
      const enumName = deriveInlineEnumName(prop.name, schemaFileName);
      if (!seen.has(enumName)) {
        seen.add(enumName);
        enums.push({
          name: enumName,
          typeName: enumName,
          values: prop.enumValues,
        });
      }
    }
  }
}

export function extractEnums(schema: ParsedSchema): EnumDefinition[] {
  const enums: EnumDefinition[] = [];
  const seen = new Set<string>();

  // Extract enums from definitions (OCPP 2.1 style)
  for (const def of schema.definitions.values()) {
    if (def.type === 'string' && def.enumValues != null && def.enumValues.length > 0) {
      const typeName = deriveEnumTypeName(def.name);
      if (!seen.has(typeName)) {
        seen.add(typeName);
        enums.push({
          name: def.name,
          typeName,
          values: def.enumValues,
          description: def.description,
        });
      }
    }
  }

  // Extract inline enums from root properties (OCPP 1.6 style)
  extractInlineEnumsFromProperties(schema.rootProperties, schema.fileName, enums, seen);

  // Extract inline enums from synthesized definition properties
  for (const def of schema.definitions.values()) {
    if (def.type === 'object') {
      extractInlineEnumsFromProperties(def.properties, schema.fileName, enums, seen);
    }
  }

  return enums;
}

export function collectAllEnums(schemas: ParsedSchema[]): Map<string, EnumDefinition> {
  const allEnums = new Map<string, EnumDefinition>();

  for (const schema of schemas) {
    for (const enumDef of extractEnums(schema)) {
      if (!allEnums.has(enumDef.name)) {
        allEnums.set(enumDef.name, enumDef);
      }
    }
  }

  return allEnums;
}
