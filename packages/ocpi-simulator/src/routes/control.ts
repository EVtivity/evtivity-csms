// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { state, findPartnerEndpoint } from '../state.js';
import { ocpiGet, ocpiPost, ocpiPut } from '../client.js';

function notRegistered(): Record<string, unknown> {
  return { error: 'Not registered with target. Set OCPI_REGISTRATION_TOKEN and restart.' };
}

export function controlRoutes(app: FastifyInstance): void {
  // GET /sim/state - dump current state
  app.get('/sim/state', () => {
    return {
      role: state.role,
      identity: {
        countryCode: state.countryCode,
        partyId: state.partyId,
        name: state.name,
        baseUrl: state.baseUrl,
      },
      isRegistered: state.isRegistered,
      testTokenUid: state.testTokenUid,
      partnerEndpoints: state.partnerEndpoints,
      receivedSessions: state.receivedSessions,
      receivedCdrs: state.receivedCdrs,
      receivedLocations: state.receivedLocations,
      receivedCommands: state.receivedCommands,
      receivedTokens: state.receivedTokens,
      commandResults: state.commandResults,
    };
  });

  if (state.role === 'emsp') {
    registerEmspControls(app);
  } else {
    registerCpoControls(app);
  }
}

function registerEmspControls(app: FastifyInstance): void {
  // POST /sim/push-token - push our test token to the CPO token receiver
  app.post('/sim/push-token', async (_request, reply) => {
    if (!state.isRegistered) {
      await reply.status(503).send(notRegistered());
      return;
    }

    const url = findPartnerEndpoint('tokens', 'RECEIVER');
    if (url == null) {
      await reply.status(503).send({ error: 'CPO tokens receiver endpoint not found' });
      return;
    }

    const token = {
      uid: state.testTokenUid,
      type: 'RFID',
      contract_id: `${state.countryCode}-SIM-${state.testTokenUid}`,
      issuer: state.name,
      valid: true,
      whitelist: 'ALLOWED',
      country_code: state.countryCode,
      party_id: state.partyId,
      last_updated: new Date().toISOString(),
    };

    const tokenUrl = `${url}/${state.countryCode}/${state.partyId}/${state.testTokenUid}`;
    await ocpiPut(tokenUrl, token);
    app.log.info({ tokenUrl }, 'Pushed test token to CPO');
    return { pushed: token };
  });

  // POST /sim/pull-locations - pull locations from CPO sender
  app.post('/sim/pull-locations', async (_request, reply) => {
    if (!state.isRegistered) {
      await reply.status(503).send(notRegistered());
      return;
    }

    const url = findPartnerEndpoint('locations', 'SENDER');
    if (url == null) {
      await reply.status(503).send({ error: 'CPO locations sender endpoint not found' });
      return;
    }

    const locations = await ocpiGet<unknown[]>(url);
    app.log.info({ count: locations.length }, 'Pulled locations from CPO');
    return { count: locations.length, locations };
  });

  // POST /sim/start-session - send START_SESSION command to CPO
  app.post('/sim/start-session', async (request, reply) => {
    if (!state.isRegistered) {
      await reply.status(503).send(notRegistered());
      return;
    }

    const body = request.body as {
      location_id: string;
      evse_uid?: string;
      connector_id?: string;
    } | null;

    if (body == null || typeof body.location_id !== 'string') {
      await reply.status(400).send({ error: 'Body must include location_id' });
      return;
    }

    const url = findPartnerEndpoint('commands', 'RECEIVER');
    if (url == null) {
      await reply.status(503).send({ error: 'CPO commands receiver endpoint not found' });
      return;
    }

    const responseUrl = `${state.baseUrl}/ocpi/2.2.1/emsp/commands/START_SESSION/callback`;

    const command: Record<string, unknown> = {
      response_url: responseUrl,
      token: {
        uid: state.testTokenUid,
        type: 'RFID',
        contract_id: `${state.countryCode}-SIM-${state.testTokenUid}`,
        issuer: state.name,
        valid: true,
        whitelist: 'ALLOWED',
        country_code: state.countryCode,
        party_id: state.partyId,
        last_updated: new Date().toISOString(),
      },
      location_id: body.location_id,
    };

    if (body.evse_uid != null) command['evse_uid'] = body.evse_uid;
    if (body.connector_id != null) command['connector_id'] = body.connector_id;

    const result = await ocpiPost(`${url}/START_SESSION`, command);
    app.log.info({ result }, 'Sent START_SESSION command');
    return { sent: command, response: result };
  });

  // POST /sim/stop-session - send STOP_SESSION command to CPO
  app.post('/sim/stop-session', async (request, reply) => {
    if (!state.isRegistered) {
      await reply.status(503).send(notRegistered());
      return;
    }

    const body = request.body as { session_id: string } | null;
    if (body == null || typeof body.session_id !== 'string') {
      await reply.status(400).send({ error: 'Body must include session_id' });
      return;
    }

    const url = findPartnerEndpoint('commands', 'RECEIVER');
    if (url == null) {
      await reply.status(503).send({ error: 'CPO commands receiver endpoint not found' });
      return;
    }

    const responseUrl = `${state.baseUrl}/ocpi/2.2.1/emsp/commands/STOP_SESSION/callback`;
    const command = { response_url: responseUrl, session_id: body.session_id };

    const result = await ocpiPost(`${url}/STOP_SESSION`, command);
    app.log.info({ sessionId: body.session_id, result }, 'Sent STOP_SESSION command');
    return { sent: command, response: result };
  });
}

