// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { z } from 'zod';

/**
 * The API's own English message for each Zod issue code, independent of the
 * wording of the Zod release. A message a schema sets itself (`.refine(fn,
 * 'text')`, `.min(1, 'text')`) wins over these. API clients map these texts
 * to their own language (the mobile app's field error rules), so they keep
 * the wording of the API before Zod 4:
 *
 * - missing value: `Required`
 * - wrong type: `Expected <type>, received <type>` (`Expected integer,
 *   received float` for a fraction where an integer is required)
 * - string length: `String must contain at least|exactly|over <n> character(s)`,
 *   `String must contain at most|exactly|under <n> character(s)`
 * - number bounds: `Number must be greater than or equal to|greater than|exactly
 *   equal to <n>`, `Number must be less than or equal to|less than|exactly <n>`
 * - array size: `Array must contain at least|exactly|more than <n> element(s)`,
 *   `Array must contain at most|exactly|less than <n> element(s)`
 * - string format: `Invalid email`, `Invalid url`, `Invalid uuid`,
 *   `Invalid datetime`, `Invalid date`, `Invalid ip`, `Invalid <format>`;
 *   a pattern: `Invalid`; `Invalid input: must start with|end with|include "<text>"`
 * - an invalid date: `Invalid date`
 * - enum: `Invalid enum value. Expected 'a' | 'b', received 'c'`; a missing value
 *   `Required`, a value of another type `Expected 'a' | 'b', received number`
 * - Infinity for a number: `Expected number, received infinity`
 * - literal: `Invalid literal value, expected "a"`
 * - multiple: `Number must be a multiple of <n>`
 * - unknown keys: `Unrecognized key(s) in object: 'a', 'b'`
 * - discriminated union: `Invalid discriminator value. Expected 'a' | 'b'`
 * - anything else (refine without a message, union, record key): `Invalid input`
 */
