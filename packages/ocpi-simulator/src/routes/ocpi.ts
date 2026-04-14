// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { state } from '../state.js';

// OCPI response envelope helpers

function ocpiOk(data: unknown): Record<string, unknown> {
  return {
    data,
    status_code: 1000,
    status_message: 'OK',
    timestamp: new Date().toISOString(),
  };
}

function ocpiErr(code: number, message: string): Record<string, unknown> {
  return {
    data: null,
    status_code: code,
    status_message: message,
    timestamp: new Date().toISOString(),
  };
}

// Auth middleware: verify incoming requests use the token we issued to target

async function simAuthenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Token ')) {
    await reply.status(401).send(ocpiErr(2001, 'Missing or invalid Authorization header'));
    return;
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
  if (decoded !== state.ourToken) {
    await reply.status(401).send(ocpiErr(2001, 'Invalid token'));
  }
}

// Auth that also accepts requests before registration (for inbound credential exchange)

async function registrationAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Token ')) {
    await reply.status(401).send(ocpiErr(2001, 'Missing Authorization header'));
    return;
  }
  const incomingToken = process.env['OCPI_SIM_INCOMING_REG_TOKEN'];
  if (incomingToken != null) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
    if (decoded !== incomingToken) {
      await reply.status(401).send(ocpiErr(2001, 'Invalid registration token'));
    }
  }
  // If OCPI_SIM_INCOMING_REG_TOKEN not set, accept any token (dev convenience)
}

function buildVersionDetail(version: '2.2.1' | '2.3.0'): Record<string, unknown> {
  const base = `${state.baseUrl}/ocpi/${version}`;

  const endpoints: { identifier: string; role: string; url: string }[] = [];

  if (state.role === 'emsp') {
    endpoints.push(
      { identifier: 'tokens', role: 'SENDER', url: `${base}/emsp/tokens` },
      { identifier: 'sessions', role: 'RECEIVER', url: `${base}/emsp/sessions` },
      { identifier: 'cdrs', role: 'RECEIVER', url: `${base}/emsp/cdrs` },
      { identifier: 'commands', role: 'SENDER', url: `${base}/emsp/commands` },
    );
  } else {
    endpoints.push(
      { identifier: 'locations', role: 'SENDER', url: `${base}/cpo/locations` },
      { identifier: 'tokens', role: 'RECEIVER', url: `${base}/cpo/tokens` },
      { identifier: 'commands', role: 'RECEIVER', url: `${base}/cpo/commands` },
    );
  }

  endpoints.push(
    { identifier: 'credentials', role: 'SENDER', url: `${base}/credentials` },
    { identifier: 'credentials', role: 'RECEIVER', url: `${base}/credentials` },
  );

  return { version, endpoints };
}

function buildOurCredentials(): Record<string, unknown> {
  return {
    token: state.ourToken,
    url: `${state.baseUrl}/ocpi/versions`,
    roles: [
      {
        role: state.role.toUpperCase(),
        party_id: state.partyId,
        country_code: state.countryCode,
        business_details: { name: state.name },
      },
    ],
  };
}

function registerVersionRoutes(app: FastifyInstance): void {
  app.get('/ocpi/versions', () => {
    return ocpiOk([
      { version: '2.2.1', url: `${state.baseUrl}/ocpi/2.2.1` },
      { version: '2.3.0', url: `${state.baseUrl}/ocpi/2.3.0` },
    ]);
  });

  app.get('/ocpi/2.2.1', { onRequest: [simAuthenticate] }, () => {
    return ocpiOk(buildVersionDetail('2.2.1'));
  });

  app.get('/ocpi/2.3.0', { onRequest: [simAuthenticate] }, () => {
    return ocpiOk(buildVersionDetail('2.3.0'));
  });
}

