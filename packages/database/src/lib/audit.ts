// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { PgTable } from 'drizzle-orm/pg-core';
import { db as defaultDb } from '../config.js';

export type AuditActor = 'operator' | 'driver' | 'api_key' | 'system' | 'ocpp';

export interface WriteAuditArgs {
  /** Live entity ID (text). Set to null when the source row no longer exists. */
  entityId: string | null;
  /** Snapshot of the entity ID. Always set so audit rows survive hard delete. */
  entityIdSnapshot: string;
  /** Per-entity action enum value, e.g. 'updated', 'pushed', 'deleted'. */
  action: string;
  actor: AuditActor;
  actorUserId?: string | null;
  actorDriverId?: string | null;
  actorApiKeyId?: string | null;
  /** Optional free-text label for `system` / `ocpp` actors (e.g. cron name, OCPP message type). */
  actorLabel?: string | null;
  before?: unknown;
  after?: unknown;
  notes?: string | null;
}

type AuditDb = Pick<typeof defaultDb, 'insert'>;

/**
 * Map every per-entity audit table to a single physical column name. Each
 * audit table uses `<entity>_id` + `<entity>_id_snapshot` (e.g. `site_id`,
 * `station_id_snapshot`). The helper accepts a Drizzle table object and the
 * entity-id column name so callers don't have to spell the column out.
 */
type AuditTableConfig = {
  table: PgTable;
  /** Column name without the `_snapshot` suffix, e.g. 'site_id'. */
  idColumn: string;
};

// Field names that must NEVER appear in audit before/after JSONB. These are
// password hashes, encrypted secrets, MFA seeds, and API key hashes. Anyone
// with both the audit table and the encryption key (or the time to brute
// force a hash) could otherwise impersonate the entity owner.
const SENSITIVE_AUDIT_FIELDS: ReadonlySet<string> = new Set([
  'passwordHash',
  'password_hash',
  'totpSecretEnc',
  'totp_secret_enc',
  'mfaSecret',
  'mfa_secret',
  'tokenHash',
  'token_hash',
  'basicAuthPasswordHash',
  'basic_auth_password_hash',
  'apiKeyHash',
  'api_key_hash',
  'clientCert',
  'client_cert',
  'clientKey',
  'client_key',
]);

/**
 * Returns a shallow copy of `obj` with sensitive fields redacted to the
 * literal string '<redacted>'. Recurses one level into nested objects so
 * `before.driver.passwordHash` is also caught. Arrays and primitives pass
 * through unchanged.
 */
export function redactAuditPayload(obj: unknown): unknown {
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_AUDIT_FIELDS.has(k)) {
      out[k] = '<redacted>';
    } else if (v != null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      out[k] = redactAuditPayload(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function writeAudit(
  config: AuditTableConfig,
  args: WriteAuditArgs,
  db: AuditDb = defaultDb,
  logger?: { warn: (obj: unknown, msg?: string) => void },
): Promise<void> {
  try {
    const values: Record<string, unknown> = {
      [toCamel(config.idColumn)]: args.entityId,
      [toCamel(`${config.idColumn}_snapshot`)]: args.entityIdSnapshot,
      action: args.action,
      actor: args.actor,
      actorUserId: args.actorUserId ?? null,
      actorDriverId: args.actorDriverId ?? null,
      actorApiKeyId: args.actorApiKeyId ?? null,
      actorLabel: args.actorLabel ?? null,
      // Always strip sensitive fields (password hashes, encrypted secrets,
      // certificate private keys) before persisting. The redactor caches
      // a shallow copy so the original entity row passed in by the caller
      // is not mutated.
      before: args.before == null ? null : redactAuditPayload(args.before),
      after: args.after == null ? null : redactAuditPayload(args.after),
      notes: args.notes ?? null,
    };
    // Drizzle insert accepts a values object keyed by camelCase JS field names.
    // We type the helper input loosely so callers don't have to import the
    // narrow per-table type; the runtime shape matches every audit table.
    await db.insert(config.table).values(values as never);
  } catch (err) {
    if (logger != null) {
      logger.warn(
        { err, entityId: args.entityIdSnapshot, action: args.action },
        'audit insert failed (mutation already committed)',
      );
    }
  }
}

function toCamel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
