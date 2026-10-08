// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The shared authorize pipeline. `authorizeToken` decides whether a token may
 * charge, with no side effects; `recordAuthorizeDecision` writes the decision
 * to the authorize attempts log. Steps, in order: free vend, token types
 * accepted without lookup, identity resolution (driver tokens, then the drv_
 * driver id fallback where the context has it and, for an untyped 1.6 idTag,
 * the guest session fallback), OCPI external tokens, the concurrent
 * transaction check, prepaid credit, the fleet credit limit of a driver who
 * charges on account. The per-context differences live in
 * AUTHORIZE_CONTEXT_RULES.
 */

import { eq, and, ne, or } from 'drizzle-orm';
import {
  client,
  db,
  loadDriverAccountCredit,
  driverTokens,
  drivers,
  ocpiExternalTokens,
  chargingSessions,
  chargingStations,
  guestSessions,
  isRoamingEnabled,
  isSiteFreeVendEnabledByStation,
} from '@evtivity/database';
import type { Logger } from '@evtivity/lib';
import { logAuthorizeAttempt, parseOcpiValidThru } from './authorize-log.js';
import { prepaidCredit } from './prepaid.js';
import {
  authorizeContextRules,
  type AuthorizeContextRules,
  type AuthorizeDecision,
  type AuthorizeTokenInput,
} from './authorize-context.js';

const NO_MATCH = {
  matchedTokenId: null,
  matchedDriverId: null,
  expiresAt: null,
  prepaid: false,
  prepaidBalanceCents: null,
  echoGroupId: false,
} as const;

/** The authorize reason of a driver whose billing fleet has no credit left (plan S8). */
export const ACCOUNT_CREDIT_LIMIT_REASON = 'account_credit_limit';

/** The token type logged for an untyped (1.6) idTag, as the 1.6 handlers name it in events. */
const UNTYPED_LOG_TOKEN_TYPE = 'ISO14443';

export async function authorizeToken(
  input: AuthorizeTokenInput,
  logger: Logger,
): Promise<AuthorizeDecision> {
  const rules = authorizeContextRules(input);
  const log = { stationId: input.stationId, idToken: input.token.value, context: input.context };

  if (await isFreeVend(input, rules, logger)) {
    return freeVendDecision(input, rules, logger);
  }

  const type = input.token.type;
  const noLookup = type != null ? rules.noLookupTypes.get(type) : undefined;
  if (noLookup != null) {
    return { ...NO_MATCH, status: 'accepted', outcome: 'accepted', ...noLookup };
  }

  let decision: AuthorizeDecision;
  try {
    decision =
      type == null
        ? await resolveUntyped(input, rules, logger)
        : await resolveTyped(input, type, rules, logger);
  } catch (err) {
    // Fail-open: a station must not be refused because the CSMS database is
    // unreachable. The outcome db_error records the security event.
    logger[rules.dbErrorLogLevel]({ err, ...log }, 'Token lookup failed; accepting by default');
    return {
      ...NO_MATCH,
      status: 'accepted',
      outcome: 'db_error',
      reason: 'db_unreachable',
      source: 'db_error',
    };
  }

  decision = await checkConcurrentTransaction(input, rules, decision, logger);
  decision = applyPrepaidCredit(decision);
  return checkAccountCredit(input, rules, decision, logger);
}

/**
 * Writes the decision to the authorize attempts log. Fire-and-forget: it
 * returns at once, so the database insert never delays the response the
 * station waits for, and a failure is logged, never thrown. An untyped idTag
 * is logged as ISO14443.
 */
export function recordAuthorizeDecision(
  input: AuthorizeTokenInput,
  decision: AuthorizeDecision,
  logger: Logger,
): void {
  const tokenType = input.token.type ?? UNTYPED_LOG_TOKEN_TYPE;
  logAuthorizeAttempt(
    {
      stationId: input.stationId,
      idToken: input.token.value,
      tokenType,
      matchedTokenId: decision.matchedTokenId,
      matchedDriverId: decision.matchedDriverId,
      outcome: decision.outcome,
      ocppVersion: input.ocppVersion,
      reason: decision.reason,
    },
    logger,
  ).catch((err: unknown) => {
    logger.warn(
      { err, stationId: input.stationId, idToken: input.token.value },
      'Recording the authorize attempt failed; the decision stands',
    );
  });
}

