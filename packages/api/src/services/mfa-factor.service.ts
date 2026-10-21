// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomInt } from 'node:crypto';
import argon2 from 'argon2';
import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  db,
  driverAuditLog,
  drivers,
  mfaRecoveryCodes,
  userAuditLog,
  users,
  webauthnCredentials,
  writeAudit,
} from '@evtivity/database';
import { STATION_PASSWORD_HASH_OPTIONS } from '@evtivity/lib/station-password';
import type { AuditActorInfo } from '../lib/audit-actor.js';
import { endUserSessions } from '../lib/operator-session.js';
import { hasMfa } from '../lib/mfa-factors.js';
import { factorFlags, sendSecurityNotice } from '../lib/security-notice.js';
import { endDriverSessions } from './refresh-token.service.js';

/** The account a factor belongs to: an operator or a driver. */
export type MfaAccount = { userId: string } | { driverId: string };

export interface MfaFactorContext {
  actor: AuditActorInfo;
  log: { warn: (obj: unknown, msg?: string) => void };
}

type DbExecutor = typeof db;
type TxExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const RECOVERY_CODE_COUNT = 10;

// No 0, 1, i, l or o: a code read from paper cannot be mistyped for another one.
const RECOVERY_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const RECOVERY_CODE_LENGTH = 10;

// argon2id at the OWASP minimum (19 MiB, t=2, p=1), the station password
// parameters. The codes are random (about 49 bits), so the hash cost only
// slows an offline attack on a leaked table, and a sign-in checks up to ten
// hashes: the argon2 default (64 MiB, t=3, p=4) would cost about six times
// the CPU per attempt.
const RECOVERY_CODE_HASH_OPTIONS = { ...STATION_PASSWORD_HASH_OPTIONS };

/** One new code as shown to the user: `xxxxx-xxxxx`. */
export function generateRecoveryCode(): string {
  let raw = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
    raw += RECOVERY_CODE_ALPHABET.charAt(randomInt(RECOVERY_CODE_ALPHABET.length));
  }
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** The code as hashed and compared: lowercase, without dashes or spaces. */
export function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[\s-]/g, '');
}

function accountCondition(account: MfaAccount) {
  return 'userId' in account
    ? eq(mfaRecoveryCodes.userId, account.userId)
    : eq(mfaRecoveryCodes.driverId, account.driverId);
}

/** The primary method of an account, read under its row lock. */
interface LockedAccount {
  mfaEnabled: boolean;
  mfaMethod: string | null;
}

/**
 * Locks the account row (`SELECT ... FOR UPDATE`) for the rest of the
 * transaction and returns its primary method, or null for a missing account.
 * Every factor write of the account takes this lock first, so decisions about
 * the account's factors (first factor, last factor, credential limit) are made
 * on counts no parallel request can change.
 */
async function lockAccountRow(tx: TxExecutor, account: MfaAccount): Promise<LockedAccount | null> {
  if ('userId' in account) {
    const [row] = await tx
      .select({ mfaEnabled: users.mfaEnabled, mfaMethod: users.mfaMethod })
      .from(users)
      .where(eq(users.id, account.userId))
      .for('update');
    return row ?? null;
  }
  const [row] = await tx
    .select({ mfaEnabled: drivers.mfaEnabled, mfaMethod: drivers.mfaMethod })
    .from(drivers)
    .where(eq(drivers.id, account.driverId))
    .for('update');
  return row ?? null;
}

function accountColumns(account: MfaAccount): { userId: string } | { driverId: string } {
  return 'userId' in account ? { userId: account.userId } : { driverId: account.driverId };
}

type MfaFactorAuditAction =
  | 'recovery_codes_generated'
  | 'recovery_codes_regenerated'
  | 'recovery_code_used'
  | 'webauthn_credential_added'
  | 'webauthn_credential_renamed'
  | 'webauthn_credential_removed'
  | 'mfa_disabled';

async function audit(
  account: MfaAccount,
  action: MfaFactorAuditAction,
  after: Record<string, unknown>,
  ctx: MfaFactorContext,
  before?: Record<string, unknown>,
): Promise<void> {
  const id = 'userId' in account ? account.userId : account.driverId;
  const config =
    'userId' in account
      ? { table: userAuditLog, idColumn: 'user_id' as const }
      : { table: driverAuditLog, idColumn: 'driver_id' as const };
  await writeAudit(
    config,
    {
      entityId: id,
      entityIdSnapshot: id,
      action,
      ...ctx.actor,
      after,
      ...(before != null ? { before } : {}),
    },
    db,
    ctx.log,
  );
}

