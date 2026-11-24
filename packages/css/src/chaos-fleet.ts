// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { OCTT_TEST_DRIVER_EMAIL } from '@evtivity/lib';
import { isOcpp21, isOcpp2x, type OcppProtocol } from '@evtivity/lib/ocpp-version';

// Share of chaos session starts at a public station that use a demo fleet's card
// or a member token of a fleet that bills on account.
export const FLEET_SESSION_SHARE = 0.125;

// Back-off of a card the CSMS refused (credit limit, monthly limit, blocked):
// the first refusal parks it for the base, each further one in a row doubles it.
export const FLEET_REFUSAL_BACKOFF_MS = 15 * 60_000;
export const FLEET_REFUSAL_BACKOFF_MAX_MS = 4 * 3_600_000;

// A start whose result has not come back by then is forgotten.
export const FLEET_START_RESULT_TTL_MS = 5 * 60_000;

// Card types a station reader presents; app, contract and system tokens never start here.
const CARD_TOKEN_TYPES: ReadonlySet<string> = new Set([
  'ISO14443',
  'ISO15693',
  'Local',
  'Central',
  'KeyCode',
]);

// OCPP 1.6 idTag is CiString20; 2.0.1 IdToken is 36 characters.
const MAX_ID_TAG_16 = 20;
const MAX_ID_TOKEN_201 = 36;

/** A token of a fleet that bills on account, and the fleet its sessions are billed to. */
export interface FleetToken {
  idToken: string;
  tokenType: string;
  fleetId: string;
}

/** A candidate row of the fleet pool query: the token, its driver and its fleets. */
export interface FleetTokenRow {
  id_token: string;
  token_type: string;
  is_active: boolean;
  revoked_at: Date | string | null;
  expires_at: Date | string | null;
  prepaid_balance_cents: number | null;
  card_fleet_id: string | null;
  card_fleet_bills: boolean;
  member_fleet_id: string | null;
  driver_id: string | null;
  driver_active: boolean | null;
  driver_erased_at: Date | string | null;
  driver_email: string | null;
  depot_only: boolean;
}

function passed(value: Date | string | null, now: number): boolean {
  if (value == null) return false;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return !Number.isNaN(ms) && ms <= now;
}

/**
 * The fleet a candidate token charges to, or null when chaos must not use it:
 * an inactive, revoked or expired token, a prepaid one, a token of an inactive,
 * erased or OCTT driver, a fleet card its fleet cannot bill, a member token
 * without an account billing fleet, or a driver who charges at the depot only.
 * A fleet card bills its own fleet, held by a member or not.
 */
export function fleetOfToken(
  row: FleetTokenRow,
  fleetsEnabled: boolean,
  now: number,
): string | null {
  if (!fleetsEnabled) return null;
  if (!row.is_active || row.revoked_at != null || passed(row.expires_at, now)) return null;
  if (row.prepaid_balance_cents != null) return null;
  if (row.driver_id != null) {
    if (row.driver_active !== true || row.driver_erased_at != null) return null;
    if (row.driver_email === OCTT_TEST_DRIVER_EMAIL) return null;
  }
  if (row.depot_only) return null;
  if (row.card_fleet_id != null) return row.card_fleet_bills ? row.card_fleet_id : null;
  return row.member_fleet_id;
}

/** Whether a station of the protocol can present the token. */
export function tokenFitsProtocol(token: FleetToken, protocol: OcppProtocol): boolean {
  if (!CARD_TOKEN_TYPES.has(token.tokenType)) return false;
  if (!isOcpp2x(protocol)) return token.idToken.length <= MAX_ID_TAG_16;
  if (isOcpp21(protocol)) return true;
  return token.idToken.length <= MAX_ID_TOKEN_201;
}

/** A css command result, as the simulator manager reports it. */
export interface CssCommandResult {
  commandId: string;
  success: boolean;
  error?: string;
}

/** The simulator's refusal of a start whose Authorize the CSMS did not accept. */
export function isAuthorizationRefusal(error: string | undefined): boolean {
  return error?.startsWith('Authorization rejected') === true;
}

interface BackOff {
  refusals: number;
  until: number;
}

/**
 * Which chaos starts use a fleet token and which token, and the back-off of
 * cards the CSMS refused. Pure apart from the random source.
 */
export class FleetCharging {
  private readonly random: () => number;
  private tokens: FleetToken[] = [];
  private readonly backOffs = new Map<string, BackOff>();
  private readonly pendingStarts = new Map<string, { idToken: string; at: number }>();

  constructor(random: () => number = Math.random) {
    this.random = random;
  }

  setTokens(tokens: FleetToken[]): void {
    this.tokens = tokens;
    const live = new Set(tokens.map((t) => t.idToken));
    for (const idToken of [...this.backOffs.keys()]) {
      if (!live.has(idToken)) this.backOffs.delete(idToken);
    }
  }

  get size(): number {
    return this.tokens.length;
  }

  /** Every token of the fleet pool, eligible or not right now. */
  tokenValues(): Set<string> {
    return new Set(this.tokens.map((t) => t.idToken));
  }

  isBackedOff(idToken: string, now: number): boolean {
    const b = this.backOffs.get(idToken);
    return b != null && b.until > now;
  }

  /**
   * The fleet token of a start, or null for a start with the public pool: one
   * draw of the share, then a token the station can present that is not
   * charging elsewhere (`busy`) and not backed off.
   */
  pick(protocol: OcppProtocol, busy: ReadonlySet<string>, now: number): FleetToken | null {
    if (this.tokens.length === 0) return null;
    if (this.random() >= FLEET_SESSION_SHARE) return null;
    const free = this.tokens.filter(
      (t) =>
        !busy.has(t.idToken) && !this.isBackedOff(t.idToken, now) && tokenFitsProtocol(t, protocol),
    );
    if (free.length === 0) return null;
    return free[Math.floor(this.random() * free.length)] ?? null;
  }

  /** Remembers a published fleet start until its result comes back. */
  trackStart(commandId: string, idToken: string, now: number): void {
    for (const [id, p] of this.pendingStarts) {
      if (now - p.at > FLEET_START_RESULT_TTL_MS) this.pendingStarts.delete(id);
    }
    this.pendingStarts.set(commandId, { idToken, at: now });
  }

  /**
   * Applies the result of a tracked start: an authorization refusal backs the
   * card off and returns it (so the caller frees it), a success clears its
   * back-off. Other failures (cable, busy connector) say nothing about the card.
   */
  onResult(result: CssCommandResult, now: number): string | null {
    const pending = this.pendingStarts.get(result.commandId);
    if (pending == null) return null;
    this.pendingStarts.delete(result.commandId);
    if (result.success) {
      this.backOffs.delete(pending.idToken);
      return null;
    }
    if (!isAuthorizationRefusal(result.error)) return null;
    const refusals = (this.backOffs.get(pending.idToken)?.refusals ?? 0) + 1;
    const delay = Math.min(
      FLEET_REFUSAL_BACKOFF_MS * 2 ** (refusals - 1),
      FLEET_REFUSAL_BACKOFF_MAX_MS,
    );
    this.backOffs.set(pending.idToken, { refusals, until: now + delay });
    return pending.idToken;
  }
}
