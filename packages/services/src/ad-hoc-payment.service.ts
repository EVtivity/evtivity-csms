// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  evses,
  guestSessions,
  pgErrorCode,
  PG_UNIQUE_VIOLATION,
  stationAuditLog,
  writeAudit,
  type AuditActor,
} from '@evtivity/database';
import { isOcpp21 } from '@evtivity/lib/ocpp-version';
import { sendOcppCommandAndWait } from './ocpp-command.js';
import { getActiveMaintenanceForStation } from './maintenance.service.js';

/** How long an authorized payment waits for the station to start the transaction. */
const PAYMENT_TTL_MS = 15 * 60 * 1000;

export interface AdHocPaymentStart {
  /** OCPP identity of the charging station. */
  stationId: string;
  /**
   * EVSE the payment is for. 0 is a station-wide start (a station-wide payment
   * terminal without a connector pick): RequestStartTransaction goes without
   * an evseId and the station starts on the connector the driver plugs in.
   */
  evseId: number;
  /** PSP reference of the authorized payment. Sent as the DirectPayment idToken. */
  pspRef: string;
  cardLast4Digits?: string | undefined;
  cardBin?: string | undefined;
  /** Authorized amount (cost ceiling) in cents of the company currency. */
  maxCostCents?: number | undefined;
  maxEnergyWh?: number | undefined;
  maxTimeSeconds?: number | undefined;
  /** Receipt address of the EV driver, when the payment provider passed one. */
  email?: string | undefined;
}

export interface AdHocPaymentAccess {
  /** False for a station outside the caller's sites (answered as not found). */
  siteAllowed: (siteId: string | null) => boolean;
  actor: {
    actor: AuditActor;
    actorUserId: string | null;
    actorDriverId: string | null;
    actorApiKeyId: string | null;
    actorLabel: string | null;
  };
  logger: {
    warn: (obj: unknown, msg?: string) => void;
  };
  /**
   * A CSMS payment terminal (features/payment-terminals.md): the guest
   * session token is a CSMS token of 20 random hex characters (the 1.6 idTag
   * length, and the portal receipt link), sent as a DirectPayment idToken to
   * an OCPP 2.1 station and as a Central idToken to a 1.6 or 2.0.1 station,
   * whose idToken types have no DirectPayment; the guest session fallback
   * authorizes it there and the CSMS ceiling stops the transaction at the
   * hold. Without it a station must use OCPP 2.1 and the token is the pspRef.
   */
  terminalToken?: boolean;
}

export type AdHocPaymentResult =
  | { ok: true; replayed: boolean; guestSessionId: number; token: string }
  | { ok: false; status: 400 | 404 | 409 | 502 | 504; code: string; error: string };

function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === PG_UNIQUE_VIOLATION;
}

/**
 * Starts a transaction for an ad hoc payment that a stand-alone payment
 * terminal or a payment service provider authorized (OCPP 2.1 C24, C25). The
 * payment is stored as a guest session whose token is the PSP reference, then
 * RequestStartTransaction is sent with idToken = { pspRef, DirectPayment } and
 * the card details as additionalInfo (C24.FR.01, C25.FR.23). The stored limit
 * is returned to the station when the transaction starts (C24.FR.02,
 * C25.FR.24), and the guest session lifecycle links and completes it.
 *
 * A retried request with the same pspRef for the same EVSE is a no-op replay,
 * so a payment terminal can retry safely without starting a second transaction.
 * Shared by the API route and the payment terminal flow (API and worker), so
 * it lives here (P8).
 */
