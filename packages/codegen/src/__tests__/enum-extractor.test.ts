// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { extractEnums, collectAllEnums } from '../parsers/enum-extractor.js';
import type { ParsedSchema, JsonSchemaDefinition } from '../parsers/schema-parser.js';

function makeDef(name: string, type: string, enumValues?: string[]): JsonSchemaDefinition {
  return {
    name,
    type,
    properties: [],
    required: [],
    enumValues,
  };
}

function fakeSchema(fileName: string, defs: JsonSchemaDefinition[]): ParsedSchema {
  const definitions = new Map<string, JsonSchemaDefinition>();
  for (const d of defs) {
    definitions.set(d.name, d);
  }
  return {
    fileName,
    schemaId: `urn:ocpp:2.1:${fileName}`,
    definitions,
    rootProperties: [],
    rootRequired: [],
    rawSchema: {},
  };
}

describe('extractEnums', () => {
  it('extracts string enums from definitions', () => {
    const schema = fakeSchema('TestRequest.json', [
      makeDef('StatusEnumType', 'string', ['Accepted', 'Rejected']),
      makeDef('DataType', 'object'),
    ]);

    const enums = extractEnums(schema);
    expect(enums).toHaveLength(1);
    expect(enums[0]?.name).toBe('StatusEnumType');
    expect(enums[0]?.typeName).toBe('StatusEnum');
    expect(enums[0]?.values).toEqual(['Accepted', 'Rejected']);
  });

  it('strips Type suffix for typeName', () => {
    const schema = fakeSchema('Test.json', [
      makeDef('ResetEnumType', 'string', ['Immediate', 'OnIdle']),
    ]);

    const enums = extractEnums(schema);
    expect(enums[0]?.typeName).toBe('ResetEnum');
  });

  it('keeps name without Type suffix unchanged', () => {
    const schema = fakeSchema('Test.json', [
      makeDef('StatusEnum', 'string', ['Active', 'Inactive']),
    ]);

    const enums = extractEnums(schema);
    expect(enums[0]?.typeName).toBe('StatusEnum');
  });

  it('returns empty for schemas with no enums', () => {
    const schema = fakeSchema('Test.json', [makeDef('DataType', 'object')]);

    expect(extractEnums(schema)).toHaveLength(0);
  });

  it('skips string definitions without enumValues', () => {
    const schema = fakeSchema('Test.json', [makeDef('PlainString', 'string')]);

    expect(extractEnums(schema)).toHaveLength(0);
  });

  it('skips string definitions with empty enumValues array', () => {
    const schema = fakeSchema('Test.json', [makeDef('EmptyEnum', 'string', [])]);

    expect(extractEnums(schema)).toHaveLength(0);
  });

  it('deduplicates enums with same typeName in same schema', () => {
    const defs = [makeDef('StatusEnumType', 'string', ['Accepted', 'Rejected'])];
    // Create a schema where the same enum appears twice
    const schema = fakeSchema('Test.json', defs);
    // Add another definition with the same derived typeName
    schema.definitions.set('StatusEnumType2', {
      name: 'StatusEnumType',
      type: 'string',
      properties: [],
      required: [],
      enumValues: ['Accepted', 'Rejected', 'Pending'],
    });

    const enums = extractEnums(schema);
    // Should only have one since typeName is the same
    expect(enums).toHaveLength(1);
    expect(enums[0]?.values).toEqual(['Accepted', 'Rejected']);
  });

  it('extracts inline enums from root properties', () => {
    const schema: ParsedSchema = {
      fileName: 'ResetRequest.json',
      schemaId: 'urn:ocpp:2.1:ResetRequest.json',
      definitions: new Map(),
      rootProperties: [
        {
          name: 'type',
          type: 'string',
          isArray: false,
          enumValues: ['Immediate', 'OnIdle'],
        },
      ],
      rootRequired: ['type'],
      rawSchema: {},
    };

    const enums = extractEnums(schema);
    expect(enums).toHaveLength(1);
    expect(enums[0]?.typeName).toBe('ResetTypeEnum');
    expect(enums[0]?.values).toEqual(['Immediate', 'OnIdle']);
  });

  it('extracts inline enums from object definition properties', () => {
    const def: JsonSchemaDefinition = {
      name: 'ChargingStationType',
      type: 'object',
      properties: [
        {
          name: 'status',
          type: 'string',
          isArray: false,
          enumValues: ['Available', 'Faulted'],
        },
      ],
      required: [],
    };

    const schema = fakeSchema('StatusRequest.json', [def]);
    const enums = extractEnums(schema);
    expect(enums).toHaveLength(1);
    expect(enums[0]?.typeName).toBe('StatusStatusEnum');
  });

  it('preserves description from definition enums', () => {
    const schema = fakeSchema('Test.json', []);
    schema.definitions.set('StatusEnumType', {
      name: 'StatusEnumType',
      type: 'string',
      properties: [],
      required: [],
      enumValues: ['Accepted', 'Rejected'],
      description: 'Status of the operation',
    });

    const enums = extractEnums(schema);
    expect(enums).toHaveLength(1);
    expect(enums[0]?.description).toBe('Status of the operation');
  });
});

describe('collectAllEnums', () => {
  it('deduplicates enums across schemas', () => {
    const schemas = [
      fakeSchema('A.json', [makeDef('StatusEnumType', 'string', ['Accepted', 'Rejected'])]),
      fakeSchema('B.json', [makeDef('StatusEnumType', 'string', ['Accepted', 'Rejected'])]),
    ];

    const allEnums = collectAllEnums(schemas);
    expect(allEnums.size).toBe(1);
  });

  it('collects unique enums from multiple schemas', () => {
    const schemas = [
      fakeSchema('A.json', [makeDef('StatusEnumType', 'string', ['Accepted', 'Rejected'])]),
      fakeSchema('B.json', [makeDef('ResetEnumType', 'string', ['Immediate', 'OnIdle'])]),
    ];

    const allEnums = collectAllEnums(schemas);
    expect(allEnums.size).toBe(2);
  });

  it('returns empty map for empty schemas array', () => {
    const allEnums = collectAllEnums([]);
    expect(allEnums.size).toBe(0);
  });

  it('keeps first enum when names collide across schemas', () => {
    const schemas = [
      fakeSchema('A.json', [makeDef('StatusEnumType', 'string', ['Accepted', 'Rejected'])]),
      fakeSchema('B.json', [makeDef('StatusEnumType', 'string', ['Active', 'Inactive'])]),
    ];

    const allEnums = collectAllEnums(schemas);
    expect(allEnums.size).toBe(1);
    // First one should win
    expect(allEnums.get('StatusEnumType')?.values).toEqual(['Accepted', 'Rejected']);
  });
});
