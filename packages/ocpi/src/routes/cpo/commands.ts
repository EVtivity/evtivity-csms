// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import {
  db,
  sites,
  chargingStations,
  chargingSessions,
  evses,
  connectors,
  reservations,
  ocpiLocationPublish,
  ocpiExternalTokens,
  ocpiRoamingSessions,
} from '@evtivity/database';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../../lib/ocpi-response.js';
import { ocpiAuthenticate } from '../../middleware/ocpi-auth.js';
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

const COMMAND_TIMEOUT = 30;

async function resolveSiteId(locationId: string): Promise<string | null> {
  // Check if there's a publish entry with a custom OCPI location ID
  const [publish] = await db
    .select({ siteId: ocpiLocationPublish.siteId })
    .from(ocpiLocationPublish)
    .where(eq(ocpiLocationPublish.ocpiLocationId, locationId))
    .limit(1);

  if (publish != null) {
    return publish.siteId;
  }

  // Fall back to using locationId as the site UUID directly
  const [site] = await db
    .select({ id: sites.id })
    .from(sites)
    .where(eq(sites.id, locationId))
    .limit(1);

  return site?.id ?? null;
}

async function findStationForSite(
  siteId: string,
  evseUid?: string,
): Promise<{ stationId: string; evseDbId?: string } | null> {
  if (evseUid != null) {
    // EVSE uid format: ${siteId}-${evseId}
    const parts = evseUid.split('-');
    const evseIdStr = parts[parts.length - 1];
    if (evseIdStr == null) return null;
    const evseIdNum = Number(evseIdStr);
    if (Number.isNaN(evseIdNum)) return null;

    // Find the EVSE and its station
    const results = await db
      .select({
        stationDbId: chargingStations.id,
        stationId: chargingStations.stationId,
        evseDbId: evses.id,
      })
      .from(evses)
      .innerJoin(chargingStations, eq(evses.stationId, chargingStations.id))
      .where(and(eq(chargingStations.siteId, siteId), eq(evses.evseId, evseIdNum)))
      .limit(1);

    const row = results[0];
    if (row == null) return null;
    return { stationId: row.stationId, evseDbId: row.evseDbId };
  }

  // No EVSE specified, find any station at the site
  const [station] = await db
    .select({ stationId: chargingStations.stationId })
    .from(chargingStations)
    .where(eq(chargingStations.siteId, siteId))
    .limit(1);

  if (station == null) return null;
  return { stationId: station.stationId };
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

    // Validate token
    const tokenUid = body.token.uid;
    const [token] = await db
      .select({ isValid: ocpiExternalTokens.isValid })
      .from(ocpiExternalTokens)
      .where(eq(ocpiExternalTokens.uid, tokenUid))
      .limit(1);

    if (token == null || !token.isValid) {
      const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
      return ocpiSuccess(response);
    }

    // Resolve location
    const siteId = await resolveSiteId(body.location_id);
    if (siteId == null) {
      const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
      return ocpiSuccess(response);
    }

    const station = await findStationForSite(siteId, body.evse_uid);
    if (station == null) {
      const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
      return ocpiSuccess(response);
    }

    // Build OCPP payload
    const ocppPayload: Record<string, unknown> = {
      idTag: tokenUid,
      remoteStartId: Math.floor(Math.random() * 2_147_483_647),
    };
    if (station.evseDbId != null) {
      // Find EVSE numeric ID for OCPP
      const evseUidParts = body.evse_uid?.split('-');
      const evseNum =
        evseUidParts != null ? Number(evseUidParts[evseUidParts.length - 1]) : undefined;
      if (evseNum != null && !Number.isNaN(evseNum)) {
        ocppPayload['evseId'] = evseNum;
      }
    }
    if (body.connector_id != null && station.evseDbId != null) {
      const connId = await findConnectorId(station.evseDbId, body.connector_id);
      if (connId != null) {
        ocppPayload['connectorId'] = connId;
      }
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

    // Validate token
    const tokenUid = body.token.uid;
    const [token] = await db
      .select({ isValid: ocpiExternalTokens.isValid })
      .from(ocpiExternalTokens)
      .where(eq(ocpiExternalTokens.uid, tokenUid))
      .limit(1);

    if (token == null || !token.isValid) {
      const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
      return ocpiSuccess(response);
    }

    // Resolve location
    const siteId = await resolveSiteId(body.location_id);
    if (siteId == null) {
      const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
      return ocpiSuccess(response);
    }

    const station = await findStationForSite(siteId, body.evse_uid);
    if (station == null) {
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
      const evseUidParts = body.evse_uid?.split('-');
      const evseNum =
        evseUidParts != null ? Number(evseUidParts[evseUidParts.length - 1]) : undefined;
      if (evseNum != null && !Number.isNaN(evseNum)) {
        ocppPayload['evseId'] = evseNum;
      }
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

      // Look up reservation by OCPP reservation ID (integer)
      const reservationIdNum = Number(body.reservation_id);
      if (Number.isNaN(reservationIdNum)) {
        const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
        return ocpiSuccess(response);
      }

      const [reservation] = await db
        .select({
          stationId: chargingStations.stationId,
          reservationId: reservations.reservationId,
        })
        .from(reservations)
        .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
        .where(eq(reservations.reservationId, reservationIdNum))
        .limit(1);

      if (reservation == null) {
        const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
        return ocpiSuccess(response);
      }

      // Dispatch OCPP command
      const callbackService = getCommandCallbackService();
      const commandId = callbackService.generateCommandId();
      callbackService.registerCommand(
        commandId,
        body.response_url,
        partner.partnerId,
        'CANCEL_RESERVATION',
      );
      await callbackService.dispatchOcppCommand(
        commandId,
        reservation.stationId,
        'CancelReservation',
        { reservationId: reservation.reservationId },
      );

      const response: OcpiCommandResponse = { result: 'ACCEPTED', timeout: COMMAND_TIMEOUT };
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
      const siteId = await resolveSiteId(body.location_id);
      if (siteId == null) {
        const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
        return ocpiSuccess(response);
      }

      const station = await findStationForSite(siteId, body.evse_uid);
      if (station == null || station.evseDbId == null) {
        const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
        return ocpiSuccess(response);
      }

      // Parse EVSE and connector IDs
      const evseUidParts = body.evse_uid.split('-');
      const evseNum = Number(evseUidParts[evseUidParts.length - 1]);
      const connectorNum = Number(body.connector_id);

      if (Number.isNaN(evseNum) || Number.isNaN(connectorNum)) {
        const response: OcpiCommandResponse = { result: 'REJECTED', timeout: COMMAND_TIMEOUT };
        return ocpiSuccess(response);
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
      await callbackService.dispatchOcppCommand(commandId, station.stationId, 'UnlockConnector', {
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