/** The info log line that names how a decision was reached. */
export function authorizeDecisionMessage(decision: AuthorizeDecision): string {
  if (decision.source === 'free_vend') return 'Free vend site, accepting';
  if (decision.status === 'concurrent_tx') return 'Token rejected: concurrent transaction';
  if (decision.source === 'ocpi') return `OCPI external token ${decision.status}`;
  if (decision.source === 'not_found') return 'Token not found';
  if (decision.source === 'db_error') return 'Token lookup failed, accepting by default';
  if (decision.source === 'driver_id') {
    return decision.status === 'accepted' ? 'Driver-id token accepted' : 'Driver-id token blocked';
  }
  if (decision.source === 'guest') return `Guest session token ${decision.status}`;
  if (decision.reason === ACCOUNT_CREDIT_LIMIT_REASON) return 'Fleet credit limit reached';
  if (decision.status === 'no_credit') return 'Prepaid token without credit';
  if (decision.status !== 'accepted') return 'Token rejected by status';
  return 'Token accepted';
}

/** One info log line per decision, for the adapters. */
export function logAuthorizeDecision(
  input: AuthorizeTokenInput,
  decision: AuthorizeDecision,
  logger: Logger,
): void {
  logger.info(
    {
      stationId: input.stationId,
      idToken: input.token.value,
      tokenType: input.token.type,
      context: input.context,
      status: decision.status,
      source: decision.source,
      reason: decision.reason,
    },
    `${authorizeDecisionMessage(decision)} (${input.ocppVersion})`,
  );
}

async function isFreeVend(
  input: AuthorizeTokenInput,
  rules: AuthorizeContextRules,
  logger: Logger,
): Promise<boolean> {
  if (rules.freeVendReadError === 'throw') {
    return isSiteFreeVendEnabledByStation(input.stationId);
  }
  try {
    return await isSiteFreeVendEnabledByStation(input.stationId);
  } catch (err) {
    // A transaction message must not fail on a settings read: check the token.
    logger.warn(
      { err, stationId: input.stationId, idToken: input.token.value },
      'Free vend setting read failed; checking the token',
    );
    return false;
  }
}

async function freeVendDecision(
  input: AuthorizeTokenInput,
  rules: AuthorizeContextRules,
  logger: Logger,
): Promise<AuthorizeDecision> {
  let matchedTokenId: string | null = null;
  let matchedDriverId: string | null = null;
  if (rules.freeVend === 'match_token') {
    // Best-effort match so the attempts log links a free vend swipe to a
    // registered driver. A failure does not block the accept.
    try {
      const [row] = await db
        .select({ id: driverTokens.id, driverId: driverTokens.driverId })
        .from(driverTokens)
        .where(tokenCondition(input));
      if (row != null) {
        matchedTokenId = row.id;
        matchedDriverId = row.driverId ?? null;
      }
    } catch (err) {
      logger.warn(
        { err, stationId: input.stationId, idToken: input.token.value },
        'Free vend token match failed; accepting without a match',
      );
    }
  }
  return {
    ...NO_MATCH,
    status: 'accepted',
    outcome: 'accepted',
    reason: 'free_vend',
    source: 'free_vend',
    matchedTokenId,
    matchedDriverId,
  };
}

function tokenCondition(input: AuthorizeTokenInput): ReturnType<typeof eq> | undefined {
  const byValue = eq(driverTokens.idToken, input.token.value);
  return input.token.type == null
    ? byValue
    : and(byValue, eq(driverTokens.tokenType, input.token.type));
}

const TOKEN_COLUMNS = {
  id: driverTokens.id,
  driverId: driverTokens.driverId,
  isActive: driverTokens.isActive,
  expiresAt: driverTokens.expiresAt,
  revokedAt: driverTokens.revokedAt,
  prepaidBalanceCents: driverTokens.prepaidBalanceCents,
};

interface TokenRow {
  id: string;
  driverId: string | null;
  isActive: boolean;
  expiresAt: Date | null;
  revokedAt: Date | null;
  prepaidBalanceCents: number | null;
}

/** `revoked` when the token was revoked, else `inactive`. */
function blockedReason(row: TokenRow | undefined): string {
  return row?.revokedAt != null ? 'revoked' : 'inactive';
}

function isExpired(row: TokenRow, now: Date): boolean {
  return row.expiresAt != null && row.expiresAt.getTime() <= now.getTime();
}

