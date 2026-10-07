// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Version-neutral types of the shared authorize pipeline and the one table of
 * per-context rules. The OCPP 1.6 and 2.1 handlers are adapters over
 * `authorizeToken` (authorize-token.ts): they turn the request into an
 * `AuthorizeTokenInput` and the `AuthorizeDecision` into their protocol's
 * response. Nothing here imports generated OCPP types.
 */

import type { AuthorizeOutcome } from './authorize-log.js';

/** Why the token is checked: an Authorize request, a transaction start, or a later transaction event. */
export type AuthorizeContext = 'authorize' | 'tx_start' | 'tx_update';

export type AuthorizeOcppVersion = 'ocpp1.6' | 'ocpp2.1';

export interface AuthorizeTokenInput {
  stationId: string;
  /** Not read by the pipeline today: a seam for authorize hooks and per-station rules. */
  stationDbId: string | null;
  /** Not read by the pipeline today: a seam for authorize hooks and per-EVSE rules. */
  evseId: number | null;
  /** `type` is null for an OCPP 1.6 idTag, which has no token type. */
  token: { value: string; type: string | null };
  context: AuthorizeContext;
  ocppVersion: AuthorizeOcppVersion;
  /** A session the concurrent transaction check ignores (a resent 1.6 StartTransaction). */
  excludeSessionId?: string | null;
}

export type AuthorizeStatus =
  | 'accepted'
  | 'blocked'
  | 'expired'
  | 'invalid'
  | 'no_credit'
  | 'concurrent_tx';

export type AuthorizeSource =
  | 'free_vend'
  | 'driver_token'
  | 'driver_id'
  | 'guest'
  | 'ocpi'
  | 'no_lookup_type'
  | 'accept_when_not_found'
  | 'no_authorization'
  | 'not_found'
  | 'db_error';

export interface AuthorizeDecision {
  status: AuthorizeStatus;
  /** The `authorize_attempts.outcome` value. */
  outcome: AuthorizeOutcome;
  /** The `authorize_attempts.reason` value. */
  reason: string | null;
  source: AuthorizeSource;
  matchedTokenId: string | null;
  matchedDriverId: string | null;
  /**
   * The matched token's expiry, set when a usable driver token matched. It
   * stays set when a later step (ConcurrentTx, prepaid) changes the status, so
   * adapters send it only for an accepted decision.
   */
  expiresAt: Date | null;
  /** True when the accepted token is prepaid (with or without credit). */
  prepaid: boolean;
  prepaidBalanceCents: number | null;
  /** The 2.1 response echoes the token as groupIdToken. */
  echoGroupId: boolean;
}

/**
 * The rules of one context for one kind of token. `untyped` applies to an
 * OCPP 1.6 idTag (no token type), `typed` to an OCPP 2.1 IdToken.
 */
export interface AuthorizeContextRules {
  /** Free vend accepts any token, with or without a best-effort driver token match for the log. */
  freeVend: 'match_token' | 'no_match';
  /**
   * A failed free vend setting read: `throw` fails the message (the station
   * retries it), `check_token` logs a warning and checks the token as on a
   * site without free vend.
   */
  freeVendReadError: 'throw' | 'check_token';
  /** Token types accepted without any lookup, with the source, reason and groupIdToken echo they get. */
  noLookupTypes: ReadonlyMap<
    string,
    { source: 'no_lookup_type' | 'no_authorization'; reason: string; echoGroupId: boolean }
  >;
  /** For a token that is both blocked and expired (or rows of both kinds): which rejection wins. */
  rejectPrecedence: 'expired_first' | 'blocked_first';
  /** Typed tokens: the types accepted when no driver token matches (CSMS-issued or station-local tokens). */
  acceptWhenNotFound: ReadonlySet<string>;
  /**
   * The drv_ driver id fallback, checked when no driver token matches: any 1.6
   * idTag, a 2.1 token of type Central (the type the CSMS sends a driver id as).
   */
  driverIdFallback: boolean;
  /** Untyped tokens: the guest session statuses accepted by the guest fallback, or no fallback. */
  guestAcceptedStatuses: ReadonlySet<string> | null;
  /** OCPI external tokens are checked (when roaming is enabled). */
  ocpi: boolean;
  /** Level of the log for a failed token lookup (the token is accepted). */
  dbErrorLogLevel: 'error' | 'warn';
  /** ConcurrentTx check for an accepted driver token. */
  concurrentTx: boolean;
}

