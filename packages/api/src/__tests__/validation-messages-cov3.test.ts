// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The API's own English text for each Zod issue, which clients map to their language.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { validationMessage } from '../lib/validation-messages.js';

type Issue = Parameters<typeof validationMessage>[0];
const msg = (issue: Record<string, unknown>): string =>
  validationMessage(issue as unknown as Issue);

/** The message the API config gives the first issue of a failed parse. */
function parsed(schema: z.ZodType, value: unknown): string {
  const result = schema.safeParse(value, { error: validationMessage });
  if (result.success) throw new Error('expected the parse to fail');
  return result.error.issues[0]?.message ?? '';
}

describe('validationMessage', () => {
  describe('invalid_type', () => {
    it.each([
      [z.string(), undefined, 'Required'],
      [z.string(), 5, 'Expected string, received number'],
      [z.number(), Number.NaN, 'Expected number, received nan'],
      [z.number().int(), 1.5, 'Expected integer, received float'],
      [z.string(), null, 'Expected string, received null'],
      [z.string(), [], 'Expected string, received array'],
      [z.string(), new Date(0), 'Expected string, received date'],
      [z.string(), new Map(), 'Expected string, received map'],
      [z.string(), new Set(), 'Expected string, received set'],
      [z.string(), {}, 'Expected string, received object'],
      [z.number(), 'x', 'Expected number, received string'],
      [z.tuple([z.string()]), 'x', 'Expected array, received string'],
      [z.record(z.string(), z.string()), 'x', 'Expected object, received string'],
      [z.date(), new Date(Number.NaN), 'Invalid date'],
    ])('%#: %o fails as %s', (schema, value, message) => {
      expect(parsed(schema, value)).toBe(message);
    });

    it('names Infinity and a promise by their type', () => {
      expect(msg({ code: 'invalid_type', expected: 'number', input: Infinity })).toBe(
        'Expected number, received infinity',
      );
      expect(msg({ code: 'invalid_type', expected: 'string', input: Promise.resolve(1) })).toBe(
        'Expected string, received promise',
      );
      expect(msg({ code: 'invalid_type', expected: 'string', input: () => 1 })).toBe(
        'Expected string, received function',
      );
    });
  });

  describe('too_small and too_big', () => {
    it.each([
      [z.array(z.string()).min(2), ['a'], 'Array must contain at least 2 element(s)'],
      [z.array(z.string()).length(2), ['a'], 'Array must contain exactly 2 element(s)'],
      [z.array(z.string()).max(1), ['a', 'b'], 'Array must contain at most 1 element(s)'],
      [z.string().min(3), 'ab', 'String must contain at least 3 character(s)'],
      [z.string().length(3), 'ab', 'String must contain exactly 3 character(s)'],
      [z.string().max(1), 'ab', 'String must contain at most 1 character(s)'],
      [z.number().min(5), 4, 'Number must be greater than or equal to 5'],
      [z.number().gt(5), 5, 'Number must be greater than 5'],
      [z.number().max(5), 6, 'Number must be less than or equal to 5'],
      [z.number().lt(5), 5, 'Number must be less than 5'],
      [z.bigint().max(5n), 6n, 'BigInt must be less than or equal to 5'],
      [z.set(z.string()).min(2), new Set(['a']), 'Array must contain at least 2 element(s)'],
    ])('%#: refuses %o', (schema, value, message) => {
      expect(parsed(schema, value)).toBe(message);
    });

    it('words the exclusive and exact bounds', () => {
      expect(
        msg({ code: 'too_small', origin: 'array', minimum: 1, inclusive: false, exact: false }),
      ).toBe('Array must contain more than 1 element(s)');
      expect(
        msg({ code: 'too_small', origin: 'string', minimum: 1, inclusive: false, exact: false }),
      ).toBe('String must contain over 1 character(s)');
      expect(msg({ code: 'too_small', origin: 'number', minimum: 3, exact: true })).toBe(
        'Number must be exactly equal to 3',
      );
      expect(
        msg({ code: 'too_big', origin: 'array', maximum: 4, inclusive: false, exact: false }),
      ).toBe('Array must contain less than 4 element(s)');
      expect(
        msg({ code: 'too_big', origin: 'string', maximum: 4, inclusive: false, exact: false }),
      ).toBe('String must contain under 4 character(s)');
      expect(msg({ code: 'too_big', origin: 'number', maximum: 4, exact: true })).toBe(
        'Number must be exactly 4',
      );
      expect(msg({ code: 'too_big', origin: 'bigint', maximum: 4n, exact: true })).toBe(
        'BigInt must be exactly 4',
      );
      expect(
        msg({ code: 'too_big', origin: 'bigint', maximum: 4n, inclusive: false, exact: false }),
      ).toBe('BigInt must be less than 4');
    });

    it('names dates by their bound and other origins as invalid input', () => {
      const day = Date.UTC(2026, 0, 1);
      expect(msg({ code: 'too_small', origin: 'date', minimum: day, inclusive: true })).toBe(
        `Date must be greater than or equal to ${new Date(day).toString()}`,
      );
      expect(msg({ code: 'too_small', origin: 'date', minimum: day, exact: true })).toBe(
        `Date must be exactly equal to ${new Date(day).toString()}`,
      );
      expect(msg({ code: 'too_small', origin: 'date', minimum: day })).toBe(
        `Date must be greater than ${new Date(day).toString()}`,
      );
      expect(msg({ code: 'too_big', origin: 'date', maximum: day, inclusive: true })).toBe(
        `Date must be smaller than or equal to ${new Date(day).toString()}`,
      );
      expect(msg({ code: 'too_big', origin: 'date', maximum: day, exact: true })).toBe(
        `Date must be exactly ${new Date(day).toString()}`,
      );
      expect(msg({ code: 'too_big', origin: 'date', maximum: day })).toBe(
        `Date must be smaller than ${new Date(day).toString()}`,
      );
      expect(msg({ code: 'too_small', origin: 'file', minimum: 1 })).toBe('Invalid input');
      expect(msg({ code: 'too_big', origin: 'file', maximum: 1 })).toBe('Invalid input');
    });
  });

  describe('invalid_format', () => {
    it.each([
      [z.email(), 'x', 'Invalid email'],
      [z.url(), 'x', 'Invalid url'],
      [z.uuid(), 'x', 'Invalid uuid'],
      [z.iso.datetime(), 'x', 'Invalid datetime'],
      [z.ipv4(), 'x', 'Invalid ip'],
      [z.cidrv4(), 'x', 'Invalid cidr'],
      [z.string().regex(/^a$/), 'b', 'Invalid'],
      [z.string().startsWith('ab'), 'x', 'Invalid input: must start with "ab"'],
      [z.string().endsWith('yz'), 'x', 'Invalid input: must end with "yz"'],
      [z.string().includes('mid'), 'x', 'Invalid input: must include "mid"'],
    ])('%#: %s', (schema, value, message) => {
      expect(parsed(schema, value)).toBe(message);
    });
  });

  describe('invalid_value', () => {
    const color = z.enum(['red', 'green']);

    it.each([
      [color, 'blue', "Invalid enum value. Expected 'red' | 'green', received 'blue'"],
      [color, undefined, 'Required'],
      [color, 5, "Expected 'red' | 'green', received number"],
      [color, true, "Expected 'red' | 'green', received boolean"],
      [z.literal('on'), 'off', 'Invalid literal value, expected "on"'],
      [z.literal(3), 4, 'Invalid literal value, expected 3'],
    ])('%#: %o', (schema, value, message) => {
      expect(parsed(schema, value)).toBe(message);
    });
  });

  it('words a multiple, unknown keys and a discriminator', () => {
    expect(parsed(z.number().multipleOf(5), 7)).toBe('Number must be a multiple of 5');
    expect(parsed(z.strictObject({ a: z.string() }), { a: 'x', b: 1, c: 2 })).toBe(
      "Unrecognized key(s) in object: 'b', 'c'",
    );
    expect(
      msg({ code: 'invalid_union', discriminator: 'kind', options: ['car', 'bus'], errors: [] }),
    ).toBe("Invalid discriminator value. Expected 'car' | 'bus'");
    expect(parsed(z.union([z.string(), z.number()]), true)).toBe('Invalid input');
    expect(msg({ code: 'custom' })).toBe('Invalid input');
  });
});
