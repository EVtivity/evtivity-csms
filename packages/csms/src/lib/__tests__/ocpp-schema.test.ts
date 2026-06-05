// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { validatePayload, formValuesToPayload } from '../ocpp-schema';
import type { ResolvedField } from '../ocpp-schema';

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