export function validationMessage(issue: z.core.$ZodRawIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return invalidTypeMessage(issue.expected, issue.input);
    case 'too_small':
      return tooSmallMessage(issue.origin, issue.minimum, issue.inclusive, issue.exact);
    case 'too_big':
      return tooBigMessage(issue.origin, issue.maximum, issue.inclusive, issue.exact);
    case 'invalid_format':
      return invalidFormatMessage(issue);
    case 'invalid_value':
      return invalidValueMessage(issue);
    case 'not_multiple_of':
      return `Number must be a multiple of ${String(issue.divisor)}`;
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${joinValues(issue.keys, ', ')}`;
    case 'invalid_union': {
      const options = (issue as { options?: unknown }).options;
      return issue.discriminator != null && Array.isArray(options)
        ? `Invalid discriminator value. Expected ${joinValues(options)}`
        : 'Invalid input';
    }
    default:
      return 'Invalid input';
  }
}

const EXPECTED_NAMES: Readonly<Record<string, string>> = {
  int: 'integer',
  tuple: 'array',
  record: 'object',
};

function invalidTypeMessage(expected: string, input: unknown): string {
  if (input === undefined) return 'Required';
  if (expected === 'date' && input instanceof Date && Number.isNaN(input.getTime())) {
    return 'Invalid date';
  }
  const received =
    expected === 'int' && typeof input === 'number' && Number.isFinite(input)
      ? 'float'
      : receivedType(input);
  return `Expected ${EXPECTED_NAMES[expected] ?? expected}, received ${received}`;
}

/** The type name of a value, as the messages name it. */
function receivedType(value: unknown): string {
  switch (typeof value) {
    case 'number':
      if (Number.isNaN(value)) return 'nan';
      return Number.isFinite(value) ? 'number' : 'infinity';
    case 'object':
      if (value === null) return 'null';
      if (Array.isArray(value)) return 'array';
      if (value instanceof Date) return 'date';
      if (value instanceof Map) return 'map';
      if (value instanceof Set) return 'set';
      if (value instanceof Promise) return 'promise';
      return 'object';
    default:
      return typeof value;
  }
}

function bound(value: number | bigint): string {
  return String(value);
}

function tooSmallMessage(
  origin: string,
  minimum: number | bigint,
  inclusive: boolean | undefined,
  exact: boolean | undefined,
): string {
  const n = bound(minimum);
  switch (origin) {
    case 'array':
    case 'set':
      return `Array must contain ${exact === true ? 'exactly' : inclusive === true ? 'at least' : 'more than'} ${n} element(s)`;
    case 'string':
      return `String must contain ${exact === true ? 'exactly' : inclusive === true ? 'at least' : 'over'} ${n} character(s)`;
    case 'number':
    case 'int':
    case 'bigint':
      return `Number must be ${exact === true ? 'exactly equal to ' : inclusive === true ? 'greater than or equal to ' : 'greater than '}${n}`;
    case 'date':
      return `Date must be ${exact === true ? 'exactly equal to ' : inclusive === true ? 'greater than or equal to ' : 'greater than '}${new Date(Number(minimum)).toString()}`;
    default:
      return 'Invalid input';
  }
}

function tooBigMessage(
  origin: string,
  maximum: number | bigint,
  inclusive: boolean | undefined,
  exact: boolean | undefined,
): string {
  const n = bound(maximum);
  switch (origin) {
    case 'array':
    case 'set':
      return `Array must contain ${exact === true ? 'exactly' : inclusive === true ? 'at most' : 'less than'} ${n} element(s)`;
    case 'string':
      return `String must contain ${exact === true ? 'exactly' : inclusive === true ? 'at most' : 'under'} ${n} character(s)`;
    case 'number':
    case 'int':
      return `Number must be ${exact === true ? 'exactly' : inclusive === true ? 'less than or equal to' : 'less than'} ${n}`;
    case 'bigint':
      return `BigInt must be ${exact === true ? 'exactly' : inclusive === true ? 'less than or equal to' : 'less than'} ${n}`;
    case 'date':
      return `Date must be ${exact === true ? 'exactly' : inclusive === true ? 'smaller than or equal to' : 'smaller than'} ${new Date(Number(maximum)).toString()}`;
    default:
      return 'Invalid input';
  }
}

const FORMAT_NAMES: Readonly<Record<string, string>> = {
  guid: 'uuid',
  ipv4: 'ip',
  ipv6: 'ip',
  cidrv4: 'cidr',
  cidrv6: 'cidr',
};

function invalidFormatMessage(
  issue: z.core.$ZodRawIssue<z.core.$ZodIssueInvalidStringFormat>,
): string {
  const details = issue as unknown as Record<string, unknown>;
  switch (issue.format) {
    case 'regex':
      return 'Invalid';
    case 'starts_with':
      return `Invalid input: must start with "${String(details['prefix'])}"`;
    case 'ends_with':
      return `Invalid input: must end with "${String(details['suffix'])}"`;
    case 'includes':
      return `Invalid input: must include "${String(details['includes'])}"`;
    default:
      return `Invalid ${FORMAT_NAMES[issue.format] ?? issue.format}`;
  }
}

function invalidValueMessage(issue: z.core.$ZodRawIssue<z.core.$ZodIssueInvalidValue>): string {
  const inst = issue.inst as { _zod?: { def?: { type?: string } } } | undefined;
  const [only] = issue.values;
  if (inst?._zod?.def?.type === 'literal' && issue.values.length === 1) {
    return `Invalid literal value, expected ${typeof only === 'string' ? JSON.stringify(only) : String(only)}`;
  }
  // An enum refuses a value of another type as a wrong type: a missing value
  // is `Required`, a number for a string enum names the received type.
  const input = issue.input;
  if (input === undefined) return 'Required';
  if (
    (typeof input !== 'string' && typeof input !== 'number') ||
    !issue.values.some((v) => typeof v === typeof input)
  ) {
    return `Expected ${joinValues(issue.values)}, received ${receivedType(input)}`;
  }
  return `Invalid enum value. Expected ${joinValues(issue.values)}, received '${String(input)}'`;
}

function joinValues(values: readonly unknown[], separator = ' | '): string {
  return values.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(separator);
}