export async function startAdHocPayment(
  input: AdHocPaymentStart,
  access: AdHocPaymentAccess,
): Promise<AdHocPaymentResult> {
  const [station] = await db
    .select({
      id: chargingStations.id,
      siteId: chargingStations.siteId,
      isOnline: chargingStations.isOnline,
      ocppProtocol: chargingStations.ocppProtocol,
    })
    .from(chargingStations)
    .where(eq(chargingStations.stationId, input.stationId));

  if (station == null || !access.siteAllowed(station.siteId)) {
    return { ok: false, status: 404, code: 'STATION_NOT_FOUND', error: 'Station not found' };
  }
  if (!station.isOnline) {
    return { ok: false, status: 400, code: 'STATION_OFFLINE', error: 'Station is offline' };
  }
  const directPayment = isOcpp21(station.ocppProtocol);
  // DirectPayment idTokens and transaction limits exist only in OCPP 2.1.
  if (!directPayment && access.terminalToken !== true) {
    return {
      ok: false,
      status: 400,
      code: 'OCPP_VERSION_MISMATCH',
      error: 'Ad hoc payments need a station that uses OCPP 2.1',
    };
  }

  const maintenance = await getActiveMaintenanceForStation(station.id);
  if (maintenance != null) {
    return {
      ok: false,
      status: 409,
      code: 'MAINTENANCE_ACTIVE',
      error: 'Site is currently under maintenance',
    };
  }

  const stationWide = input.evseId === 0;
  let evseRowId: string | null = null;
  if (!stationWide) {
    const [evse] = await db
      .select({ id: evses.id })
      .from(evses)
      .where(and(eq(evses.stationId, station.id), eq(evses.evseId, input.evseId)));
    if (evse == null) {
      return { ok: false, status: 404, code: 'EVSE_NOT_FOUND', error: 'EVSE not found' };
    }
    evseRowId = evse.id;
  }

  const existing = await findPayment(input.pspRef);
  if (existing != null) return replayOrConflict(existing, input);

  if (evseRowId != null) {
    const [activeSession] = await db
      .select({ id: chargingSessions.id })
      .from(chargingSessions)
      .where(and(eq(chargingSessions.evseId, evseRowId), eq(chargingSessions.status, 'active')))
      .limit(1);
    if (activeSession != null) {
      return {
        ok: false,
        status: 409,
        code: 'EVSE_IN_USE',
        error: 'Another session is already active on this connector',
      };
    }
  }

  const token =
    access.terminalToken === true ? crypto.randomBytes(10).toString('hex') : input.pspRef;
  let guestSessionId: number;
  try {
    const [row] = await db
      .insert(guestSessions)
      .values({
        stationOcppId: input.stationId,
        evseId: input.evseId,
        guestEmail: input.email ?? '',
        status: 'payment_authorized',
        // The terminal holds the payment: the payment gate counts this as the hold.
        paymentTerminal: true,
        sessionToken: token,
        expiresAt: new Date(Date.now() + PAYMENT_TTL_MS),
        maxCostCents: input.maxCostCents ?? null,
        maxEnergyWh: input.maxEnergyWh ?? null,
        maxTimeSeconds: input.maxTimeSeconds ?? null,
      })
      .returning({ id: guestSessions.id });
    if (row == null) throw new Error('Guest session insert returned no row');
    guestSessionId = row.id;
  } catch (err) {
    // A concurrent request with the same pspRef won the insert.
    if (!isUniqueViolation(err)) throw err;
    const raced = await findPayment(input.pspRef);
    if (raced != null) return replayOrConflict(raced, input);
    throw err;
  }

  const additionalInfo = [
    ...(input.cardLast4Digits != null
      ? [{ additionalIdToken: input.cardLast4Digits, type: 'CardLast4Digits' }]
      : []),
    ...(input.cardBin != null ? [{ additionalIdToken: input.cardBin, type: 'CardBin' }] : []),
  ];
  const cmdResult = await sendOcppCommandAndWait(input.stationId, 'RequestStartTransaction', {
    ...(stationWide ? {} : { evseId: input.evseId }),
    remoteStartId: crypto.randomInt(1, 2_147_483_647),
    idToken: directPayment
      ? {
          idToken: token,
          type: 'DirectPayment',
          ...(additionalInfo.length > 0 ? { additionalInfo } : {}),
        }
      : { idToken: token, type: 'Central' },
  });

  const cmdStatus = cmdResult.response?.['status'] as string | undefined;
  // The start sent for the payment, as the operator command routes audit it.
  // No card data: the PSP reference and the limits only.
  await writeAudit(
    { table: stationAuditLog, idColumn: 'station_id' },
    {
      entityId: station.id,
      entityIdSnapshot: station.id,
      action: 'command_dispatched',
      ...access.actor,
      notes: `RequestStartTransaction for ad hoc payment (${cmdResult.error != null ? 'Timeout' : (cmdStatus ?? 'Unknown')})`,
      after: {
        action: 'RequestStartTransaction',
        evseId: stationWide ? null : input.evseId,
        pspRef: input.pspRef,
        maxCostCents: input.maxCostCents ?? null,
        maxEnergyWh: input.maxEnergyWh ?? null,
        maxTimeSeconds: input.maxTimeSeconds ?? null,
        outcome: cmdResult.error != null ? 'Timeout' : (cmdStatus ?? 'Unknown'),
      },
    },
    db,
    access.logger,
  );
  if (cmdResult.error != null || cmdStatus !== 'Accepted') {
    // The station did not start: drop the payment so the terminal can retry or
    // void the authorization. Only a row no transaction linked meanwhile.
    await db
      .delete(guestSessions)
      .where(and(eq(guestSessions.id, guestSessionId), isNull(guestSessions.chargingSessionId)));
    access.logger.warn(
      { stationId: input.stationId, evseId: input.evseId, error: cmdResult.error, cmdStatus },
      'Ad hoc payment start failed',
    );
    if (cmdResult.error != null) {
      return { ok: false, status: 504, code: 'STATION_TIMEOUT', error: 'Station did not respond' };
    }
    return {
      ok: false,
      status: 502,
      code: 'STATION_REJECTED',
      error: `Station rejected start: ${cmdStatus ?? 'Unknown'}`,
    };
  }

  return { ok: true, replayed: false, guestSessionId, token };
}

interface StoredPayment {
  id: number;
  stationOcppId: string;
  evseId: number;
  sessionToken: string;
}

/**
 * The stored payment of a pspRef (token = pspRef). A terminal start has a
 * CSMS token, so its replay is caught by the terminal transaction's start
 * claim instead (claimTerminalStart).
 */
async function findPayment(pspRef: string): Promise<StoredPayment | null> {
  const [row] = await db
    .select({
      id: guestSessions.id,
      stationOcppId: guestSessions.stationOcppId,
      evseId: guestSessions.evseId,
      sessionToken: guestSessions.sessionToken,
    })
    .from(guestSessions)
    .where(eq(guestSessions.sessionToken, pspRef));
  return row ?? null;
}

function replayOrConflict(existing: StoredPayment, input: AdHocPaymentStart): AdHocPaymentResult {
  if (existing.stationOcppId === input.stationId && existing.evseId === input.evseId) {
    return { ok: true, replayed: true, guestSessionId: existing.id, token: existing.sessionToken };
  }
  return {
    ok: false,
    status: 409,
    code: 'TOKEN_DUPLICATE',
    error: 'This payment reference is already used for another EVSE',
  };
}
