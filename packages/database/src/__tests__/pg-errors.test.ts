// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { pgErrorCode, pgConstraintName, PG_UNIQUE_VIOLATION } from '../lib/pg-errors.js';

describe('pgErrorCode', () => {
  it('reads the SQLSTATE of a drizzle-wrapped error from its cause', () => {
    const driver = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint_name: 'drivers_email_unique',
    });
    const wrapped = Object.assign(new Error('Failed query: insert ...'), { cause: driver });
    expect(pgErrorCode(wrapped)).toBe(PG_UNIQUE_VIOLATION);
    expect(pgConstraintName(wrapped)).toBe('drivers_email_unique');
  });

  it('reads a raw postgres.js error', () => {
    expect(pgErrorCode(Object.assign(new Error('fk'), { code: '23503' }))).toBe('23503');
  });

  it('is undefined for errors without a SQLSTATE', () => {
    expect(pgErrorCode(new Error('boom'))).toBeUndefined();
    expect(pgErrorCode(Object.assign(new Error('x'), { cause: new Error('y') }))).toBeUndefined();
    expect(pgErrorCode(null)).toBeUndefined();
    expect(pgErrorCode('23505')).toBeUndefined();
    expect(pgConstraintName(new Error('x'))).toBeUndefined();
  });
});
