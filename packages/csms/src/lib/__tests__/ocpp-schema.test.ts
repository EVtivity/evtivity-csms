// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  validatePayload,
  formValuesToPayload,
  resolveFields,
  generateJsonStub,
} from '../ocpp-schema';
import type { ResolvedField, CommandSchema } from '../ocpp-schema';

const reservationFields: ResolvedField[] = [
  {
    name: 'reservationId',
    kind: 'integer',
    required: true,
    minimum: 0,
  },
];

describe('validatePayload', () => {
  it('flags a missing required field', () => {
    const errors = validatePayload({}, reservationFields);
    expect(errors['reservationId']).toEqual({ key: 'validation.required' });
  });

  it('passes a valid payload', () => {
    expect(validatePayload({ reservationId: 42 }, reservationFields)).toEqual({});
  });

  it('flags a non-integer value', () => {
    const errors = validatePayload({ reservationId: 1.5 }, reservationFields);
    expect(errors['reservationId']).toEqual({ key: 'validation.invalidNumber' });
  });

  it('flags a NaN value', () => {
    const errors = validatePayload({ reservationId: NaN }, reservationFields);
    expect(errors['reservationId']).toEqual({ key: 'validation.invalidNumber' });
  });

  it('enforces minimum', () => {
    const errors = validatePayload({ reservationId: -1 }, reservationFields);
    expect(errors['reservationId']).toEqual({ key: 'validation.min', params: { min: 0 } });
  });

  it('enforces maximum', () => {
    const fields: ResolvedField[] = [
      { name: 'percent', kind: 'integer', required: true, maximum: 100 },
    ];
    const errors = validatePayload({ percent: 101 }, fields);
    expect(errors['percent']).toEqual({ key: 'validation.max', params: { max: 100 } });
  });

  it('enforces string maxLength', () => {
    const fields: ResolvedField[] = [
      { name: 'message', kind: 'string', required: true, maxLength: 5 },
    ];
    const errors = validatePayload({ message: 'too long' }, fields);
    expect(errors['message']).toEqual({ key: 'validation.maxLength', params: { max: 5 } });
  });

  it('flags an enum value outside the allowed set', () => {
    const fields: ResolvedField[] = [
      { name: 'type', kind: 'enum', required: true, enumValues: ['Hard', 'Soft'] },
    ];
    expect(validatePayload({ type: 'Medium' }, fields)['type']).toEqual({
      key: 'validation.invalidValue',
    });
    expect(validatePayload({ type: 'Hard' }, fields)).toEqual({});
  });

  it('flags an invalid datetime', () => {
    const fields: ResolvedField[] = [{ name: 'startTime', kind: 'datetime', required: true }];
    expect(validatePayload({ startTime: 'not-a-date' }, fields)['startTime']).toEqual({
      key: 'validation.invalidValue',
    });
    expect(validatePayload({ startTime: '2026-06-04T10:00:00Z' }, fields)).toEqual({});
  });

  it('skips optional missing fields', () => {
    const fields: ResolvedField[] = [{ name: 'retries', kind: 'integer', required: false }];
    expect(validatePayload({}, fields)).toEqual({});
  });

  it('validates nested object fields with dotted paths', () => {
    const fields: ResolvedField[] = [
      {
        name: 'idToken',
        kind: 'object',
        required: true,
        objectFields: [
          { name: 'idToken', kind: 'string', required: true, maxLength: 255 },
          { name: 'type', kind: 'enum', required: true, enumValues: ['ISO14443', 'Central'] },
        ],
      },
    ];
    const errors = validatePayload({ idToken: { type: 'ISO14443' } }, fields);
    expect(errors['idToken.idToken']).toEqual({ key: 'validation.required' });
    expect(errors['idToken.type']).toBeUndefined();
  });

  it('flags a missing required object', () => {
    const fields: ResolvedField[] = [
      {
        name: 'idToken',
        kind: 'object',
        required: true,
        objectFields: [{ name: 'idToken', kind: 'string', required: true }],
      },
    ];
    expect(validatePayload({}, fields)['idToken']).toEqual({ key: 'validation.required' });
  });

  it('validates array items with indexed paths', () => {
    const fields: ResolvedField[] = [
      {
        name: 'evses',
        kind: 'array',
        required: true,
        arrayItemFields: [{ name: 'id', kind: 'integer', required: true, minimum: 1 }],
      },
    ];
    const errors = validatePayload({ evses: [{ id: 1 }, { id: 0 }, {}] }, fields);
    expect(errors['evses.1.id']).toEqual({ key: 'validation.min', params: { min: 1 } });
    expect(errors['evses.2.id']).toEqual({ key: 'validation.required' });
    expect(errors['evses.0.id']).toBeUndefined();
  });

  it('flags an empty required array', () => {
    const fields: ResolvedField[] = [
      { name: 'evses', kind: 'array', required: true, arrayItemFields: [] },
    ];
    expect(validatePayload({ evses: [] }, fields)['evses']).toEqual({
      key: 'validation.required',
    });
  });

  it('catches required fields dropped by formValuesToPayload (empty form submit)', () => {
    // The exact reported bug: empty CancelReservation form produced {} and the
    // API rejected it with 400. The validator must catch it locally.
    const payload = formValuesToPayload({ reservationId: '' }, reservationFields);
    expect(payload).toEqual({});
    const errors = validatePayload(payload, reservationFields);
    expect(errors['reservationId']).toEqual({ key: 'validation.required' });
  });
});