/** The recovery codes the account has not used yet. */
export async function countRecoveryCodes(account: MfaAccount): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(mfaRecoveryCodes)
    .where(and(accountCondition(account), isNull(mfaRecoveryCodes.usedAt)));
  return row?.n ?? 0;
}

/**
 * Whether the account used every recovery code it was given: it has codes, all used.
 * Tells "used them all, generate new ones" apart from an account that never had codes
 * (MFA set up before v0.1.48). Regenerating and turning MFA off delete the old rows.
 */
export async function recoveryCodesUsedUp(account: MfaAccount): Promise<boolean> {
  const [row] = await db
    .select({
      total: count(),
      unused: count(sql`CASE WHEN ${mfaRecoveryCodes.usedAt} IS NULL THEN 1 END`),
    })
    .from(mfaRecoveryCodes)
    .where(accountCondition(account));
  return (row?.total ?? 0) > 0 && (row?.unused ?? 0) === 0;
}

/**
 * Replaces the account's recovery codes with ten new ones and returns them in plain text,
 * the only time they exist outside the hashes. `generated` on MFA confirm, `regenerated`
 * when the user asks for new codes; either way the old codes stop working.
 */
export async function issueRecoveryCodes(
  account: MfaAccount,
  kind: 'generated' | 'regenerated',
  ctx: MfaFactorContext,
): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
  const hashes: string[] = [];
  // One at a time: ten parallel hashes would hold ten times the argon2 memory.
  for (const code of codes) {
    hashes.push(await argon2.hash(normalizeRecoveryCode(code), RECOVERY_CODE_HASH_OPTIONS));
  }
  await db.transaction(async (tx) => {
    // Serialize per account on the account row: two overlapping calls would
    // otherwise both delete before either inserts and leave twenty codes. MFA
    // disable and the admin reset update the same row in their transaction,
    // so they wait for this one too.
    await lockAccountRow(tx, account);
    await tx.delete(mfaRecoveryCodes).where(accountCondition(account));
    await tx
      .insert(mfaRecoveryCodes)
      .values(hashes.map((codeHash) => ({ ...accountColumns(account), codeHash })));
  });
  await audit(
    account,
    kind === 'generated' ? 'recovery_codes_generated' : 'recovery_codes_regenerated',
    { count: RECOVERY_CODE_COUNT },
    ctx,
  );
  // The first codes come with MFA turned on, which has its own notice.
  if (kind === 'regenerated') {
    sendSecurityNotice(account, 'security.RecoveryCodesRegenerated', {}, ctx.log);
  }
  return codes;
}

/**
 * Checks a recovery code and uses it up. A guarded UPDATE marks it used, so of two
 * requests with one code only one passes. `used` is false for a wrong or used code.
 */
export async function consumeRecoveryCode(
  account: MfaAccount,
  input: string,
  ctx: MfaFactorContext,
): Promise<{ used: boolean; remaining: number }> {
  const code = normalizeRecoveryCode(input);
  const candidates = await db
    .select({ id: mfaRecoveryCodes.id, codeHash: mfaRecoveryCodes.codeHash })
    .from(mfaRecoveryCodes)
    .where(and(accountCondition(account), isNull(mfaRecoveryCodes.usedAt)));

  let matchedId: number | null = null;
  if (code.length === RECOVERY_CODE_LENGTH) {
    for (const candidate of candidates) {
      if (await verifyHash(candidate.codeHash, code, ctx)) {
        matchedId = candidate.id;
        break;
      }
    }
  }
  if (matchedId == null) return { used: false, remaining: candidates.length };

  const [claimed] = await db
    .update(mfaRecoveryCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(mfaRecoveryCodes.id, matchedId), isNull(mfaRecoveryCodes.usedAt)))
    .returning({ id: mfaRecoveryCodes.id });
  const remaining = await countRecoveryCodes(account);
  if (claimed == null) return { used: false, remaining };

  await audit(account, 'recovery_code_used', { remaining }, ctx);
  sendSecurityNotice(
    account,
    'security.RecoveryCodeUsed',
    { remaining: String(remaining) },
    ctx.log,
  );
  return { used: true, remaining };
}

