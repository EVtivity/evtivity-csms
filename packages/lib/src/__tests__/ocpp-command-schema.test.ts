// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  buildCommandStub,
  ocppRequestSchemaPath,
  schemaToCommandDef,
} from '../ocpp-command-schema.js';

const now = new Date('2026-01-02T03:04:05.678Z');

describe('ocppRequestSchemaPath', () => {
  it('names the request schema file of each version', () => {
    expect(ocppRequestSchemaPath('ocpp2.1', 'Reset')).toBe('ocpp-2.1/ResetRequest.json');
    expect(ocppRequestSchemaPath('ocpp1.6', 'Reset')).toBe('ocpp-1.6/Reset.json');
  });
});

describe('schemaToCommandDef', () => {
  it('resolves OCPP 1.6 inline objects and array items like referenced ones', () => {
    const def = schemaToCommandDef(
      'SetChargingProfile',
      'ocpp1.6',
      {
        properties: {
          profile: {
            type: 'object',
            properties: {
              periods: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { limit: { type: 'number', multipleOf: 0.1 } },
                  required: ['limit'],
                },
              },
            },
            required: ['periods'],
          },
          location: { type: 'string', format: 'uri' },
        },
        required: ['profile'],
      },
      now,
    );

    expect(def.fields[0]).toMatchObject({
      name: 'profile',
      type: 'object',
      fields: [
        {
          name: 'periods',
          type: 'array',
          required: true,
          fields: [{ name: 'limit', type: 'number', required: true, multipleOf: 0.1 }],
        },
      ],
    });
    expect(def.fields[1]).toMatchObject({ name: 'location', type: 'string', format: 'uri' });
    expect(def.example).toEqual({ profile: { periods: [{ limit: 0 }] } });
  });

  it('keeps the item of an array of primitives, with its constraints', () => {
    const def = schemaToCommandDef(
      'GetDisplayMessages',
      'ocpp2.1',
      {
        definitions: { PriorityType: { type: 'string', enum: ['High', 'Low'] } },
        properties: {
          id: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'integer', minimum: 5 } },
          priority: { type: 'array', items: { $ref: '#/definitions/PriorityType' } },
        },
        required: ['id'],
      },
      now,
    );

    expect(def.fields[0]).toMatchObject({
      type: 'array',
      minItems: 2,
      maxItems: 4,
      item: { type: 'integer', minimum: 5, required: true },
    });
    expect(def.fields[1]?.item).toMatchObject({ type: 'enum', values: ['High', 'Low'] });
    expect(def.example).toEqual({ id: [5, 5] });
  });

  it('stops at a recursive reference', () => {
    const def = schemaToCommandDef(
      'Loop',
      'ocpp2.1',
      {
        definitions: {
          NodeType: { type: 'object', properties: { next: { $ref: '#/definitions/NodeType' } } },
        },
        properties: { node: { $ref: '#/definitions/NodeType' } },
      },
      now,
    );

    expect(def.fields[0]?.fields).toEqual([
      { name: 'next', type: 'string', required: false, description: '' },
    ]);
  });
});

describe('buildCommandStub', () => {
  it('uses whole-second dates and clamps numbers into their range', () => {
    expect(
      buildCommandStub(
        [
          { name: 'at', type: 'datetime', required: true, description: '' },
          { name: 'low', type: 'integer', required: true, description: '', minimum: 3 },
          { name: 'high', type: 'number', required: true, description: '', maximum: -1 },
          { name: 'note', type: 'string', required: false, description: '' },
        ],
        now,
      ),
    ).toEqual({ at: '2026-01-02T03:04:05.000Z', low: 3, high: -1 });
  });
});