const NO_LOOKUP_NONE: AuthorizeContextRules['noLookupTypes'] = new Map();
const NONE: ReadonlySet<never> = new Set();

const UNTYPED_BASE: Omit<
  AuthorizeContextRules,
  'freeVend' | 'freeVendReadError' | 'driverIdFallback' | 'guestAcceptedStatuses' | 'ocpi'
> = {
  noLookupTypes: NO_LOOKUP_NONE,
  // A token that is both revoked or inactive and expired is Blocked, as in
  // 2.1: the operator's revocation is the stronger, sticky state (P5).
  rejectPrecedence: 'blocked_first',
  acceptWhenNotFound: NONE,
  dbErrorLogLevel: 'error',
  concurrentTx: true,
};

// TransactionEvent (2.1): every event carrying an idToken, Started or not.
const TYPED_TRANSACTION: AuthorizeContextRules = {
  // A station that skips Authorize sends the token here first: free vend
  // must accept it as Authorize does.
  freeVend: 'match_token',
  freeVendReadError: 'check_token',
  noLookupTypes: NO_LOOKUP_NONE,
  rejectPrecedence: 'blocked_first',
  // Any other unknown token is Invalid: the CSMS checks the authorization
  // status of the idToken of a TransactionEvent (C12.FR.03). The CSMS issues
  // Central tokens (portal, reservation and guest starts) and DirectPayment
  // tokens (ad hoc payments, C24/C25) that are not driver tokens.
  acceptWhenNotFound: new Set([
    'Central',
    'Local',
    'DirectPayment',
    'MasterPass',
    'NoAuthorization',
  ]),
  driverIdFallback: true,
  guestAcceptedStatuses: null,
  ocpi: true,
  dbErrorLogLevel: 'warn',
  concurrentTx: false,
};

// StartTransaction (1.6). No 1.6 message checks a token in tx_update; the row
// repeats tx_start so the table is total.
const UNTYPED_TRANSACTION: AuthorizeContextRules = {
  ...UNTYPED_BASE,
  freeVend: 'no_match',
  freeVendReadError: 'throw',
  driverIdFallback: true,
  guestAcceptedStatuses: new Set(['payment_authorized', 'charging']),
  ocpi: true,
};

/**
 * The authorize rules per context and token kind. The logged outcome and
 * reason values are the same in every context (`authorize-token.ts`).
 */
export const AUTHORIZE_CONTEXT_RULES: Readonly<
  Record<
    AuthorizeContext,
    Readonly<{ untyped: AuthorizeContextRules; typed: AuthorizeContextRules }>
  >
> = {
  authorize: {
    // Authorize (1.6)
    untyped: {
      ...UNTYPED_BASE,
      freeVend: 'match_token',
      freeVendReadError: 'throw',
      driverIdFallback: true,
      guestAcceptedStatuses: new Set(['payment_authorized']),
      ocpi: true,
    },
    // Authorize (2.1)
    typed: {
      freeVend: 'match_token',
      freeVendReadError: 'throw',
      noLookupTypes: new Map([
        ['MasterPass', { source: 'no_lookup_type', reason: 'no_lookup_type', echoGroupId: true }],
        [
          'DirectPayment',
          { source: 'no_lookup_type', reason: 'no_lookup_type', echoGroupId: true },
        ],
        [
          'NoAuthorization',
          { source: 'no_authorization', reason: 'no_authorization', echoGroupId: false },
        ],
      ]),
      rejectPrecedence: 'blocked_first',
      acceptWhenNotFound: new Set(['Central', 'Local']),
      driverIdFallback: true,
      guestAcceptedStatuses: null,
      ocpi: true,
      dbErrorLogLevel: 'error',
      concurrentTx: true,
    },
  },
  tx_start: { untyped: UNTYPED_TRANSACTION, typed: TYPED_TRANSACTION },
  tx_update: { untyped: UNTYPED_TRANSACTION, typed: TYPED_TRANSACTION },
};

export function authorizeContextRules(input: AuthorizeTokenInput): AuthorizeContextRules {
  const row = AUTHORIZE_CONTEXT_RULES[input.context];
  return input.token.type == null ? row.untyped : row.typed;
}