function isBlocked(row: TokenRow): boolean {
  return !row.isActive || row.revokedAt != null;
}

/**
 * The rejection of driver token rows none of which is usable (each is blocked,
 * expired, or both), in the context's precedence: `expired_first` expires when
 * any row is expired and else blocks the first row; `blocked_first` blocks when
 * any row is inactive or revoked and else expires.
 */
function rejectRows(
  rows: readonly TokenRow[],
  rules: AuthorizeContextRules,
  now: Date,
): AuthorizeDecision {
  const expired = rows.find((r) => isExpired(r, now));
  const blocked = rows.find(isBlocked);
  if (rules.rejectPrecedence === 'expired_first' ? expired != null : blocked == null) {
    return rejectedToken(expired, 'expired', 'expired_at');
  }
  const row = rules.rejectPrecedence === 'expired_first' ? rows[0] : blocked;
  return rejectedToken(row, 'blocked', blockedReason(row));
}

function acceptedToken(row: TokenRow, echoGroupId: boolean): AuthorizeDecision {
  return {
    status: 'accepted',
    outcome: 'accepted',
    reason: 'active',
    source: 'driver_token',
    matchedTokenId: row.id,
    matchedDriverId: row.driverId ?? null,
    expiresAt: row.expiresAt,
    prepaid: false,
    prepaidBalanceCents: row.prepaidBalanceCents ?? null,
    echoGroupId,
  };
}

function rejectedToken(
  row: TokenRow | undefined,
  status: 'blocked' | 'expired',
  reason: string,
): AuthorizeDecision {
  return {
    ...NO_MATCH,
    status,
    outcome: status,
    reason,
    source: 'driver_token',
    matchedTokenId: row?.id ?? null,
    matchedDriverId: row?.driverId ?? null,
  };
}

/**
 * An OCPP 1.6 idTag: every driver token with this value (the same value may
 * exist with several token types), then the drv_ driver id, the guest session
 * of this station, and OCPI.
 */
async function resolveUntyped(
  input: AuthorizeTokenInput,
  rules: AuthorizeContextRules,
  logger: Logger,
): Promise<AuthorizeDecision> {
  const idTag = input.token.value;
  const tokens: TokenRow[] = await db
    .select(TOKEN_COLUMNS)
    .from(driverTokens)
    .where(eq(driverTokens.idToken, idTag));

  if (tokens.length > 0) {
    const now = new Date();
    const usable = tokens.find((t) => !isBlocked(t) && !isExpired(t, now));
    if (usable != null) return acceptedToken(usable, false);
    return rejectRows(tokens, rules, now);
  }

  const byDriverId = await resolveDriverId(input, rules);
  if (byDriverId != null) return byDriverId;

  // Guest session token, scoped to this station so a token issued for one
  // charger cannot be replayed at another.
  if (rules.guestAcceptedStatuses != null) {
    const [guest] = await db
      .select({ status: guestSessions.status })
      .from(guestSessions)
      .where(
        and(
          eq(guestSessions.sessionToken, idTag),
          eq(guestSessions.stationOcppId, input.stationId),
        ),
      )
      .limit(1);
    if (guest != null) {
      return rules.guestAcceptedStatuses.has(guest.status)
        ? {
            ...NO_MATCH,
            status: 'accepted',
            outcome: 'accepted',
            reason: 'guest_session',
            source: 'guest',
          }
        : {
            ...NO_MATCH,
            status: 'blocked',
            outcome: 'blocked',
            reason: `guest_${guest.status}`,
            source: 'guest',
          };
    }
  }

  return notFound(input, rules, logger);
}

/** An OCPP 2.1 IdToken: the one driver token with this value and type. */
async function resolveTyped(
  input: AuthorizeTokenInput,
  type: string,
  rules: AuthorizeContextRules,
  logger: Logger,
): Promise<AuthorizeDecision> {
  const [token]: TokenRow[] = await db
    .select(TOKEN_COLUMNS)
    .from(driverTokens)
    .where(and(eq(driverTokens.idToken, input.token.value), eq(driverTokens.tokenType, type)));

  if (token == null) {
    const byDriverId = await resolveDriverId(input, rules);
    if (byDriverId != null) return byDriverId;
    if (!rules.acceptWhenNotFound.has(type)) return notFound(input, rules, logger);
    return {
      ...NO_MATCH,
      status: 'accepted',
      outcome: 'accepted',
      reason: 'accept_when_not_found',
      source: 'accept_when_not_found',
      echoGroupId: true,
    };
  }

  const now = new Date();
  if (isBlocked(token) || isExpired(token, now)) return rejectRows([token], rules, now);
  return acceptedToken(token, true);
}

