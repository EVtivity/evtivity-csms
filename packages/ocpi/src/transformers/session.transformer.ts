// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TaxLine } from '@evtivity/lib/price-display';
import { toOcpiPrice } from '../lib/ocpi-price.js';
import { chargingPeriods, cdrToken, whToKwh } from '../lib/charging-periods.js';
import type { CdrTokenSource } from '../lib/charging-periods.js';
import type { OcpiAuthMethod, OcpiSession, OcpiSessionStatus, OcpiVersion } from '../types/ocpi.js';

interface SessionRow {
  id: string;
  status: 'active' | 'completed' | 'invalid' | 'faulted' | 'failed';
  startedAt: Date | null;
  endedAt: Date | null;
  updatedAt: Date;
  energyDeliveredWh: string | null;
  currency: string;
}

interface SessionTransformInput {
  session: SessionRow;
  /**
   * The OCPI Session id, as stored on the CPO session link
   * (`ocpi_roaming_sessions.ocpi_session_id`). Unique for the CPO.
   */
  ocpiSessionId: string;
  /**
   * The session cost split into net and tax (`ocpiSessionCost`): the final
   * cost once completed, the running cost before. Null when not known yet,
   * which omits total_cost.
   */
  cost: TaxLine[] | null;
  /** Idle minutes (EV connected, not charging) up to the session end or `now`. */
  idleMinutes: number;
  /** The time the volumes of a running session are read at. */
  now: Date;
  countryCode: string;
  partyId: string;
  locationId: string;
  evseUid: string;
  connectorId: string;
  token: CdrTokenSource;
  /**
   * How the token was authorized (`ocpi_roaming_sessions.auth_method`):
   * COMMAND for a StartSession, WHITELIST for a token the partner pushed.
   * Null on links written before it was stored: WHITELIST, since the CSMS
   * never sends a real-time authorization request (AUTH_REQUEST).
   */
  authMethod?: string | null;
  /** The eMSP's authorization_reference from the StartSession. */
  authorizationReference?: string | null;
}

/** The OCPI AuthMethod of a stored link value (OCPI 2.3.0 10.4.1). */
export function ocpiAuthMethod(value: string | null | undefined): OcpiAuthMethod {
  return value === 'COMMAND' || value === 'AUTH_REQUEST' ? value : 'WHITELIST';
}

const SESSION_STATUS_MAP: Record<string, OcpiSessionStatus> = {
  active: 'ACTIVE',
  completed: 'COMPLETED',
  invalid: 'INVALID',
  faulted: 'INVALID',
  failed: 'INVALID',
};

export function transformSession(input: SessionTransformInput, version: OcpiVersion): OcpiSession {
  const { session, countryCode, partyId, locationId, evseUid, connectorId } = input;

  const kwh = whToKwh(session.energyDeliveredWh);
  const status = SESSION_STATUS_MAP[session.status] ?? 'ACTIVE';

  const result: OcpiSession = {
    country_code: countryCode,
    party_id: partyId,
    id: input.ocpiSessionId,
    start_date_time: (session.startedAt ?? session.updatedAt).toISOString(),
    kwh,
    cdr_token: cdrToken(input.token),
    auth_method: ocpiAuthMethod(input.authMethod),
    ...(input.authorizationReference != null
      ? { authorization_reference: input.authorizationReference }
      : {}),
    location_id: locationId,
    evse_uid: evseUid,
    connector_id: connectorId,
    currency: session.currency,
    charging_periods:
      session.startedAt != null
        ? chargingPeriods({
            startedAt: session.startedAt,
            endedAt: session.endedAt ?? input.now,
            kwh,
            idleMinutes: input.idleMinutes,
          })
        : [],
    status,
    last_updated: session.updatedAt.toISOString(),
  };

  if (session.endedAt != null) {
    result.end_date_time = session.endedAt.toISOString();
  }

  // total_cost is the Price class of the version: excl_vat (net) and incl_vat
  // (the amount charged) in 2.2.1, before_taxes and taxes in 2.3.0.
  if (input.cost != null) {
    result.total_cost = toOcpiPrice(input.cost, version);
  }

  return result;
}
