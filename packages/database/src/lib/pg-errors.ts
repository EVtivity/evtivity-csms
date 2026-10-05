// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** SQLSTATE unique_violation. */
export const PG_UNIQUE_VIOLATION = '23505';
/** SQLSTATE foreign_key_violation. */
export const PG_FOREIGN_KEY_VIOLATION = '23503';

/**
 * The Postgres driver error behind `err`: drizzle-orm wraps every driver error
 * in a DrizzleQueryError whose `cause` is the postgres.js error, while a query
 * through the raw `client` throws the postgres.js error itself.
 */
function driverError(err: unknown): Record<string, unknown> | null {
  if (err == null || typeof err !== 'object') return null;
  const cause = (err as { cause?: unknown }).cause;
  if (
    cause != null &&
    typeof cause === 'object' &&
    typeof (cause as { code?: unknown }).code === 'string'
  ) {
    return cause as Record<string, unknown>;
  }
  return err as Record<string, unknown>;
}

/** SQLSTATE of a Postgres error (drizzle-wrapped or raw), or undefined for any other error. */
export function pgErrorCode(err: unknown): string | undefined {
  const code = driverError(err)?.['code'];
  return typeof code === 'string' ? code : undefined;
}

/** Constraint name of a Postgres constraint violation (drizzle-wrapped or raw). */
export function pgConstraintName(err: unknown): string | undefined {
  const e = driverError(err);
  const name = e?.['constraint_name'] ?? e?.['constraint'];
  return typeof name === 'string' ? name : undefined;
}

/**
 * How a lost database connection failed a statement:
 * - `not-sent`: no connection could be opened, so the statement never reached
 *   the server (postgres.js `CONNECT_TIMEOUT`, a refused or unreachable host,
 *   too many clients 53300, the server starting or stopping 57P03, 08001, 08004).
 * - `interrupted`: an open connection was lost while the statement ran, so it
 *   may or may not have committed (`CONNECTION_CLOSED`, a reset socket, admin or
 *   crash shutdown 57P01 and 57P02, connection exceptions 08000, 08003, 08006, 08007).
 */
export type PgConnectionErrorKind = 'not-sent' | 'interrupted';

const NOT_SENT_CODES = new Set([
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
]);

const INTERRUPTED_CODES = new Set([
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
]);

/**
 * The connection failure behind `err` (drizzle-wrapped or raw), or null for
 * every other error: constraint violations, bad data, and a pool closed by
 * `sql.end()` (`CONNECTION_ENDED`, `CONNECTION_DESTROYED`: the process is
 * stopping). Only a connection failure is worth running a statement again.
 */
export function pgConnectionErrorKind(err: unknown): PgConnectionErrorKind | null {
  const code = pgErrorCode(err);
  if (code == null) return null;
  if (NOT_SENT_CODES.has(code)) return 'not-sent';
  if (INTERRUPTED_CODES.has(code)) return 'interrupted';
  return null;
}
