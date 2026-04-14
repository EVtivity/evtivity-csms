// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type {
  JsonSchemaDefinition,
  JsonSchemaProperty,
  ParsedSchema,
} from '../parsers/schema-parser.js';
import type { TypeClassification } from '../parsers/type-extractor.js';
import type { EnumDefinition } from '../parsers/enum-extractor.js';

function mapPrimitiveType(prop: JsonSchemaProperty): string {
  if (prop.format === 'date-time') return 'string';

  switch (prop.type) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'unknown';
  }
}

function resolvePropertyType(
  prop: JsonSchemaProperty,
  allEnums: Map<string, EnumDefinition>,
  schemaFileName?: string,
): string {
  if (prop.isArray) {
    if (prop.arrayItems?.$ref != null) {
      const refName = prop.arrayItems.$ref;
      const enumDef = allEnums.get(refName);
      if (enumDef != null) return `${enumDef.typeName}[]`;
      return `${refName}[]`;
    }
    if (prop.arrayItems?.type != null) {
      return `${mapPrimitiveType({ ...prop, type: prop.arrayItems.type, isArray: false, name: '' })}[]`;
    }
    return 'unknown[]';
  }

  if (prop.$ref != null) {
    const enumDef = allEnums.get(prop.$ref);
    if (enumDef != null) return enumDef.typeName;
    return prop.$ref;
  }

  // Handle inline enum on property
  if (prop.enumValues != null && prop.enumValues.length > 0 && schemaFileName != null) {
    const action = schemaFileName
      .replace('.json', '')
      .replace(/Request$/, '')
      .replace(/Response$/, '');
    const base = prop.name.charAt(0).toUpperCase() + prop.name.slice(1);
    const enumName = `${action}${base}Enum`;
    const enumDef = allEnums.get(enumName);
    if (enumDef != null) return enumDef.typeName;
  }

  return mapPrimitiveType(prop);
}

function generateInterface(
  name: string,
  def: JsonSchemaDefinition,
  allEnums: Map<string, EnumDefinition>,
  schemaFileName?: string,
): string {
  const lines: string[] = [];
  lines.push(`export interface ${name} {`);

  for (const prop of def.properties) {
    const isRequired = def.required.includes(prop.name);
    const tsType = resolvePropertyType(prop, allEnums, schemaFileName);
    const optional = isRequired ? '' : '?';
    lines.push(`  ${prop.name}${optional}: ${tsType};`);
  }

  lines.push('}');
  return lines.join('\n');
}

function collectImports(
  props: JsonSchemaProperty[],
  commonTypes: Map<string, JsonSchemaDefinition>,
  allEnums: Map<string, EnumDefinition>,
  localDefNames: Set<string>,
  schemaFileName?: string,
): { commonTypeImports: string[]; enumImports: string[] } {
  const commonTypeImports = new Set<string>();
  const enumImports = new Set<string>();

  function checkRef(refName: string | undefined): void {
    if (refName == null) return;

    const enumDef = allEnums.get(refName);
    if (enumDef != null) {
      enumImports.add(enumDef.typeName);
      return;
    }

    if (commonTypes.has(refName) && !localDefNames.has(refName)) {
      commonTypeImports.add(refName);
    }
  }

  for (const prop of props) {
    checkRef(prop.$ref);
    if (prop.isArray && prop.arrayItems?.$ref != null) {
      checkRef(prop.arrayItems.$ref);
    }
    // Handle inline enum imports
    if (prop.enumValues != null && prop.enumValues.length > 0 && schemaFileName != null) {
      const action = schemaFileName
        .replace('.json', '')
        .replace(/Request$/, '')
        .replace(/Response$/, '');
      const base = prop.name.charAt(0).toUpperCase() + prop.name.slice(1);
      const enumName = `${action}${base}Enum`;
      const enumDef = allEnums.get(enumName);
      if (enumDef != null) {
        enumImports.add(enumDef.typeName);
      }
    }
  }

  return {
    commonTypeImports: [...commonTypeImports].sort(),
    enumImports: [...enumImports].sort(),
  };
}

export function generateMessageTypeFile(
  schema: ParsedSchema,
  classification: TypeClassification,
  allEnums: Map<string, EnumDefinition>,
): string {
  const messageName = schema.fileName.replace('.json', '');
  const localDefs =
    classification.localTypes.get(schema.fileName) ?? new Map<string, JsonSchemaDefinition>();
  const localDefNames = new Set(localDefs.keys());

  const allProps = [
    ...schema.rootProperties,
    ...[...localDefs.values()].flatMap((d) => d.properties),
  ];
  const { commonTypeImports, enumImports } = collectImports(
    allProps,
    classification.commonTypes,
    allEnums,
    localDefNames,
    schema.fileName,
  );

  const lines: string[] = [];

  if (commonTypeImports.length > 0) {
    for (const imp of commonTypeImports) {
      lines.push(`import type { ${imp} } from '../common/${imp}.js';`);
    }
    lines.push('');
  }

  if (enumImports.length > 0) {
    for (const imp of enumImports) {
      lines.push(`import type { ${imp} } from '../../enums/${imp}.js';`);
    }
    lines.push('');
  }

  for (const def of localDefs.values()) {
    lines.push(generateInterface(def.name, def, allEnums, schema.fileName));
    lines.push('');
  }

  const rootDef: JsonSchemaDefinition = {
    name: messageName,
    type: 'object',
    properties: schema.rootProperties,
    required: schema.rootRequired,
  };
  lines.push(generateInterface(messageName, rootDef, allEnums, schema.fileName));

  return lines.join('\n') + '\n';
}

export function generateCommonTypeFile(
  def: JsonSchemaDefinition,
  commonTypes: Map<string, JsonSchemaDefinition>,
  allEnums: Map<string, EnumDefinition>,
): string {
  const { commonTypeImports, enumImports } = collectImports(
    def.properties,
    commonTypes,
    allEnums,
    new Set([def.name]),
  );

  const lines: string[] = [];

  for (const imp of commonTypeImports) {
    lines.push(`import type { ${imp} } from './${imp}.js';`);
  }
  if (commonTypeImports.length > 0) lines.push('');

  for (const imp of enumImports) {
    lines.push(`import type { ${imp} } from '../../enums/${imp}.js';`);
  }
  if (enumImports.length > 0) lines.push('');

  lines.push(generateInterface(def.name, def, allEnums));

  return lines.join('\n') + '\n';
}