describe('resolveFields', () => {
  const schema: CommandSchema = {
    action: 'SetChargingProfile',
    version: 'ocpp2.1',
    example: { evseId: 1, chargingProfile: { id: 2 } },
    fields: [
      { name: 'evseId', type: 'integer', required: true, description: 'EVSE', minimum: 0 },
      { name: 'kind', type: 'enum', required: false, description: '', values: ['A', 'B'] },
      { name: 'enumNoValues', type: 'enum', required: false, description: 'x' },
      { name: 'label', type: 'string', required: false, description: 'L', maxLength: 20 },
      {
        name: 'profile',
        type: 'object',
        required: true,
        description: 'P',
        fields: [{ name: 'id', type: 'integer', required: true, description: 'id', maximum: 9 }],
      },
      { name: 'emptyObject', type: 'object', required: false, description: 'E' },
      {
        name: 'periods',
        type: 'array',
        required: false,
        description: 'Periods',
        fields: [{ name: 'limit', type: 'number', required: true, description: 'kW' }],
      },
    ],
  };

  it('maps schema fields to resolved fields', () => {
    const fields = resolveFields(schema);
    expect(fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ['evseId', 'integer', true],
      ['kind', 'enum', false],
      ['enumNoValues', 'enum', false],
      ['label', 'string', false],
      ['profile', 'object', true],
      ['emptyObject', 'object', false],
      ['periods', 'array', false],
    ]);
    expect(fields[0]?.minimum).toBe(0);
    expect(fields[0]?.description).toBe('EVSE');
    expect(fields[3]?.maxLength).toBe(20);
  });

  it('turns an empty description into undefined', () => {
    expect(resolveFields(schema)[1]?.description).toBeUndefined();
  });

  it('keeps enum values only when the schema lists them', () => {
    const fields = resolveFields(schema);
    expect(fields[1]?.enumValues).toEqual(['A', 'B']);
    expect(fields[2]?.enumValues).toBeUndefined();
  });

  it('resolves nested object and array item fields', () => {
    const fields = resolveFields(schema);
    expect(fields[4]?.objectFields).toEqual([
      expect.objectContaining({ name: 'id', kind: 'integer', required: true, maximum: 9 }),
    ]);
    expect(fields[5]?.objectFields).toBeUndefined();
    expect(fields[6]?.arrayItemFields).toEqual([
      expect.objectContaining({ name: 'limit', kind: 'number', required: true }),
    ]);
  });

  it('generateJsonStub pretty-prints the example', () => {
    expect(generateJsonStub(schema)).toBe(JSON.stringify(schema.example, null, 2));
    expect(JSON.parse(generateJsonStub(schema))).toEqual(schema.example);
  });
});

