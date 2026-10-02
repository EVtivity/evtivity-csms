// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Prepaid tokens (OCPP 2.1 C17). A token with a non-null
 * `driver_tokens.prepaid_balance_cents` is prepaid: Authorize answers Accepted
 * while the balance is positive and NoCredit otherwise, always with
 * cacheExpiryDateTime set to now so the station does not cache the token
 * (C17.FR.01, C17.FR.02). The TransactionEventResponse carries the remaining
 * credit as transactionLimit.maxCost (C17.FR.03).
 */

export type PrepaidCredit = 'not_prepaid' | 'credit' | 'no_credit';

export function prepaidCredit(balanceCents: number | null | undefined): PrepaidCredit {
  if (balanceCents == null) return 'not_prepaid';
  return balanceCents > 0 ? 'credit' : 'no_credit';
}

/** Remaining credit in major currency units, as OCPP transactionLimit.maxCost expects. */
export function prepaidMaxCost(balanceCents: number): number {
  return balanceCents / 100;
}

// The time of the last prepaid Authorize decision per station and token, so the
// TransactionEventResponse that follows repeats the AuthorizeResponse's
// cacheExpiryDateTime (OCTT TC_C_103 step 4). A station keeps its WebSocket on
// one OCPP server process, so both messages reach this process.
const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const MAX_REMEMBERED = 10_000;
const authorizedAt = new Map<string, { at: string; expiresAt: number }>();

function key(stationId: string, idToken: string): string {
  return `${stationId}\u0000${idToken}`;
}

/**
 * Returns the cacheExpiryDateTime for a prepaid Authorize response (now) and
 * remembers it for the TransactionEventResponse of the same station and token.
 */
export function rememberPrepaidAuthorization(
  stationId: string,
  idToken: string,
  now: Date = new Date(),
): string {
  const at = now.toISOString();
  const nowMs = now.getTime();
  if (authorizedAt.size >= MAX_REMEMBERED) {
    for (const [k, v] of authorizedAt) {
      if (v.expiresAt <= nowMs) authorizedAt.delete(k);
    }
    if (authorizedAt.size >= MAX_REMEMBERED) {
      const oldest = authorizedAt.keys().next().value;
      if (oldest != null) authorizedAt.delete(oldest);
    }
  }
  authorizedAt.set(key(stationId, idToken), { at, expiresAt: nowMs + AUTHORIZATION_TTL_MS });
  return at;
}

/**
 * cacheExpiryDateTime for a prepaid TransactionEventResponse: the time of the
 * preceding Authorize at this station, or now when the station did not
 * authorize first (local authorization) or the decision has aged out.
 */
export function prepaidCacheExpiry(
  stationId: string,
  idToken: string,
  now: Date = new Date(),
): string {
  const remembered = authorizedAt.get(key(stationId, idToken));
  if (remembered != null && remembered.expiresAt > now.getTime()) return remembered.at;
  return now.toISOString();
}

/** Test helper. */
export function clearPrepaidAuthorizations(): void {
  authorizedAt.clear();
}