async function verifyHash(hash: string, code: string, ctx: MfaFactorContext): Promise<boolean> {
  try {
    return await argon2.verify(hash, code);
  } catch (err: unknown) {
    // A stored hash argon2 cannot parse counts as no match; the other codes still work.
    ctx.log.warn({ err }, 'Recovery code hash could not be checked, treating it as no match');
    return false;
  }
}

/**
 * Deletes every recovery code of the account: MFA disabled by the user, MFA reset by an
 * admin, driver erasure. Pass the caller's transaction to delete inside it.
 */
export async function deleteRecoveryCodes(
  account: MfaAccount,
  executor: DbExecutor | TxExecutor = db,
): Promise<void> {
  await executor.delete(mfaRecoveryCodes).where(accountCondition(account));
}

// WebAuthn credentials (passkeys and security keys). This service is the only
// writer of webauthn_credentials.

/** Passkeys and security keys an account may register. */
export const MAX_WEBAUTHN_CREDENTIALS = 20;

/** A credential as the account's own list shows it: never the public key. */
export interface WebauthnCredentialSummary {
  id: number;
  name: string;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  aaguid: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** A credential with what verifying a sign-in needs. */
export interface StoredWebauthnCredential extends WebauthnCredentialSummary {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  userHandle: string;
  userId: string | null;
  driverId: string | null;
}

/** What a verified registration stores. */
export interface NewWebauthnCredential {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  aaguid: string | null;
  userHandle: string;
  name: string;
}

function credentialAccountCondition(account: MfaAccount) {
  return 'userId' in account
    ? eq(webauthnCredentials.userId, account.userId)
    : eq(webauthnCredentials.driverId, account.driverId);
}

const SUMMARY_COLUMNS = {
  id: webauthnCredentials.id,
  name: webauthnCredentials.name,
  deviceType: webauthnCredentials.deviceType,
  backedUp: webauthnCredentials.backedUp,
  transports: webauthnCredentials.transports,
  aaguid: webauthnCredentials.aaguid,
  createdAt: webauthnCredentials.createdAt,
  lastUsedAt: webauthnCredentials.lastUsedAt,
};

const STORED_COLUMNS = {
  ...SUMMARY_COLUMNS,
  credentialId: webauthnCredentials.credentialId,
  publicKey: webauthnCredentials.publicKey,
  counter: webauthnCredentials.counter,
  userHandle: webauthnCredentials.userHandle,
  userId: webauthnCredentials.userId,
  driverId: webauthnCredentials.driverId,
};

export async function countWebauthnCredentials(account: MfaAccount): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(webauthnCredentials)
    .where(credentialAccountCondition(account));
  return row?.n ?? 0;
}

/** The second-factor counts every sign-in gate passes to `usableFactors`. */
export async function mfaFactorCounts(
  account: MfaAccount,
): Promise<{ recoveryCodesRemaining: number; passkeyCount: number }> {
  const [recoveryCodesRemaining, passkeyCount] = await Promise.all([
    countRecoveryCodes(account),
    countWebauthnCredentials(account),
  ]);
  return { recoveryCodesRemaining, passkeyCount };
}

/** The account's credentials, newest first. */
export async function listWebauthnCredentials(
  account: MfaAccount,
): Promise<WebauthnCredentialSummary[]> {
  return db
    .select(SUMMARY_COLUMNS)
    .from(webauthnCredentials)
    .where(credentialAccountCondition(account))
    .orderBy(desc(webauthnCredentials.createdAt), desc(webauthnCredentials.id));
}

/** The account's credentials with their ids and transports, for the ceremony options. */
export async function webauthnCredentialsForCeremony(
  account: MfaAccount,
): Promise<StoredWebauthnCredential[]> {
  return db
    .select(STORED_COLUMNS)
    .from(webauthnCredentials)
    .where(credentialAccountCondition(account))
    .orderBy(asc(webauthnCredentials.id));
}

/** The credential with this WebAuthn credential id, of any account, or null. */
export async function findWebauthnCredential(
  credentialId: string,
): Promise<StoredWebauthnCredential | null> {
  const [row] = await db
    .select(STORED_COLUMNS)
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.credentialId, credentialId));
  return row ?? null;
}

