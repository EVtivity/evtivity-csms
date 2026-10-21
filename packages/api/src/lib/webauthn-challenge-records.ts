// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { tryParseJson } from '@evtivity/lib';

/** The account a challenge belongs to: an operator or a driver, never both. */
export type WebauthnChallengeOwner = { userId: string } | { driverId: string };

/** The ceremonies a challenge can answer for a known account. */
export type WebauthnAccountPurpose =
  | 'registration'
  | 'second_factor'
  | 'recovery_regenerate'
  | 'factor_add';

/** Who a passkey sign-in signs in: the CSMS (operators) or the portal (drivers). */
export type WebauthnRealm = 'operator' | 'driver';

/**
 * What a challenge was issued for, and for whom. A driver challenge never
 * answers an operator ceremony and the reverse: the owner key differs, and a
 * passkey sign-in names its realm.
 */
export type WebauthnChallengeRecord =
  | (WebauthnChallengeOwner & { purpose: 'registration'; userHandle: string })
  | (WebauthnChallengeOwner & { purpose: Exclude<WebauthnAccountPurpose, 'registration'> })
  | { purpose: 'passkey_login'; realm: WebauthnRealm };

/** Whether a challenge was issued for this purpose and this account. */
export function isChallengeFor<P extends WebauthnAccountPurpose>(
  record: WebauthnChallengeRecord | null,
  purpose: P,
  owner: WebauthnChallengeOwner,
): record is Extract<WebauthnChallengeRecord, { purpose: P }> & WebauthnChallengeOwner {
  if (record?.purpose !== purpose) return false;
  if ('userId' in owner) return 'userId' in record && record.userId === owner.userId;
  return 'driverId' in record && record.driverId === owner.driverId;
}

/** Whether a challenge was issued for a passkey sign-in of this realm. */
export function isPasskeyLoginChallenge(
  record: WebauthnChallengeRecord | null,
  realm: WebauthnRealm,
): boolean {
  return record?.purpose === 'passkey_login' && record.realm === realm;
}

const ACCOUNT_PURPOSES: readonly string[] = ['second_factor', 'recovery_regenerate', 'factor_add'];

/** A stored challenge record, or null for anything this build does not know. */
export function parseWebauthnChallengeRecord(raw: string): WebauthnChallengeRecord | null {
  const value = tryParseJson(raw);
  if (value == null || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (rec['purpose'] === 'passkey_login') {
    return rec['realm'] === 'operator' || rec['realm'] === 'driver'
      ? { purpose: 'passkey_login', realm: rec['realm'] }
      : null;
  }
  let owner: WebauthnChallengeOwner;
  if (typeof rec['userId'] === 'string' && rec['driverId'] == null) {
    owner = { userId: rec['userId'] };
  } else if (typeof rec['driverId'] === 'string' && rec['userId'] == null) {
    owner = { driverId: rec['driverId'] };
  } else {
    return null;
  }
  const purpose = rec['purpose'];
  if (purpose === 'registration') {
    return typeof rec['userHandle'] === 'string'
      ? { ...owner, purpose, userHandle: rec['userHandle'] }
      : null;
  }
  if (typeof purpose === 'string' && ACCOUNT_PURPOSES.includes(purpose)) {
    return { ...owner, purpose: purpose as Exclude<WebauthnAccountPurpose, 'registration'> };
  }
  return null;
}