function registerCredentialRoutes(app: FastifyInstance): void {
  const handler =
    (version: '2.2.1' | '2.3.0') =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<Record<string, unknown>> => {
      const body = request.body as Record<string, unknown> | null;
      if (body == null || typeof body['token'] !== 'string') {
        await reply.status(400).send(ocpiErr(2002, 'Invalid credentials body'));
        return ocpiErr(2002, 'Invalid credentials body');
      }

      // Store the token they gave us
      state.theirToken = body['token'];
      state.isRegistered = true;

      app.log.info(
        { version, token: body['token'].slice(0, 8) + '...' },
        'Inbound registration accepted',
      );

      return ocpiOk(buildOurCredentials());
    };

  app.post('/ocpi/2.2.1/credentials', { onRequest: [registrationAuth] }, handler('2.2.1'));
  app.post('/ocpi/2.3.0/credentials', { onRequest: [registrationAuth] }, handler('2.3.0'));

  app.get('/ocpi/2.2.1/credentials', { onRequest: [simAuthenticate] }, () => {
    return ocpiOk(buildOurCredentials());
  });
  app.get('/ocpi/2.3.0/credentials', { onRequest: [simAuthenticate] }, () => {
    return ocpiOk(buildOurCredentials());
  });
}

function registerEmspRoutes(app: FastifyInstance): void {
  // eMSP SENDER: serve our test token to CPO
  const tokenHandler = (): Record<string, unknown> => {
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
    return ocpiOk([token]);
  };

  app.get('/ocpi/2.2.1/emsp/tokens', { onRequest: [simAuthenticate] }, tokenHandler);
  app.get('/ocpi/2.3.0/emsp/tokens', { onRequest: [simAuthenticate] }, tokenHandler);

  // eMSP RECEIVER: accept session pushes from CPO
  const sessionHandler = (request: FastifyRequest): Record<string, unknown> => {
    const body = request.body as Record<string, unknown>;
    const sessionId = (request.params as Record<string, string>)['session_id'] ?? 'unknown';
    state.receivedSessions.push({
      sessionId,
      status: (body['status'] as string | undefined) ?? 'UNKNOWN',
      kwh: Number(body['kwh'] ?? 0),
      receivedAt: new Date().toISOString(),
    });
    app.log.info({ sessionId }, 'Received session push from CPO');
    return ocpiOk(null);
  };

  app.put(
    '/ocpi/2.2.1/emsp/sessions/:country_code/:party_id/:session_id',
    { onRequest: [simAuthenticate] },
    sessionHandler,
  );
  app.put(
    '/ocpi/2.3.0/emsp/sessions/:country_code/:party_id/:session_id',
    { onRequest: [simAuthenticate] },
    sessionHandler,
  );
  app.patch(
    '/ocpi/2.2.1/emsp/sessions/:country_code/:party_id/:session_id',
    { onRequest: [simAuthenticate] },
    sessionHandler,
  );
  app.patch(
    '/ocpi/2.3.0/emsp/sessions/:country_code/:party_id/:session_id',
    { onRequest: [simAuthenticate] },
    sessionHandler,
  );

  // eMSP RECEIVER: accept CDR pushes from CPO
  const cdrHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = request.body as Record<string, unknown>;
    const cdrId = (body['id'] as string | undefined) ?? 'unknown';

    state.receivedCdrs.push({
      cdrId,
      totalEnergy: Number(body['total_energy'] ?? 0),
      totalCost: body['total_cost'] != null ? JSON.stringify(body['total_cost']) : null,
      receivedAt: new Date().toISOString(),
    });

    app.log.info({ cdrId }, 'Received CDR push from CPO');
    const locationUrl = `${state.baseUrl}/ocpi/2.2.1/emsp/cdrs/${cdrId}`;
    await reply.status(201).header('Location', locationUrl).send(ocpiOk(null));
  };

  app.post('/ocpi/2.2.1/emsp/cdrs', { onRequest: [simAuthenticate] }, cdrHandler);
  app.post('/ocpi/2.3.0/emsp/cdrs', { onRequest: [simAuthenticate] }, cdrHandler);

  app.get('/ocpi/2.2.1/emsp/cdrs/:cdr_id', { onRequest: [simAuthenticate] }, (request) => {
    const { cdr_id } = request.params as { cdr_id: string };
    const cdr = state.receivedCdrs.find((c) => c.cdrId === cdr_id);
    return ocpiOk(cdr ?? null);
  });

  // eMSP SENDER: command callback - CPO sends async result here
  const commandCallbackHandler = (request: FastifyRequest): Record<string, unknown> => {
    const body = request.body as Record<string, unknown>;
    const { command } = request.params as { command: string };
    const correlationId = request.headers['x-correlation-id'] as string | undefined;
    const result = (body['result'] as string | undefined) ?? 'UNKNOWN';

    state.commandResults.push({
      commandId: correlationId ?? 'unknown',
      result,
      receivedAt: new Date().toISOString(),
    });

    app.log.info({ command, result, correlationId }, 'Received command result from CPO');
    return ocpiOk(null);
  };

  app.post(
    '/ocpi/2.2.1/emsp/commands/:command/callback',
    { onRequest: [simAuthenticate] },
    commandCallbackHandler,
  );
  app.post(
    '/ocpi/2.3.0/emsp/commands/:command/callback',
    { onRequest: [simAuthenticate] },
    commandCallbackHandler,
  );
}

