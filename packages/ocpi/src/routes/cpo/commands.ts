// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { eq, and, lte, gte, sql, asc } from 'drizzle-orm';
import {
  db,
  chargingStations,
  chargingSessions,
  connectors,
  ocpiLocationPublish,
  ocpiExternalTokens,
  ocpiRoamingSessions,
  maintenanceEvents,
  isStationLevelUnavailable,
} from '@evtivity/database';
import type { StationLevelState } from '@evtivity/database';
import { createLogger, isPrivateUrl } from '@evtivity/lib';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../../lib/ocpi-response.js';
import { ocpiAuthenticate } from '../../middleware/ocpi-auth.js';
import { isLocationVisibleToPartner } from '../../lib/location-visibility.js';
import { findEvseByUid } from '../../lib/evse-lookup.js';
import { getCommandCallbackService } from '../../services/command-callback.service.js';
import type {
  OcpiVersion,
  OcpiStartSession,
  OcpiStopSession,
  OcpiReserveNow,
  OcpiCancelReservation,
  OcpiUnlockConnector,
  OcpiCommandResponse,
} from '../../types/ocpi.js';

const logger = createLogger('ocpi-cpo-commands');
const COMMAND_TIMEOUT = 30;

/**
 * Reject response_url values that point at our own internal network. A
 * malicious partner could otherwise use the OCPI command callback channel
 * as an SSRF probe (we POST the OCPP result back to whatever URL they
 * supplied). Returns true when the URL is safe to call back.
 */
function isAcceptableResponseUrl(url: string): boolean {
  return !isPrivateUrl(url);
}

// Resolve a partner-supplied `location_id` to our internal site UUID, but
// only when the partner has been granted visibility to it. Without the
// partner-scoped publish check, an authenticated partner could issue
// START_SESSION / RESERVE_NOW / UNLOCK_CONNECTOR against ANY site (even
// unpublished ones) by guessing its UUID or OCPI location id. The free
// "fall back to site UUID" path that used to exist here was the same data
// leak we patched in cpo/locations.ts for the GET endpoints.
async function resolveSiteId(locationId: string, partnerId: string): Promise<string | null> {
  // Check if there's a publish entry with a custom OCPI location ID OR
  // the raw siteId. We honour both because OCPI partners may use either
  // form depending on how they integrated.
  const [publish] = await db
    .select({ siteId: ocpiLocationPublish.siteId })
    .from(ocpiLocationPublish)
    .where(
      and(
        eq(ocpiLocationPublish.isPublished, true),
        sql`(${ocpiLocationPublish.ocpiLocationId} = ${locationId} OR ${ocpiLocationPublish.siteId} = ${locationId})`,
      ),
    )
    .limit(1);

  if (publish == null) return null;

  if (!(await isLocationVisibleToPartner(partnerId, publish.siteId))) {
    return null;
  }
  return publish.siteId;
}

interface MaintenanceCoverage {
  allAffected: boolean;
  affectedStationIds: Set<string>;
}

async function getMaintenanceCoverage(siteId: string): Promise<MaintenanceCoverage> {
  const now = new Date();
  const rows = await db
    .select({ affectedStationIds: maintenanceEvents.affectedStationIds })
    .from(maintenanceEvents)
    .where(
      and(
        eq(maintenanceEvents.siteId, siteId),
        eq(maintenanceEvents.status, 'active'),
        lte(maintenanceEvents.plannedStartAt, now),
        gte(maintenanceEvents.plannedEndAt, now),
      ),
    );
  const coverage: MaintenanceCoverage = { allAffected: false, affectedStationIds: new Set() };
  for (const r of rows) {
    const f = r.affectedStationIds;
    if (f == null || f.length === 0) coverage.allAffected = true;
    else for (const id of f) coverage.affectedStationIds.add(id);
  }
  return coverage;
}

function isCovered(coverage: MaintenanceCoverage, stationDbId: string): boolean {
  return coverage.allAffected || coverage.affectedStationIds.has(stationDbId);
}

interface ResolvedStation {
  stationDbId: string;
  stationId: string;
  stationState: StationLevelState;
  evseDbId?: string;
  evseNumber?: number;
}