/** The 2.1 token type the CSMS sends a driver id as (portal remote start). */
const DRIVER_ID_TOKEN_TYPE = 'Central';

/**
 * Portal remote start: the CSMS sends the driver id (drv_*) as the token, a
 * 1.6 idTag or a 2.1 Central token. Null when the context has no driver id
 * fallback, the token is typed but not Central, the value is not a driver id,
 * or no driver has it. A typed token echoes groupIdToken when accepted.
 */
async function resolveDriverId(
  input: AuthorizeTokenInput,
  rules: AuthorizeContextRules,
): Promise<AuthorizeDecision | null> {
  if (!rules.driverIdFallback || !input.token.value.startsWith('drv_')) return null;
  if (input.token.type != null && input.token.type !== DRIVER_ID_TOKEN_TYPE) return null;
  const [driver] = await db
    .select({ id: drivers.id, isActive: drivers.isActive })
    .from(drivers)
    .where(eq(drivers.id, input.token.value))
    .limit(1);
  if (driver == null) return null;
  return driver.isActive
    ? {
        ...NO_MATCH,
        status: 'accepted',
        outcome: 'accepted',
        reason: 'driver_id',
        source: 'driver_id',
        matchedDriverId: driver.id,
        echoGroupId: input.token.type != null,
      }
    : {
        ...NO_MATCH,
        status: 'blocked',
        outcome: 'blocked',
        reason: 'driver_inactive',
        source: 'driver_id',
        matchedDriverId: driver.id,
      };
}

/**
 * No driver token matched: an OCPI external token when the context checks
 * them and roaming is on, else Invalid. OCPI 2.2.1 permits the token when
 * `is_valid`, `whitelist` is not NEVER (NEVER requires real-time
 * authorization, which the CSMS does not perform), and any `valid_thru` is in
 * the future.
 */
async function notFound(
  input: AuthorizeTokenInput,
  rules: AuthorizeContextRules,
  logger: Logger,
): Promise<AuthorizeDecision> {
  const invalid: AuthorizeDecision = {
    ...NO_MATCH,
    status: 'invalid',
    outcome: 'unknown',
    reason: 'token_not_found',
    source: 'not_found',
  };
  if (!rules.ocpi || !(await isRoamingEnabled())) return invalid;

  let external: { isValid: boolean; whitelist: string; tokenData: unknown } | undefined;
  try {
    [external] = await db
      .select({
        isValid: ocpiExternalTokens.isValid,
        whitelist: ocpiExternalTokens.whitelist,
        tokenData: ocpiExternalTokens.tokenData,
      })
      .from(ocpiExternalTokens)
      .where(eq(ocpiExternalTokens.uid, input.token.value))
      .limit(1);
  } catch (err) {
    // Expected on an install whose OCPI tables do not exist: debug, not warn.
    logger.debug(
      { err, stationId: input.stationId, idToken: input.token.value },
      'OCPI external token lookup failed; treating the token as not found',
    );
  }
  if (external == null) return invalid;

  const validThru = parseOcpiValidThru(external.tokenData);
  if (validThru != null && validThru.getTime() <= Date.now()) {
    return {
      ...NO_MATCH,
      status: 'expired',
      outcome: 'expired',
      reason: 'ocpi_external_valid_thru_expired',
      source: 'ocpi',
    };
  }
  const allowed = external.isValid && external.whitelist !== 'NEVER';
  return allowed
    ? {
        ...NO_MATCH,
        status: 'accepted',
        outcome: 'accepted',
        reason: 'ocpi_external',
        source: 'ocpi',
      }
    : {
        ...NO_MATCH,
        status: 'blocked',
        outcome: 'blocked',
        reason: `ocpi_external_${external.whitelist.toLowerCase()}`,
        source: 'ocpi',
      };
}