function registerCpoRoutes(app: FastifyInstance): void {
  // CPO SENDER: serve a simulated location to eMSP
  const locationHandler = (): Record<string, unknown> => {
    const location = {
      country_code: state.countryCode,
      party_id: state.partyId,
      id: `${state.countryCode}-${state.partyId}-LOC001`,
      publish: true,
      name: `${state.name} Test Station`,
      address: '1 Simulator Street',
      city: 'Simville',
      country: state.countryCode,
      coordinates: { latitude: '52.3676', longitude: '4.9041' },
      time_zone: 'Europe/Amsterdam',
      evses: [
        {
          uid: `${state.countryCode}-${state.partyId}-LOC001-EVSE1`,
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
    return ocpiOk([location]);
  };

  app.get('/ocpi/2.2.1/cpo/locations', { onRequest: [simAuthenticate] }, locationHandler);
  app.get('/ocpi/2.3.0/cpo/locations', { onRequest: [simAuthenticate] }, locationHandler);

  // CPO RECEIVER: accept token pushes from eMSP
  const tokenPushHandler = (request: FastifyRequest): Record<string, unknown> => {
    const body = request.body as Record<string, unknown>;
    const { token_uid } = request.params as { token_uid: string };

    state.receivedTokens.push({
      uid: token_uid,
      contractId: (body['contract_id'] as string | undefined) ?? token_uid,
      isValid: (body['valid'] as boolean | undefined) ?? true,
      receivedAt: new Date().toISOString(),
    });

    app.log.info({ token_uid }, 'Received token push from eMSP');
    return ocpiOk(null);
  };

  app.put(
    '/ocpi/2.2.1/cpo/tokens/:country_code/:party_id/:token_uid',
    { onRequest: [simAuthenticate] },
    tokenPushHandler,
  );
  app.put(
    '/ocpi/2.3.0/cpo/tokens/:country_code/:party_id/:token_uid',
    { onRequest: [simAuthenticate] },
    tokenPushHandler,
  );

  // CPO RECEIVER: accept commands from eMSP
  const commandHandler = (request: FastifyRequest): Record<string, unknown> => {
    const body = request.body as Record<string, unknown>;
    const { command } = request.params as { command: string };
    const responseUrl = (body['response_url'] as string | undefined) ?? '';

    state.receivedCommands.push({
      command,
      body,
      receivedAt: new Date().toISOString(),
    });

    app.log.info({ command }, 'Received command from eMSP');

    // Send async ACCEPTED result to the response_url
    if (responseUrl.length > 0) {
      setImmediate(() => {
        void fetch(responseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ result: 'ACCEPTED' }),
        }).catch(() => {
          // Best-effort callback
        });
      });
    }

    return ocpiOk({ result: 'ACCEPTED', timeout: 30 });
  };

  app.post('/ocpi/2.2.1/cpo/commands/:command', { onRequest: [simAuthenticate] }, commandHandler);
  app.post('/ocpi/2.3.0/cpo/commands/:command', { onRequest: [simAuthenticate] }, commandHandler);
}

export function ocpiRoutes(app: FastifyInstance): void {
  registerVersionRoutes(app);
  registerCredentialRoutes(app);

  if (state.role === 'emsp') {
    registerEmspRoutes(app);
  } else {
    registerCpoRoutes(app);
  }
}
