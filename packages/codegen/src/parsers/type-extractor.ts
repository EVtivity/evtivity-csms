// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { JsonSchemaDefinition, ParsedSchema } from './schema-parser.js';

export interface TypeClassification {
  commonTypes: Map<string, JsonSchemaDefinition>;
  localTypes: Map<string, Map<string, JsonSchemaDefinition>>;
}

function canonicalize(def: JsonSchemaDefinition): string {
  const stripped = {
    type: def.type,
    additionalProperties: def.additionalProperties,
    properties: def.properties.map((p) => ({
      name: p.name,
      type: p.type,
      $ref: p.$ref,
      format: p.format,
      maxLength: p.maxLength,
      minimum: p.minimum,
      maximum: p.maximum,
      isArray: p.isArray,
      arrayItems: p.arrayItems,
      minItems: p.minItems,
      maxItems: p.maxItems,
    })),
    required: [...def.required].sort(),
    enumValues: def.enumValues != null ? [...def.enumValues].sort() : undefined,
  };
  return JSON.stringify(stripped);
}

export function classifyTypes(schemas: ParsedSchema[]): TypeClassification {
  const definitionOccurrences = new Map<
    string,
    { canonical: string; def: JsonSchemaDefinition; files: string[] }[]
  >();

  for (const schema of schemas) {
    for (const def of schema.definitions.values()) {
      if (def.type === 'string' && def.enumValues != null) {
        continue;
      }

      const canonical = canonicalize(def);
      let variants = definitionOccurrences.get(def.name);
      if (variants == null) {
        variants = [];
        definitionOccurrences.set(def.name, variants);
      }

      const existing = variants.find((v) => v.canonical === canonical);
      if (existing != null) {
        existing.files.push(schema.fileName);
      } else {
        variants.push({ canonical, def, files: [schema.fileName] });
      }
    }
  }

  const commonTypes = new Map<string, JsonSchemaDefinition>();
  const localTypes = new Map<string, Map<string, JsonSchemaDefinition>>();

  for (const [defName, variants] of definitionOccurrences.entries()) {
    if (variants.length === 1 && variants[0] != null) {
      const variant = variants[0];
      const totalFiles = variant.files.length;

      if (totalFiles >= 2) {
        commonTypes.set(defName, variant.def);
      } else {
        const fileName = variant.files[0];
        if (fileName == null) continue;
        let fileMap = localTypes.get(fileName);
        if (fileMap == null) {
          fileMap = new Map();
          localTypes.set(fileName, fileMap);
        }
        fileMap.set(defName, variant.def);
      }
    } else {
      const allFiles = variants.flatMap((v) => v.files);
      const totalFiles = new Set(allFiles).size;

      if (totalFiles >= 2 && variants.length === 1 && variants[0] != null) {
        commonTypes.set(defName, variants[0].def);
      } else {
        for (const variant of variants) {
          for (const fileName of variant.files) {
            let fileMap = localTypes.get(fileName);
            if (fileMap == null) {
              fileMap = new Map();
              localTypes.set(fileName, fileMap);
            }
            fileMap.set(defName, variant.def);
          }
        }
      }
    }
  }

  return { commonTypes, localTypes };
}
