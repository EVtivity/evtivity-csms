// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  pgErrorCode,
  pgConstraintName,
  pgConnectionErrorKind,
  PG_UNIQUE_VIOLATION,
} from '../lib/pg-errors.js';

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

describe('pgConnectionErrorKind', () => {
  const withCode = (code: string) => Object.assign(new Error(`write ${code}`), { code });

  it('a connection that could not be opened never sent the statement', () => {
    for (const code of [
      'CONNECT_TIMEOUT',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EHOSTUNREACH',
      'ENETUNREACH',
      '53300',
      '57P03',
      '08001',
      '08004',
    ]) {
      expect(pgConnectionErrorKind(withCode(code)), code).toBe('not-sent');
    }
  });

  it('a connection lost during the statement leaves its outcome unknown', () => {
    for (const code of [
      'CONNECTION_CLOSED',
      'ECONNRESET',
      'EPIPE',
      'ETIMEDOUT',
      '57P01',
      '57P02',
      '08000',
      '08003',
      '08006',
      '08007',
    ]) {
      expect(pgConnectionErrorKind(withCode(code)), code).toBe('interrupted');
    }
  });

  it('reads a drizzle-wrapped connection error from its cause', () => {
    const wrapped = Object.assign(new Error('Failed query'), {
      cause: withCode('CONNECT_TIMEOUT'),
    });
    expect(pgConnectionErrorKind(wrapped)).toBe('not-sent');
  });

  it('is null for data errors, a closed pool, and errors without a code', () => {
    for (const code of [
      '23505',
      '23503',
      '22001',
      '40P01',
      'CONNECTION_ENDED',
      'CONNECTION_DESTROYED',
    ]) {
      expect(pgConnectionErrorKind(withCode(code)), code).toBeNull();
    }
    expect(pgConnectionErrorKind(new Error('boom'))).toBeNull();
    expect(pgConnectionErrorKind(null)).toBeNull();
  });
});