function registerCpoControls(app: FastifyInstance): void {
  // POST /sim/push-location - push a simulated location to the eMSP receiver
  app.post('/sim/push-location', async (_request, reply) => {
    if (!state.isRegistered) {
      await reply.status(503).send(notRegistered());
      return;
    }

    const url = findPartnerEndpoint('locations', 'RECEIVER');
    if (url == null) {
      await reply.status(503).send({ error: 'eMSP locations receiver endpoint not found' });
      return;
    }

    const locationId = `${state.countryCode}-${state.partyId}-LOC001`;
    const location = {
      country_code: state.countryCode,
      party_id: state.partyId,
      id: locationId,
      publish: true,
      name: `${state.name} Test Location`,
      address: '1 Simulator Street',
      city: 'Simville',
      country: state.countryCode,
      coordinates: { latitude: '52.3676', longitude: '4.9041' },
      time_zone: 'Europe/Amsterdam',
      evses: [
        {
          uid: `${locationId}-EVSE1`,
          evse_id: `${state.countryCode}*${state.partyId}*E001`,
          status: 'AVAILABLE',
          connectors: [
            {
              id: '1',
              standard: 'IEC_62196_T2_COMBO',
              format: 'CABLE',
              power_type: 'DC',
              max_voltage: 400,
              max_amperage: 125,
              last_updated: new Date().toISOString(),
            },
          ],
          last_updated: new Date().toISOString(),
        },
      ],
      last_updated: new Date().toISOString(),
    };

    const locationUrl = `${url}/${state.countryCode}/${state.partyId}/${locationId}`;
    await ocpiPut(locationUrl, location);
    app.log.info({ locationUrl }, 'Pushed location to eMSP');
    return { pushed: location };
  });

  // POST /sim/push-session - push a simulated session to the eMSP receiver
  app.post('/sim/push-session', async (request, reply) => {
    if (!state.isRegistered) {
      await reply.status(503).send(notRegistered());
      return;
    }

    const url = findPartnerEndpoint('sessions', 'RECEIVER');
    if (url == null) {
      await reply.status(503).send({ error: 'eMSP sessions receiver endpoint not found' });
      return;
    }

    const body = request.body as { session_id?: string; kwh?: number } | null;
    const sessionId = body?.session_id ?? `SIM-SESSION-${Date.now().toString()}`;
    const kwh = body?.kwh ?? 0;

    const session = {
      country_code: state.countryCode,
      party_id: state.partyId,
      id: sessionId,
      start_date_time: new Date().toISOString(),
      kwh,
      cdr_token: {
        uid: state.testTokenUid,
        type: 'RFID',
        contract_id: `${state.countryCode}-SIM-${state.testTokenUid}`,
      },
      auth_method: 'WHITELIST',
      location_id: `${state.countryCode}-${state.partyId}-LOC001`,
      evse_uid: `${state.countryCode}-${state.partyId}-LOC001-EVSE1`,
      connector_id: '1',
      currency: 'USD',
      status: 'ACTIVE',
      last_updated: new Date().toISOString(),
    };

    const sessionUrl = `${url}/${state.countryCode}/${state.partyId}/${sessionId}`;
    await ocpiPut(sessionUrl, session);
    app.log.info({ sessionId }, 'Pushed session to eMSP');
    return { pushed: session };
  });

  // POST /sim/push-cdr - push a simulated CDR to the eMSP receiver
  app.post('/sim/push-cdr', async (request, reply) => {
    if (!state.isRegistered) {
      await reply.status(503).send(notRegistered());
      return;
    }

    const url = findPartnerEndpoint('cdrs', 'RECEIVER');
    if (url == null) {
      await reply.status(503).send({ error: 'eMSP CDRs receiver endpoint not found' });
      return;
    }

    const body = request.body as { session_id?: string; total_energy?: number } | null;
    const cdrId = `SIM-CDR-${Date.now().toString()}`;
    const totalEnergy = body?.total_energy ?? 10;

    const cdr = {
      country_code: state.countryCode,
      party_id: state.partyId,
      id: cdrId,
      start_date_time: new Date(Date.now() - 3_600_000).toISOString(),
      end_date_time: new Date().toISOString(),
      cdr_token: {
        uid: state.testTokenUid,
        type: 'RFID',
        contract_id: `${state.countryCode}-SIM-${state.testTokenUid}`,
      },
      auth_method: 'WHITELIST',
      cdr_location: {
        id: `${state.countryCode}-${state.partyId}-LOC001`,
        address: '1 Simulator Street',
        city: 'Simville',
        country: state.countryCode,
        coordinates: { latitude: '52.3676', longitude: '4.9041' },
        evse_uid: `${state.countryCode}-${state.partyId}-LOC001-EVSE1`,
        evse_id: `${state.countryCode}*${state.partyId}*E001`,
        connector_id: '1',
        connector_standard: 'IEC_62196_T2_COMBO',
        connector_format: 'CABLE',
        connector_power_type: 'DC',
      },
      currency: 'USD',
      total_energy: totalEnergy,
      total_time: 1.0,
      total_cost: { excl_vat: '5.00' },
      last_updated: new Date().toISOString(),
    };

    await ocpiPost(url, cdr);
    app.log.info({ cdrId }, 'Pushed CDR to eMSP');
    return { pushed: cdr };
  });
}
