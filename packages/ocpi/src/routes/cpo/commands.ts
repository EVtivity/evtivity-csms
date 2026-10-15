// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq, and, lte, gte, asc, desc, isNull, isNotNull } from 'drizzle-orm';
import {
  db,
  chargingStations,
  chargingSessions,
  connectors,
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
import { findPublishedSiteId } from '../../lib/published-location.js';
import { findEvseByUid } from '../../lib/evse-lookup.js';
import { getCommandCallbackService } from '../../services/command-callback.service.js';
import type {
  OcpiVersion,
  OcpiToken,
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
 * supplied). A partner with the operator's private-network flag may use a
 * private address. This is the URL-only check; the callback itself goes
 * through safeFetch, which checks the resolved addresses at connect time.
 * Returns true when the URL is acceptable.
 */
function isAcceptableResponseUrl(url: string, allowPrivateNetwork: boolean): boolean {
  if (!allowPrivateNetwork) return !isPrivateUrl(url);
  const parsed = URL.parse(url);
  return parsed != null && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
}

// Resolve a partner-supplied `location_id` to our internal site UUID, but
// only when the partner has been granted visibility to it. Without the
// partner-scoped publish check, an authenticated partner could issue
// START_SESSION / RESERVE_NOW / UNLOCK_CONNECTOR against ANY site (even
// unpublished ones) by guessing its UUID or OCPI location id. The free
// "fall back to site UUID" path that used to exist here was the same data
// leak we patched in cpo/locations.ts for the GET endpoints.
async function resolveSiteId(locationId: string, partnerId: string): Promise<string | null> {
  // Partners may send the custom OCPI location id or the raw site id. The
  // custom id is matched first (findPublishedSiteId).
  const siteId = await findPublishedSiteId(locationId);
  if (siteId == null) return null;

  if (!(await isLocationVisibleToPartner(partnerId, siteId))) {
    return null;
  }
  return siteId;
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
  stationOnline: boolean;
  evseDbId?: string;
  evseNumber?: number;
}

// Without an EVSE uid, pick the first accepted station at the site that is
// online and can start a session, so one offline, disabled or maintained
// station does not block the site. When none can, return the first accepted
// one and let the caller's gates reject it. Pending and removed (blocked)
// stations are never used.
async function findStationForSite(
  siteId: string,
  evseUid: string | undefined,
  coverage: MaintenanceCoverage,
): Promise<ResolvedStation | null> {
  if (evseUid != null) {
    // The uid identifies one EVSE; it must belong to a station at this site.
    const found = await findEvseByUid(evseUid);
    // A retired EVSE is out of service: no start or reservation.
    if (found?.siteId !== siteId || found.evseRetired || !found.stationAccepted) return null;
    return {
      stationDbId: found.stationDbId,
      stationId: found.stationOcppId,
      stationState: found.stationState,
      stationOnline: found.stationOnline,
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
      isOnline: chargingStations.isOnline,
    })
    .from(chargingStations)
    .where(
      and(eq(chargingStations.siteId, siteId), eq(chargingStations.onboardingStatus, 'accepted')),
    )
    .orderBy(asc(chargingStations.stationId));

  const station =
    stations.find(
      (s) => s.isOnline && !isStationLevelUnavailable(s) && !isCovered(coverage, s.stationDbId),
    ) ?? stations[0];
  if (station == null) return null;
  const { stationDbId, stationId, disabledReason, firmwareState, reportedStatus, isOnline } =
    station;
  return {
    stationDbId,
    stationId,
    stationState: { disabledReason, firmwareState, reportedStatus },
    stationOnline: isOnline,
  };
}

// An offline station (the command would wait for a reconnect, and run with no
// partner waiting), a maintenance window, a disable, a firmware install, or a
// station-level fault rejects a start for every EVSE on the station.
function canStartOn(station: ResolvedStation, coverage: MaintenanceCoverage): boolean {
  return (
    station.stationOnline &&
    !isCovered(coverage, station.stationDbId) &&
    !isStationLevelUnavailable(station.stationState)
  );
}

const MAX_CI_STRING_36 = 36;

function isCiString36(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CI_STRING_36;
}

/**
 * The OCPP 2.1 IdToken type a partner's token is sent as in a remote start
 * (OCPI 12.4.4 TokenType): an RFID card as ISO14443, an eMAID as eMAID, and
 * an app or ad hoc user, which the station cannot know, as a Central token
 * the CSMS issued. The 1.6 translation sends the value as the idTag.
 */
export function ocppIdTokenType(ocpiType: string | null | undefined): string {
  if (ocpiType === 'RFID') return 'ISO14443';
  if (ocpiType === 'EMAID') return 'eMAID';
  return 'Central';
}

interface StartToken {
  uid: string;
  type: string | null;
  /** The token embedded in the StartSession when the partner pushed none. */
  embedded: OcpiToken | null;
}

/**
 * The token of a StartSession, scoped to the calling partner so it cannot use
 * another eMSP's token (a uid is unique per eMSP only). A token the partner
 * pushed must be valid. Without one, the Token object of the command is
 * accepted when it is the partner's own (its country code and party id) and
 * valid (owner decision): the StartSession is the eMSP's authorization.
 */
async function startToken(
  token: Partial<OcpiToken>,
  partner: { partnerId: string; countryCode: string | null; partyId: string | null },
): Promise<StartToken | null> {
  if (!isCiString36(token.uid)) return null;
  const [pushed] = await db
    .select({ isValid: ocpiExternalTokens.isValid, tokenType: ocpiExternalTokens.tokenType })
    .from(ocpiExternalTokens)
    .where(
      and(
        eq(ocpiExternalTokens.partnerId, partner.partnerId),
        eq(ocpiExternalTokens.uid, token.uid),
      ),
    )
    .limit(1);
  if (pushed != null) {
    return pushed.isValid ? { uid: token.uid, type: pushed.tokenType, embedded: null } : null;
  }
  const own =
    typeof token.country_code === 'string' &&
    typeof token.party_id === 'string' &&
    partner.countryCode != null &&
    partner.partyId != null &&
    token.country_code.toUpperCase() === partner.countryCode.toUpperCase() &&
    token.party_id.toUpperCase() === partner.partyId.toUpperCase();
  if (!own || token.valid === false) return null;
  return {
    uid: token.uid,
    type: typeof token.type === 'string' ? token.type : null,
    embedded: token as OcpiToken,
  };
}

/** How long after a session ends its partner may still unlock the connector. */
const UNLOCK_AFTER_SESSION_MINUTES = 30;

/**
 * Whether the partner may unlock the EVSE's connector: the newest session on
 * the EVSE is the partner's CPO session (its link row), active or ended in the
 * last UNLOCK_AFTER_SESSION_MINUTES. Another driver's cable is never unlocked.
 */
async function partnerOwnsEvseSession(partnerId: string, evseDbId: string): Promise<boolean> {
  const [latest] = await db
    .select({
      status: chargingSessions.status,
      endedAt: chargingSessions.endedAt,
      linkPartnerId: ocpiRoamingSessions.partnerId,
    })
    .from(chargingSessions)
    .leftJoin(ocpiRoamingSessions, eq(ocpiRoamingSessions.chargingSessionId, chargingSessions.id))
    .where(eq(chargingSessions.evseId, evseDbId))
    .orderBy(desc(chargingSessions.startedAt))
    .limit(1);
  if (latest?.linkPartnerId !== partnerId) return false;
  if (latest.status === 'active') return true;
  return (
    latest.endedAt != null &&
    Date.now() - latest.endedAt.getTime() <= UNLOCK_AFTER_SESSION_MINUTES * 60_000
  );
}

const rejected = (): ReturnType<typeof ocpiSuccess> =>
  ocpiSuccess({ result: 'REJECTED', timeout: COMMAND_TIMEOUT } satisfies OcpiCommandResponse);

async function findConnectorId(evseDbId: string, connectorIdStr: string): Promise<number | null> {
  const connectorIdNum = Number(connectorIdStr);
  if (Number.isNaN(connectorIdNum)) return null;

  const [connector] = await db
    .select({ connectorId: connectors.connectorId })
    .from(connectors)
    .where(
      and(
        eq(connectors.evseId, evseDbId),
        eq(connectors.connectorId, connectorIdNum),
        isNull(connectors.retiredAt),
      ),
    )
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
    if (body.authorization_reference != null && !isCiString36(body.authorization_reference)) {
      await reply
        .status(400)
        .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid authorization_reference'));
      return;
    }

    const token = await startToken(body.token, {
      partnerId: partner.partnerId,
      countryCode: partner.countryCode,
      partyId: partner.partyId,
    });
    if (token == null) return rejected();

    // Resolve location
    const siteId = await resolveSiteId(body.location_id, partner.partnerId);
    if (siteId == null) return rejected();

    const coverage = await getMaintenanceCoverage(siteId);
    const station = await findStationForSite(siteId, body.evse_uid, coverage);
    if (station == null || !canStartOn(station, coverage)) return rejected();

    if (!isAcceptableResponseUrl(body.response_url, partner.allowPrivateNetwork)) {
      return ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'response_url is not allowed');
    }

    // OCPP 2.1 RequestStartTransaction (the OCPP server translates it for a
    // 1.6 station: idTag from idToken.idToken, connectorId from evseId).
    const remoteStartId = crypto.randomInt(1, 2_147_483_647);
    const ocppPayload: Record<string, unknown> = {
      idToken: { idToken: token.uid, type: ocppIdTokenType(token.type) },
      remoteStartId,
    };
    if (station.evseNumber != null) {
      ocppPayload['evseId'] = station.evseNumber;
    }

    // The command row binds the token to this station and partner, so the
    // session the station starts is linked to this partner even when another
    // eMSP holds the same uid, with auth_method COMMAND and the eMSP's
    // authorization_reference.
    const callbackService = getCommandCallbackService();
    const commandId = callbackService.generateCommandId();
    await callbackService.registerCommand({
      commandId,
      responseUrl: body.response_url,
      partnerId: partner.partnerId,
      commandType: 'START_SESSION',
      stationId: station.stationId,
      tokenUid: token.uid,
      tokenType: token.type,
      tokenData: token.embedded,
      remoteStartId,
      authorizationReference: body.authorization_reference ?? null,
    });
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
          // Our CPO sessions only: a row the partner pushed to us as eMSP
          // (no charging session) is not a session we can stop.
          isNotNull(ocpiRoamingSessions.chargingSessionId),
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
        isOnline: chargingStations.isOnline,
      })
      .from(chargingSessions)
      .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
      .where(eq(chargingSessions.id, session.chargingSessionId))
      .limit(1);

    // An offline station cannot stop now; the command is never queued.
    if (chargingSession?.isOnline !== true) return rejected();

    if (!isAcceptableResponseUrl(body.response_url, partner.allowPrivateNetwork)) {
      return ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'response_url is not allowed');
    }

    // Dispatch OCPP command
    const callbackService = getCommandCallbackService();
    const commandId = callbackService.generateCommandId();
    await callbackService.registerCommand({
      commandId,
      responseUrl: body.response_url,
      partnerId: partner.partnerId,
      commandType: 'STOP_SESSION',
      stationId: chargingSession.stationId,
    });
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

    // Rejected (owner decision): a reservation a partner makes has no owner
    // in the reservations model (no partner, driver or fee), so it could not
    // be cancelled by the partner (CANCEL_RESERVATION is rejected for the
    // same reason) and would block the EVSE for local drivers.
    logger.warn(
      { partnerId: partner.partnerId, reservationId: body.reservation_id },
      'RESERVE_NOW rejected: partner reservations are not supported',
    );
    return rejected();
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
      if (found?.siteId !== siteId || !found.stationAccepted) return rejected();
      // An offline station cannot unlock now; the command is never queued.
      if (!found.stationOnline) return rejected();

      // The connector within the EVSE (OCPI Connector.id, as published).
      const connectorNum = await findConnectorId(found.evseDbId, body.connector_id);
      if (connectorNum == null) return rejected();

      // Only the partner whose session is (or just was) on this EVSE may
      // unlock it: never another driver's cable.
      if (!(await partnerOwnsEvseSession(partner.partnerId, found.evseDbId))) return rejected();

      if (!isAcceptableResponseUrl(body.response_url, partner.allowPrivateNetwork)) {
        return ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'response_url is not allowed');
      }

      const callbackService = getCommandCallbackService();
      const commandId = callbackService.generateCommandId();
      await callbackService.registerCommand({
        commandId,
        responseUrl: body.response_url,
        partnerId: partner.partnerId,
        commandType: 'UNLOCK_CONNECTOR',
        stationId: found.stationOcppId,
      });
      // OCPP 2.1 UnlockConnector: evseId and the connector within it. The
      // 1.6 translation sends the evseId as the 1.6 connectorId (a 1.6
      // connector is an EVSE).
      await callbackService.dispatchOcppCommand(commandId, found.stationOcppId, 'UnlockConnector', {
        evseId: found.evseNumber,
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