/**
 * The WebAuthn user handle of the account: the one its credentials already
 * carry, so every passkey of the account shares it, or null for none yet.
 */
export async function accountUserHandle(account: MfaAccount): Promise<string | null> {
  const [row] = await db
    .select({ userHandle: webauthnCredentials.userHandle })
    .from(webauthnCredentials)
    .where(credentialAccountCondition(account))
    .orderBy(asc(webauthnCredentials.id))
    .limit(1);
  return row?.userHandle ?? null;
}

/** The outcome of storing a verified registration. */
export type WebauthnRegistration =
  | { status: 'registered'; credential: WebauthnCredentialSummary; firstFactor: boolean }
  | { status: 'limit_reached' }
  | { status: 'duplicate' };

/**
 * Stores a verified registration. Under the account row lock it counts the
 * credentials (at most `MAX_WEBAUTHN_CREDENTIALS`) and decides whether the new
 * one is the account's first factor (no primary method, no other credential),
 * so two parallel registrations can neither pass the limit nor both count as
 * the first factor. `duplicate` when the credential id is already registered
 * (to this or another account): an authenticator returns one id per credential.
 */
export async function registerWebauthnCredential(
  account: MfaAccount,
  input: NewWebauthnCredential,
  ctx: MfaFactorContext,
): Promise<WebauthnRegistration> {
  const outcome = await db.transaction(async (tx): Promise<WebauthnRegistration> => {
    const locked = await lockAccountRow(tx, account);
    const [counted] = await tx
      .select({ n: count() })
      .from(webauthnCredentials)
      .where(credentialAccountCondition(account));
    const passkeyCount = counted?.n ?? 0;
    if (passkeyCount >= MAX_WEBAUTHN_CREDENTIALS) return { status: 'limit_reached' };
    const [row] = await tx
      .insert(webauthnCredentials)
      .values({
        ...accountColumns(account),
        credentialId: input.credentialId,
        publicKey: Buffer.from(input.publicKey),
        counter: input.counter,
        transports: input.transports,
        deviceType: input.deviceType,
        backedUp: input.backedUp,
        aaguid: input.aaguid,
        userHandle: input.userHandle,
        name: input.name,
      })
      .onConflictDoNothing({ target: webauthnCredentials.credentialId })
      .returning(SUMMARY_COLUMNS);
    if (row == null) return { status: 'duplicate' };
    const firstFactor = !hasMfa({
      mfaEnabled: locked?.mfaEnabled ?? false,
      mfaMethod: locked?.mfaMethod ?? null,
      passkeyCount,
    });
    return { status: 'registered', credential: row, firstFactor };
  });
  if (outcome.status === 'registered') {
    await audit(
      account,
      'webauthn_credential_added',
      {
        credentialId: outcome.credential.id,
        name: outcome.credential.name,
        deviceType: outcome.credential.deviceType,
      },
      ctx,
    );
    sendSecurityNotice(
      account,
      'security.FactorAdded',
      { mfaTurnedOn: outcome.firstFactor, ...factorFlags('passkey') },
      ctx.log,
    );
  }
  return outcome;
}

/** Renames a credential of the account; null when the account has no such credential. */
export async function renameWebauthnCredential(
  account: MfaAccount,
  id: number,
  name: string,
  ctx: MfaFactorContext,
): Promise<WebauthnCredentialSummary | null> {
  const [before] = await db
    .select({ name: webauthnCredentials.name })
    .from(webauthnCredentials)
    .where(and(eq(webauthnCredentials.id, id), credentialAccountCondition(account)));
  if (before == null) return null;
  const [row] = await db
    .update(webauthnCredentials)
    .set({ name })
    .where(and(eq(webauthnCredentials.id, id), credentialAccountCondition(account)))
    .returning(SUMMARY_COLUMNS);
  if (row == null) return null;
  if (before.name !== name) {
    await audit(account, 'webauthn_credential_renamed', { credentialId: id, name }, ctx, {
      credentialId: id,
      name: before.name,
    });
  }
  return row;
}