// Without an EVSE uid, pick the first station at the site that can start a
// session, so one disabled or maintained station does not block the site.
// When none can, return the first one and let the caller's gates reject it.
async function findStationForSite(
  siteId: string,
  evseUid: string | undefined,
  coverage: MaintenanceCoverage,
): Promise<ResolvedStation | null> {
  if (evseUid != null) {
    // The uid identifies one EVSE; it must belong to a station at this site.
    const found = await findEvseByUid(evseUid);
    if (found?.siteId !== siteId) return null;
    return {
      stationDbId: found.stationDbId,
      stationId: found.stationOcppId,
      stationState: found.stationState,
      evseDbId: found.evseDbId,
      evseNumber: found.evseNumber,
    };
  }

  const stations = await db
    .select({
      stationDbId: chargingStations.id,
      stationId: chargingStations.stationId,
      disabledReason: chargingStations.disabledReason,
      firmwareState: chargingStations.firmwareState,
      reportedStatus: chargingStations.reportedStatus,
    })
    .from(chargingStations)
    .where(eq(chargingStations.siteId, siteId))
    .orderBy(asc(chargingStations.stationId));

  const station =
    stations.find((s) => !isStationLevelUnavailable(s) && !isCovered(coverage, s.stationDbId)) ??
    stations[0];
  if (station == null) return null;
  const { stationDbId, stationId, disabledReason, firmwareState, reportedStatus } = station;
  return {
    stationDbId,
    stationId,
    stationState: { disabledReason, firmwareState, reportedStatus },
  };
}

// A maintenance window, a disable, a firmware install, or a station-level fault
// rejects a start or reservation for every EVSE on the station.
function canStartOn(station: ResolvedStation, coverage: MaintenanceCoverage): boolean {
  return (
    !isCovered(coverage, station.stationDbId) && !isStationLevelUnavailable(station.stationState)
  );
}

async function findConnectorId(evseDbId: string, connectorIdStr: string): Promise<number | null> {
  const connectorIdNum = Number(connectorIdStr);
  if (Number.isNaN(connectorIdNum)) return null;

  const [connector] = await db
    .select({ connectorId: connectors.connectorId })
    .from(connectors)
    .where(and(eq(connectors.evseId, evseDbId), eq(connectors.connectorId, connectorIdNum)))
    .limit(1);

  return connector?.connectorId ?? null;
}