/**
 * A driver token already in an active session gets ConcurrentTx. Only an
 * accepted driver token is checked: the other sources do not write
 * `charging_sessions.token_id`. The session of the message's own transaction
 * at this station is not counted, matched by the station row id or, when the
 * context has none, by the station's OCPP id. A failed lookup keeps the
 * decision.
 */
async function checkConcurrentTransaction(
  input: AuthorizeTokenInput,
  rules: AuthorizeContextRules,
  decision: AuthorizeDecision,
  logger: Logger,
): Promise<AuthorizeDecision> {
  if (
    rules.concurrentTx === 'off' ||
    (rules.concurrentTx === 'prepaid_only' && decision.prepaidBalanceCents == null) ||
    decision.status !== 'accepted' ||
    decision.matchedTokenId == null
  ) {
    return decision;
  }
  try {
    // The context has no station row id when its station lookup missed:
    // resolve it here so the own transaction is still excluded.
    let ownStationDbId = input.stationDbId;
    if (input.transactionId != null && ownStationDbId == null) {
      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.stationId, input.stationId))
        .limit(1);
      ownStationDbId = station?.id ?? null;
    }
    const [active] = await db
      .select({ id: chargingSessions.id })
      .from(chargingSessions)
      .where(
        and(
          eq(chargingSessions.tokenId, decision.matchedTokenId),
          eq(chargingSessions.status, 'active'),
          input.transactionId != null && ownStationDbId != null
            ? or(
                ne(chargingSessions.stationId, ownStationDbId),
                ne(chargingSessions.transactionId, input.transactionId),
              )
            : undefined,
        ),
      )
      .limit(1);
    if (active == null) return decision;
    return {
      ...decision,
      status: 'concurrent_tx',
      outcome: 'concurrent_tx',
      reason: `concurrent_session ${active.id}`,
      echoGroupId: false,
    };
  } catch (err) {
    logger.warn(
      { err, stationId: input.stationId, idToken: input.token.value },
      'Concurrent transaction lookup failed; keeping the decision',
    );
    return decision;
  }
}

/**
 * Prepaid token (OCPP 2.1 C17): an accepted token with a prepaid balance is
 * marked prepaid, and becomes no_credit when the balance is not positive.
 */
function applyPrepaidCredit(decision: AuthorizeDecision): AuthorizeDecision {
  if (decision.status !== 'accepted') return decision;
  const credit = prepaidCredit(decision.prepaidBalanceCents);
  if (credit === 'not_prepaid') return decision;
  if (credit === 'credit') return { ...decision, prepaid: true };
  return {
    ...decision,
    prepaid: true,
    status: 'no_credit',
    outcome: 'no_credit',
    reason: 'no_credit',
    echoGroupId: false,
  };
}

/**
 * Fleet credit limit (plan S8): a driver who charges on account with a fleet
 * that has a credit limit. With `refuse` (Authorize) an accepted token that
 * is not prepaid becomes no_credit when the fleet has no credit left: its
 * exposure, with the running sessions at their reserved ceiling, is at the
 * limit (2.1 NoCredit, 1.6 Blocked). Otherwise, and with `annotate` (2.1
 * TransactionEvent Started), the decision names the fleet. Read without the
 * fleet row lock: nothing is reserved here; the payment gate reserves the
 * session's ceiling and stops a start without credit. A failed lookup keeps
 * the decision (logged at warn): the gate checks again.
 */
async function checkAccountCredit(
  input: AuthorizeTokenInput,
  rules: AuthorizeContextRules,
  decision: AuthorizeDecision,
  logger: Logger,
): Promise<AuthorizeDecision> {
  if (
    rules.accountCredit === 'off' ||
    decision.status !== 'accepted' ||
    decision.prepaid ||
    decision.matchedDriverId == null
  ) {
    return decision;
  }
  try {
    const credit = await loadDriverAccountCredit(client, decision.matchedDriverId);
    if (credit == null) return decision;
    if (rules.accountCredit === 'refuse' && credit.remainingCents <= 0) {
      return {
        ...decision,
        status: 'no_credit',
        outcome: 'no_credit',
        reason: ACCOUNT_CREDIT_LIMIT_REASON,
        echoGroupId: false,
      };
    }
    return { ...decision, accountFleetId: credit.fleetId };
  } catch (err) {
    logger.warn(
      { err, stationId: input.stationId, idToken: input.token.value },
      'Fleet credit limit lookup failed; keeping the decision',
    );
    return decision;
  }
}