describe('validatePayload type checks', () => {
  const fields: ResolvedField[] = [
    { name: 'flag', kind: 'boolean', required: false },
    { name: 'text', kind: 'string', required: false },
    { name: 'obj', kind: 'object', required: false },
    {
      name: 'items',
      kind: 'array',
      required: false,
      arrayItemFields: [{ name: 'id', kind: 'integer', required: true }],
    },
    { name: 'mode', kind: 'enum', required: false },
    { name: 'plain', kind: 'array', required: false },
  ];

  it('flags a non-boolean value', () => {
    expect(validatePayload({ flag: 'yes' }, fields)['flag']).toEqual({
      key: 'validation.invalidValue',
    });
    expect(validatePayload({ flag: false }, fields)).toEqual({});
  });

  it('flags a non-string value for a string field', () => {
    expect(validatePayload({ text: 5 }, fields)['text']).toEqual({
      key: 'validation.invalidValue',
    });
  });

  it('flags an array given for an object field', () => {
    expect(validatePayload({ obj: [] }, fields)['obj']).toEqual({ key: 'validation.invalidValue' });
    expect(validatePayload({ obj: {} }, fields)).toEqual({});
  });

  it('flags a non-array value for an array field', () => {
    expect(validatePayload({ items: {} }, fields)['items']).toEqual({
      key: 'validation.invalidValue',
    });
  });

  it('flags array items that are not objects', () => {
    const errors = validatePayload({ items: [{ id: 1 }, 'x', null, [1]] }, fields);
    expect(errors).toEqual({
      'items.1': { key: 'validation.invalidValue' },
      'items.2': { key: 'validation.invalidValue' },
      'items.3': { key: 'validation.invalidValue' },
    });
  });

  it('accepts any string for an enum without listed values but rejects non-strings', () => {
    expect(validatePayload({ mode: 'whatever' }, fields)).toEqual({});
    expect(validatePayload({ mode: 3 }, fields)['mode']).toEqual({
      key: 'validation.invalidValue',
    });
  });

  it('accepts an array without item fields', () => {
    expect(validatePayload({ plain: [1, 'two'] }, fields)).toEqual({});
  });
});

describe('formValuesToPayload conversions', () => {
  const fields: ResolvedField[] = [
    { name: 'count', kind: 'integer', required: false },
    { name: 'ratio', kind: 'number', required: false },
    { name: 'enabled', kind: 'boolean', required: false },
    { name: 'mustAgree', kind: 'boolean', required: true },
    { name: 'at', kind: 'datetime', required: false },
    { name: 'note', kind: 'string', required: false },
    {
      name: 'evse',
      kind: 'object',
      required: false,
      objectFields: [{ name: 'id', kind: 'integer', required: false }],
    },
    {
      name: 'reqObj',
      kind: 'object',
      required: true,
      objectFields: [{ name: 'id', kind: 'integer', required: false }],
    },
    {
      name: 'periods',
      kind: 'array',
      required: false,
      arrayItemFields: [{ name: 'limit', kind: 'number', required: false }],
    },
    { name: 'tags', kind: 'array', required: false },
  ];

  it('converts each kind from form values', () => {
    const payload = formValuesToPayload(
      {
        count: '2.6',
        ratio: '0.25',
        enabled: 'on',
        mustAgree: true,
        at: '2026-01-02T03:04:05Z',
        note: 'hi',
        evse: { id: '3' },
        reqObj: { id: '' },
        periods: [{ limit: '7.5' }, { limit: '' }],
        tags: ['a', 'b'],
      },
      fields,
    );
    expect(payload).toEqual({
      count: 3,
      ratio: 0.25,
      enabled: true,
      mustAgree: true,
      at: '2026-01-02T03:04:05.000Z',
      note: 'hi',
      evse: { id: 3 },
      reqObj: {},
      periods: [{ limit: 7.5 }],
      tags: ['a', 'b'],
    });
  });

  it('defaults a missing required boolean to false and drops empty optional values', () => {
    expect(formValuesToPayload({ count: '', note: null, enabled: undefined }, fields)).toEqual({
      mustAgree: false,
    });
  });

  it('drops an optional object with no values and an empty array', () => {
    const payload = formValuesToPayload(
      { evse: { id: '' }, periods: [{ limit: '' }], tags: [], mustAgree: false },
      fields,
    );
    expect(payload).toEqual({ mustAgree: false });
  });

  it('ignores a non-array value for an array field and a non-object for an object field', () => {
    const payload = formValuesToPayload({ tags: 'a', evse: 'x', mustAgree: true }, fields);
    expect(payload).toEqual({ mustAgree: true });
  });
});
