// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
// Installs the API's validation messages (z.config) as every route module does.
import { parseZodRequest } from '../lib/zod-schema.js';

function message(schema: z.ZodType, value: unknown): string | undefined {
  const result = schema.safeParse(value);
  return result.success ? undefined : result.error.issues[0]?.message;
}

describe('validation messages', () => {
  it.each([
    ['a missing value', z.object({ a: z.string() }), {}, 'Required'],
    ['a wrong type', z.string(), 5, 'Expected string, received number'],
    ['null for a number', z.number(), null, 'Expected number, received null'],
    ['NaN', z.number(), Number.NaN, 'Expected number, received nan'],
    ['an array for an object', z.object({}), [], 'Expected object, received array'],
    ['a fraction for an integer', z.number().int(), 1.5, 'Expected integer, received float'],
    ['a short string', z.string().min(8), 'abc', 'String must contain at least 8 character(s)'],
    ['a long string', z.string().max(2), 'abc', 'String must contain at most 2 character(s)'],
    [
      'a string of the wrong length',
      z.string().length(2),
      'abc',
      'String must contain exactly 2 character(s)',
    ],
    ['a number below', z.number().min(1), 0, 'Number must be greater than or equal to 1'],
    ['a number not positive', z.number().positive(), 0, 'Number must be greater than 0'],
    ['a number above', z.number().max(5), 6, 'Number must be less than or equal to 5'],
    ['a number not below', z.number().lt(5), 5, 'Number must be less than 5'],
    ['a short array', z.array(z.string()).min(1), [], 'Array must contain at least 1 element(s)'],
    [
      'a long array',
      z.array(z.string()).max(1),
      ['a', 'b'],
      'Array must contain at most 1 element(s)',
    ],
    ['an email', z.email(), 'nope', 'Invalid email'],
    ['a url', z.url(), 'nope', 'Invalid url'],
    ['a uuid', z.guid(), 'nope', 'Invalid uuid'],
    ['a datetime', z.iso.datetime(), 'nope', 'Invalid datetime'],
    ['a pattern', z.string().regex(/^a$/), 'b', 'Invalid'],
    ['a prefix', z.string().startsWith('ab'), 'b', 'Invalid input: must start with "ab"'],
    ['an invalid date', z.date(), new Date('x'), 'Invalid date'],
    ['an enum', z.enum(['a', 'b']), 'c', "Invalid enum value. Expected 'a' | 'b', received 'c'"],
    ['a missing enum value', z.object({ e: z.enum(['a', 'b']) }), {}, 'Required'],
    ['a number for an enum', z.enum(['a', 'b']), 1, "Expected 'a' | 'b', received number"],
    ['Infinity for a number', z.number(), Infinity, 'Expected number, received infinity'],
    ['a literal', z.literal('a'), 'b', 'Invalid literal value, expected "a"'],
    ['a multiple', z.number().multipleOf(5), 7, 'Number must be a multiple of 5'],
    ['unknown keys', z.strictObject({}), { a: 1, b: 2 }, "Unrecognized key(s) in object: 'a', 'b'"],
    ['a union', z.union([z.string(), z.number()]), true, 'Invalid input'],
    ['a refine without a message', z.string().refine(() => false), 'a', 'Invalid input'],
  ])('%s', (_name, schema, value, expected) => {
    expect(message(schema, value)).toBe(expected);
  });

  it('names the options of a discriminated union', () => {
    const schema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a') }),
      z.object({ kind: z.literal('b') }),
    ]);

    expect(message(schema, { kind: 'c' })).toBe("Invalid discriminator value. Expected 'a' | 'b'");
  });

  it('keeps a message the schema sets', () => {
    expect(message(z.string().min(1, 'Name is required'), '')).toBe('Name is required');
    expect(
      message(
        z.string().refine(() => false, { message: 'Nope' }),
        'a',
      ),
    ).toBe('Nope');
    expect(message(z.string().max(1, { error: 'Too long' }), 'ab')).toBe('Too long');
  });

  it('is the message of a VALIDATION_ERROR from parseZodRequest', () => {
    expect(() => parseZodRequest(z.object({ name: z.string().min(2) }), { name: 'a' })).toThrow(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: 'String must contain at least 2 character(s)',
      }),
    );
  });
});