/** The outcome of a credential removal; `refused` carries the last-factor check's reason. */
export type WebauthnRemoval<R extends string> =
  | { status: 'removed'; sessionVersion: number | null; lastFactor: boolean }
  | { status: 'not_found' }
  | { status: 'refused'; reason: R };

/**
 * Removes a credential of the account and ends the account's sessions
 * (session version and refresh tokens; API keys stay). Under the account row
 * lock it recounts the credentials and reads the primary method, so the
 * last-factor decision holds against a parallel removal: when the credential
 * is the account's last factor, `lastFactorCheck` runs under the same lock
 * (the policy and password checks) and a reason it returns refuses the
 * removal with nothing deleted. A last factor takes the recovery codes with it,
 * in the same transaction. `sessionVersion` is the operator's new session
 * version (null for a driver), for the caller's new session.
 */
export async function removeWebauthnCredential<R extends string>(
  account: MfaAccount,
  id: number,
  opts: { lastFactorCheck: () => Promise<R | null> },
  ctx: MfaFactorContext,
): Promise<WebauthnRemoval<R>> {
  const outcome = await db.transaction(
    async (
      tx,
    ): Promise<
      | { status: 'not_found' }
      | { status: 'refused'; reason: R }
      | { status: 'deleted'; name: string; lastFactor: boolean }
    > => {
      const locked = await lockAccountRow(tx, account);
      const credentials = await tx
        .select({ id: webauthnCredentials.id, name: webauthnCredentials.name })
        .from(webauthnCredentials)
        .where(credentialAccountCondition(account));
      const target = credentials.find((c) => c.id === id);
      if (locked == null || target == null) return { status: 'not_found' };
      const lastFactor =
        !(locked.mfaEnabled && locked.mfaMethod != null) && credentials.length === 1;
      if (lastFactor) {
        const reason = await opts.lastFactorCheck();
        if (reason != null) return { status: 'refused', reason };
      }
      await tx
        .delete(webauthnCredentials)
        .where(and(eq(webauthnCredentials.id, id), credentialAccountCondition(account)));
      if (lastFactor) await deleteRecoveryCodes(account, tx);
      return { status: 'deleted', name: target.name, lastFactor };
    },
  );
  if (outcome.status !== 'deleted') return outcome;

  let sessionVersion: number | null = null;
  if ('userId' in account) {
    sessionVersion = await endUserSessions(account.userId, { apiKeys: false });
  } else {
    await endDriverSessions(account.driverId);
  }

  await audit(account, 'webauthn_credential_removed', { credentialId: id }, ctx, {
    credentialId: id,
    name: outcome.name,
  });
  if (outcome.lastFactor) {
    await audit(account, 'mfa_disabled', { mfaEnabled: false, passkeys: 0 }, ctx, {
      passkeys: 1,
    });
  }
  sendSecurityNotice(
    account,
    'security.FactorRemoved',
    { mfaTurnedOff: outcome.lastFactor, byAdmin: false },
    ctx.log,
  );
  return { status: 'removed', sessionVersion, lastFactor: outcome.lastFactor };
}

/**
 * Records a verified sign-in with the credential: the new signature counter
 * and the time. The UPDATE is guarded on the counter the check started from,
 * so of two assertions verified against one stored counter only one counts.
 * No audit row: the sign-in writes `login_succeeded` and `last_used_at` keeps the time.
 */
export async function recordWebauthnCredentialUse(
  credential: Pick<StoredWebauthnCredential, 'id' | 'counter'>,
  update: { newCounter: number; backedUp: boolean },
): Promise<boolean> {
  const [row] = await db
    .update(webauthnCredentials)
    .set({ counter: update.newCounter, backedUp: update.backedUp, lastUsedAt: new Date() })
    .where(
      and(
        eq(webauthnCredentials.id, credential.id),
        eq(webauthnCredentials.counter, credential.counter),
      ),
    )
    .returning({ id: webauthnCredentials.id });
  return row != null;
}

/**
 * Deletes every WebAuthn credential of the account: MFA disabled by the user,
 * MFA reset by an admin, driver erasure and deactivation. Pass the caller's
 * transaction to delete inside it.
 */
export async function deleteWebauthnCredentials(
  account: MfaAccount,
  executor: DbExecutor | TxExecutor = db,
): Promise<void> {
  await executor.delete(webauthnCredentials).where(credentialAccountCondition(account));
}
