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
