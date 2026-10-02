// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, chargingSessions, chargingStations, evses, guestSessions } from '@evtivity/database';
import type { FastifyBaseLogger } from 'fastify';
import { sendOcppCommandAndWait } from '../lib/ocpp-command.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { getActiveMaintenanceForStation } from './maintenance.service.js';

/** How long an authorized payment waits for the station to start the transaction. */
const PAYMENT_TTL_MS = 15 * 60 * 1000;

export interface AdHocPaymentStart {
  /** OCPP identity of the charging station. */
  stationId: string;
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

export type AdHocPaymentResult =
  | { ok: true; replayed: boolean }
  | { ok: false; status: 400 | 404 | 409 | 502 | 504; code: string; error: string };

function isUniqueViolation(err: unknown): boolean {
  return err != null && typeof err === 'object' && 'code' in err && err.code === '23505';
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
 */
export async function startAdHocPayment(
  input: AdHocPaymentStart,
  userId: string,
  logger: FastifyBaseLogger,
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

  const siteIds = await getUserSiteIds(userId);
  if (
    station == null ||
    (siteIds != null && (station.siteId == null || !siteIds.includes(station.siteId)))
  ) {
    return { ok: false, status: 404, code: 'STATION_NOT_FOUND', error: 'Station not found' };
  }
  if (!station.isOnline) {
    return { ok: false, status: 400, code: 'STATION_OFFLINE', error: 'Station is offline' };
  }
  // DirectPayment idTokens and transaction limits exist only in OCPP 2.1.
  if (station.ocppProtocol !== 'ocpp2.1') {
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

  const [evse] = await db
    .select({ id: evses.id })
    .from(evses)
    .where(and(eq(evses.stationId, station.id), eq(evses.evseId, input.evseId)));
  if (evse == null) {
    return { ok: false, status: 404, code: 'EVSE_NOT_FOUND', error: 'EVSE not found' };
  }

  const existing = await findPayment(input.pspRef);
  if (existing != null) return replayOrConflict(existing, input);

  const [activeSession] = await db
    .select({ id: chargingSessions.id })
    .from(chargingSessions)
    .where(and(eq(chargingSessions.evseId, evse.id), eq(chargingSessions.status, 'active')))
    .limit(1);
  if (activeSession != null) {
    return {
      ok: false,
      status: 409,
      code: 'EVSE_IN_USE',
      error: 'Another session is already active on this connector',
    };
  }

  try {
    await db.insert(guestSessions).values({
      stationOcppId: input.stationId,
      evseId: input.evseId,
      guestEmail: input.email ?? '',
      status: 'payment_authorized',
      sessionToken: input.pspRef,
      expiresAt: new Date(Date.now() + PAYMENT_TTL_MS),
      maxCostCents: input.maxCostCents ?? null,
      maxEnergyWh: input.maxEnergyWh ?? null,
      maxTimeSeconds: input.maxTimeSeconds ?? null,
    });
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
    evseId: input.evseId,
    remoteStartId: crypto.randomInt(1, 2_147_483_647),
    idToken: {
      idToken: input.pspRef,
      type: 'DirectPayment',
      ...(additionalInfo.length > 0 ? { additionalInfo } : {}),
    },
  });

  const cmdStatus = cmdResult.response?.['status'] as string | undefined;
  if (cmdResult.error != null || cmdStatus !== 'Accepted') {
    // The station did not start: drop the payment so the terminal can retry or
    // void the authorization.
    await db.delete(guestSessions).where(eq(guestSessions.sessionToken, input.pspRef));
    logger.warn(
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

  return { ok: true, replayed: false };
}

interface StoredPayment {
  stationOcppId: string;
  evseId: number;
}

async function findPayment(pspRef: string): Promise<StoredPayment | null> {
  const [row] = await db
    .select({ stationOcppId: guestSessions.stationOcppId, evseId: guestSessions.evseId })
    .from(guestSessions)
    .where(eq(guestSessions.sessionToken, pspRef));
  return row ?? null;
}

function replayOrConflict(existing: StoredPayment, input: AdHocPaymentStart): AdHocPaymentResult {
  if (existing.stationOcppId === input.stationId && existing.evseId === input.evseId) {
    return { ok: true, replayed: true };
  }
  return {
    ok: false,
    status: 409,
    code: 'TOKEN_DUPLICATE',
    error: 'This payment reference is already used for another EVSE',
  };
}