function registerCpoCommandRoutes(app: FastifyInstance, version: OcpiVersion): void {
  const prefix = `/ocpi/${version}/cpo/commands`;

  // POST /ocpi/{version}/cpo/commands/START_SESSION
  app.post(`${prefix}/START_SESSION`, { onRequest: [ocpiAuthenticate] }, async (request, reply) => {
    const partner = request.ocpiPartner;
    if (partner?.partnerId == null) {
      await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
      return;
    }

    const raw = request.body as Record<string, unknown> | null;
    if (
      raw == null ||
      typeof raw['response_url'] !== 'string' ||
      raw['token'] == null ||
      typeof raw['token'] !== 'object' ||
      typeof raw['location_id'] !== 'string'
    ) {
      await reply
        .status(400)
        .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid StartSession command'));
      return;
    }
    const body = raw as unknown as OcpiStartSession;

    // Validate token. Scope by partnerId so partner A cannot start a
    // session using partner B's token uid (cross-partner token leak).
    const tokenUid = body.token.uid;
    const [token] = await db
      .select({ isValid: ocpiExternalTokens.isValid })
      .from(ocpiExternalTokens)
      .where(
        and(
          eq(ocpiExternalTokens.partnerId, partner.partnerId),
          eq(ocpiExternalTokens.uid, tokenUid),
        ),
      )
      .limit(1);

    if (token == null || !token.isValid) {
      const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
      return ocpiSuccess(response);
    }

    // Resolve location
    const siteId = await resolveSiteId(body.location_id, partner.partnerId);
    if (siteId == null) {
      const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
      return ocpiSuccess(response);
    }

    const coverage = await getMaintenanceCoverage(siteId);
    const station = await findStationForSite(siteId, body.evse_uid, coverage);
    if (station == null || !canStartOn(station, coverage)) {
      const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
      return ocpiSuccess(response);
    }

    // Build OCPP payload
    const ocppPayload: Record<string, unknown> = {
      idTag: tokenUid,
      remoteStartId: Math.floor(Math.random() * 2_147_483_647),
    };
    if (station.evseDbId != null) {
      const evseNum = station.evseNumber;
      if (evseNum != null) {
        ocppPayload['evseId'] = evseNum;
      }
    }
    if (body.connector_id != null && station.evseDbId != null) {
      const connId = await findConnectorId(station.evseDbId, body.connector_id);
      if (connId != null) {
        ocppPayload['connectorId'] = connId;
      }
    }

    if (!isAcceptableResponseUrl(body.response_url)) {
      return ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'response_url is not allowed');
    }

    // Dispatch OCPP command
    const callbackService = getCommandCallbackService();
    const commandId = callbackService.generateCommandId();
    callbackService.registerCommand(
      commandId,
      body.response_url,
      partner.partnerId,
      'START_SESSION',
    );
    await callbackService.dispatchOcppCommand(
      commandId,
      station.stationId,
      'RequestStartTransaction',
      ocppPayload,
    );

    const response: OcpiCommandResponse = { result: 'ACCEPTED', timeout: COMMAND_TIMEOUT };
    return ocpiSuccess(response);
  });

  // POST /ocpi/{version}/cpo/commands/STOP_SESSION
  app.post(`${prefix}/STOP_SESSION`, { onRequest: [ocpiAuthenticate] }, async (request, reply) => {
    const partner = request.ocpiPartner;
    if (partner?.partnerId == null) {
      await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
      return;
    }

    const body = request.body as OcpiStopSession | null;
    if (
      body == null ||
      typeof body.response_url !== 'string' ||
      typeof body.session_id !== 'string'
    ) {
      await reply
        .status(400)
        .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid StopSession command'));
      return;
    }

    // Look up roaming session to find the charging session
    const [session] = await db
      .select({
        chargingSessionId: ocpiRoamingSessions.chargingSessionId,
      })
      .from(ocpiRoamingSessions)
      .where(
        and(
          eq(ocpiRoamingSessions.partnerId, partner.partnerId),
          eq(ocpiRoamingSessions.ocpiSessionId, body.session_id),
        ),
      )
      .limit(1);

    if (session == null) {
      const response: OcpiCommandResponse = {
        result: 'UNKNOWN_SESSION',
        timeout: COMMAND_TIMEOUT,
      };
      return ocpiSuccess(response);
    }

    if (session.chargingSessionId == null) {
      const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
      return ocpiSuccess(response);
    }

    const [chargingSession] = await db
      .select({
        stationId: chargingStations.stationId,
        transactionId: chargingSessions.transactionId,
      })
      .from(chargingSessions)
      .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
      .where(eq(chargingSessions.id, session.chargingSessionId))
      .limit(1);

    if (chargingSession == null) {
      const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
      return ocpiSuccess(response);
    }

    if (!isAcceptableResponseUrl(body.response_url)) {
      return ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'response_url is not allowed');
    }

    // Dispatch OCPP command
    const callbackService = getCommandCallbackService();
    const commandId = callbackService.generateCommandId();
    callbackService.registerCommand(
      commandId,
      body.response_url,
      partner.partnerId,
      'STOP_SESSION',
    );
    await callbackService.dispatchOcppCommand(
      commandId,
      chargingSession.stationId,
      'RequestStopTransaction',
      { transactionId: chargingSession.transactionId },
    );

    const response: OcpiCommandResponse = { result: 'ACCEPTED', timeout: COMMAND_TIMEOUT };
    return ocpiSuccess(response);
  });

  // POST /ocpi/{version}/cpo/commands/RESERVE_NOW
  app.post(`${prefix}/RESERVE_NOW`, { onRequest: [ocpiAuthenticate] }, async (request, reply) => {
    const partner = request.ocpiPartner;
    if (partner?.partnerId == null) {
      await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
      return;
    }

    const raw = request.body as Record<string, unknown> | null;
    if (
      raw == null ||
      typeof raw['response_url'] !== 'string' ||
      raw['token'] == null ||
      typeof raw['token'] !== 'object' ||
      typeof raw['expiry_date'] !== 'string' ||
      typeof raw['reservation_id'] !== 'string' ||
      typeof raw['location_id'] !== 'string'
    ) {
      await reply
        .status(400)
        .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid ReserveNow command'));
      return;
    }
    const body = raw as unknown as OcpiReserveNow;

    // Validate token. Scope by partnerId for the same reason as
    // START_SESSION (cross-partner token leak).
    const tokenUid = body.token.uid;
    const [token] = await db
      .select({ isValid: ocpiExternalTokens.isValid })
      .from(ocpiExternalTokens)
      .where(
        and(
          eq(ocpiExternalTokens.partnerId, partner.partnerId),
          eq(ocpiExternalTokens.uid, tokenUid),
        ),
      )
      .limit(1);

    if (token == null || !token.isValid) {
      const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
      return ocpiSuccess(response);
    }

    // Resolve location
    const siteId = await resolveSiteId(body.location_id, partner.partnerId);
    if (siteId == null) {
      const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
      return ocpiSuccess(response);
    }

    const coverage = await getMaintenanceCoverage(siteId);
    const station = await findStationForSite(siteId, body.evse_uid, coverage);
    if (station == null || !canStartOn(station, coverage)) {
      const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
      return ocpiSuccess(response);
    }

    // Build OCPP payload
    const ocppPayload: Record<string, unknown> = {
      id: Number(body.reservation_id) || 1,
      expiryDateTime: body.expiry_date,
      idToken: { idToken: tokenUid, type: 'ISO14443' },
    };
    if (station.evseDbId != null) {
      const evseNum = station.evseNumber;
      if (evseNum != null) {
        ocppPayload['evseId'] = evseNum;
      }
    }

    if (!isAcceptableResponseUrl(body.response_url)) {
      return ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'response_url is not allowed');
    }

    // Dispatch OCPP command
    const callbackService = getCommandCallbackService();
    const commandId = callbackService.generateCommandId();
    callbackService.registerCommand(commandId, body.response_url, partner.partnerId, 'RESERVE_NOW');
    await callbackService.dispatchOcppCommand(
      commandId,
      station.stationId,
      'ReserveNow',
      ocppPayload,
    );

    const response: OcpiCommandResponse = { result: 'ACCEPTED', timeout: COMMAND_TIMEOUT };
    return ocpiSuccess(response);
  });

  // POST /ocpi/{version}/cpo/commands/CANCEL_RESERVATION
  app.post(
    `${prefix}/CANCEL_RESERVATION`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      const body = request.body as OcpiCancelReservation | null;
      if (
        body == null ||
        typeof body.response_url !== 'string' ||
        typeof body.reservation_id !== 'string'
      ) {
        await reply
          .status(400)
          .send(
            ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid CancelReservation command'),
          );
        return;
      }

      // Fail closed: we have no per-partner ownership mapping for
      // reservations. The reservations table has no partner_id column, and
      // RESERVE_NOW does not pre-create a row, so a lookup by the integer
      // OCPP reservation_id alone would let partner A cancel partner B's
      // (or worse, a local operator's) reservation by guessing the
      // integer. Until a partner-ownership table is added, reject every
      // OCPI CANCEL_RESERVATION. Honest synchronous response so the
      // partner can degrade gracefully.
      logger.warn(
        { partnerId: partner.partnerId, reservationId: body.reservation_id },
        'CANCEL_RESERVATION rejected: per-partner reservation ownership not tracked',
      );
      const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
      return ocpiSuccess(response);
    },
  );

  // POST /ocpi/{version}/cpo/commands/UNLOCK_CONNECTOR
  app.post(
    `${prefix}/UNLOCK_CONNECTOR`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(401).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not authenticated'));
        return;
      }

      const body = request.body as OcpiUnlockConnector | null;
      if (
        body == null ||
        typeof body.response_url !== 'string' ||
        typeof body.location_id !== 'string' ||
        typeof body.evse_uid !== 'string' ||
        typeof body.connector_id !== 'string'
      ) {
        await reply
          .status(400)
          .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid UnlockConnector command'));
        return;
      }

      // Resolve location and EVSE
      const siteId = await resolveSiteId(body.location_id, partner.partnerId);
      if (siteId == null) {
        const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
        return ocpiSuccess(response);
      }

      // The uid identifies one EVSE; it must belong to a station at this site.
      const found = await findEvseByUid(body.evse_uid);
      if (found?.siteId !== siteId) {
        const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
        return ocpiSuccess(response);
      }

      const evseNum = found.evseNumber;
      const connectorNum = Number(body.connector_id);

      if (Number.isNaN(connectorNum)) {
        const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
        return ocpiSuccess(response);
      }

      if (!isAcceptableResponseUrl(body.response_url)) {
        return ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'response_url is not allowed');
      }

      // Dispatch OCPP command
      const callbackService = getCommandCallbackService();
      const commandId = callbackService.generateCommandId();
      callbackService.registerCommand(
        commandId,
        body.response_url,
        partner.partnerId,
        'UNLOCK_CONNECTOR',
      );
      await callbackService.dispatchOcppCommand(commandId, found.stationOcppId, 'UnlockConnector', {
        evseId: evseNum,
        connectorId: connectorNum,
      });

      const response: OcpiCommandResponse = { result: 'ACCEPTED', timeout: COMMAND_TIMEOUT };
      return ocpiSuccess(response);
    },
  );
}

export function cpoCommandRoutes(app: FastifyInstance): void {
  registerCpoCommandRoutes(app, '2.2.1');
  registerCpoCommandRoutes(app, '2.3.0');
}
