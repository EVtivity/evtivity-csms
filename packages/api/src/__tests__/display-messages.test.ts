// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const VALID_STATION_ID = 'sta_000000000001';
const VALID_MESSAGE_ID = '1';

// -- DB mock helpers --

let dbResults: unknown[][] = [];
let dbCallIndex = 0;

function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}

function makeChain() {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'values',
    'returning',
    'set',
    'onConflictDoUpdate',
    'delete',
    'insert',
    'update',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const r = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(r).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  chain['catch'] = (reject?: (r: unknown) => unknown) => Promise.resolve([]).catch(reject);
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
  },
  displayMessages: {},
  chargingStations: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
}));

// -- PubSub mock --

let mockSubscribeCallback: ((raw: string) => void) | null = null;
const mockUnsubscribe = vi.fn().mockResolvedValue(undefined);
const mockPublish = vi.fn().mockResolvedValue(undefined);
const mockSubscribe = vi
  .fn()
  .mockImplementation(async (_channel: string, cb: (raw: string) => void) => {
    mockSubscribeCallback = cb;
    return { unsubscribe: mockUnsubscribe };
  });

vi.mock('../lib/pubsub.js', () => ({
  getPubSub: vi.fn(() => ({
    publish: mockPublish,
    subscribe: mockSubscribe,
  })),
  setPubSub: vi.fn(),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
  checkStationSiteAccess: vi.fn().mockResolvedValue(true),
}));

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
  invalidatePermissionCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { displayMessageRoutes } from '../routes/display-messages.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(displayMessageRoutes);
  await app.ready();
  return app;
}

describe('Display message routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: 'test-id', roleId: 'test-role' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbResults = [];
    dbCallIndex = 0;
    mockSubscribeCallback = null;
    vi.clearAllMocks();
    mockPublish.mockResolvedValue(undefined);
    mockUnsubscribe.mockResolvedValue(undefined);
    mockSubscribe.mockImplementation(async (_channel: string, cb: (raw: string) => void) => {
      mockSubscribeCallback = cb;
      return { unsubscribe: mockUnsubscribe };
    });
  });

  // ===================================================================
  // GET /v1/stations/:stationId/display-messages
  // ===================================================================

  describe('GET /v1/stations/:stationId/display-messages', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/display-messages`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 200 with data and total (no filters)', async () => {
      const messageRow = {
        id: VALID_MESSAGE_ID,
        stationId: VALID_STATION_ID,
        ocppMessageId: 1,
        priority: 'NormalCycle',
        status: 'accepted',
        format: 'UTF8',
        content: 'Hello',
        language: null,
        state: null,
        startDateTime: null,
        endDateTime: null,
        transactionId: null,
        evseId: null,
        messageExtra: null,
        ocppResponse: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      // First query: data rows, second query: count
      setupDbResults([messageRow], [{ count: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/display-messages`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(1);
    });

    it('returns 200 with status filter applied', async () => {
      setupDbResults([], [{ count: 0 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/display-messages?status=accepted`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('returns total 0 when totalResult is empty', async () => {
      // First query: empty data, second query: empty array (no count row)
      setupDbResults([], []);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/display-messages`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.total).toBe(0);
    });
  });

  // ===================================================================
  // POST /v1/stations/:stationId/display-messages
  // ===================================================================

  describe('POST /v1/stations/:stationId/display-messages', () => {
    const basePayload = {
      priority: 'NormalCycle',
      format: 'UTF8',
      content: 'Hello World',
    };

    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages`,
        payload: basePayload,
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when station not found', async () => {
      // Station lookup returns empty
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: basePayload,
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('STATION_NOT_FOUND');
    });

    it('returns 400 when station is offline', async () => {
      // Station found but offline
      setupDbResults([{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: false }]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: basePayload,
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('STATION_OFFLINE');
    });

    it('returns 500 when message insert returns null', async () => {
      setupDbResults(
        // 1. station lookup
        [{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: true }],
        // 2. maxResult for ocppMessageId
        [{ maxId: 5 }],
        // 3. insert returns empty (no row)
        [],
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: basePayload,
      });
      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('MESSAGE_CREATE_FAILED');
    });

    it('returns 200 with accepted response', async () => {
      const insertedMessage = {
        id: VALID_MESSAGE_ID,
        stationId: VALID_STATION_ID,
        ocppMessageId: 6,
        priority: 'NormalCycle',
        status: 'pending',
        format: 'UTF8',
        content: 'Hello World',
        language: null,
        state: null,
        startDateTime: null,
        endDateTime: null,
        transactionId: null,
        evseId: null,
        messageExtra: null,
        ocppResponse: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const updatedMessage = {
        ...insertedMessage,
        status: 'accepted',
        ocppResponse: { status: 'Accepted' },
      };

      setupDbResults(
        // 1. station lookup
        [{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: true }],
        // 2. maxResult for ocppMessageId
        [{ maxId: 5 }],
        // 3. insert returning
        [insertedMessage],
        // 4. update returning (after OCPP response)
        [updatedMessage],
      );

      const responsePromise = app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: basePayload,
      });

      // Wait for subscribe to be called, then trigger the response
      await vi.waitFor(() => {
        expect(mockPublish).toHaveBeenCalled();
      });

      // Extract commandId from the publish call
      const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
      const notification = JSON.parse(publishCall![1] as string);
      const commandId = notification.commandId;

      // Simulate OCPP response
      mockSubscribeCallback!(
        JSON.stringify({
          commandId,
          response: { status: 'Accepted' },
        }),
      );

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
    });

    it('returns 200 with rejected response (non-Accepted maps to rejected status)', async () => {
      const insertedMessage = {
        id: VALID_MESSAGE_ID,
        stationId: VALID_STATION_ID,
        ocppMessageId: 6,
        priority: 'NormalCycle',
        status: 'pending',
        format: 'UTF8',
        content: 'Hello World',
        language: null,
        state: null,
        startDateTime: null,
        endDateTime: null,
        transactionId: null,
        evseId: null,
        messageExtra: null,
        ocppResponse: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const updatedMessage = {
        ...insertedMessage,
        status: 'rejected',
        ocppResponse: { status: 'Rejected' },
      };

      setupDbResults(
        [{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: true }],
        [{ maxId: 5 }],
        [insertedMessage],
        [updatedMessage],
      );

      const responsePromise = app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: basePayload,
      });

      await vi.waitFor(() => {
        expect(mockPublish).toHaveBeenCalled();
      });

      const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
      const notification = JSON.parse(publishCall![1] as string);
      const commandId = notification.commandId;

      mockSubscribeCallback!(
        JSON.stringify({
          commandId,
          response: { status: 'Rejected' },
        }),
      );

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
    });

    it('returns 504 on timeout', async () => {
      const insertedMessage = {
        id: VALID_MESSAGE_ID,
        stationId: VALID_STATION_ID,
        ocppMessageId: 6,
        priority: 'NormalCycle',
        status: 'pending',
        format: 'UTF8',
        content: 'Hello World',
        language: null,
        state: null,
        startDateTime: null,
        endDateTime: null,
        transactionId: null,
        evseId: null,
        messageExtra: null,
        ocppResponse: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      setupDbResults(
        [{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: true }],
        [{ maxId: 5 }],
        [insertedMessage],
      );

      // Use fake timers to simulate timeout
      vi.useFakeTimers();

      const responsePromise = app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: basePayload,
      });

      // Advance past RESPONSE_TIMEOUT_MS (35000)
      await vi.advanceTimersByTimeAsync(36_000);

      const response = await responsePromise;
      expect(response.statusCode).toBe(504);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('MESSAGE_TIMEOUT');

      vi.useRealTimers();
    });

    it('returns 502 on OCPP error', async () => {
      const insertedMessage = {
        id: VALID_MESSAGE_ID,
        stationId: VALID_STATION_ID,
        ocppMessageId: 6,
        priority: 'NormalCycle',
        status: 'pending',
        format: 'UTF8',
        content: 'Hello World',
        language: null,
        state: null,
        startDateTime: null,
        endDateTime: null,
        transactionId: null,
        evseId: null,
        messageExtra: null,
        ocppResponse: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      setupDbResults(
        [{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: true }],
        [{ maxId: 5 }],
        [insertedMessage],
      );

      const responsePromise = app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: basePayload,
      });

      await vi.waitFor(() => {
        expect(mockPublish).toHaveBeenCalled();
      });

      const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
      const notification = JSON.parse(publishCall![1] as string);
      const commandId = notification.commandId;

      mockSubscribeCallback!(
        JSON.stringify({
          commandId,
          error: 'Station disconnected',
        }),
      );

      const response = await responsePromise;
      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('MESSAGE_SEND_FAILED');
    });

    it('sends optional fields in OCPP payload (language, state, startDateTime, endDateTime, transactionId, evseId, messageExtra)', async () => {
      const insertedMessage = {
        id: VALID_MESSAGE_ID,
        stationId: VALID_STATION_ID,
        ocppMessageId: 6,
        priority: 'AlwaysFront',
        status: 'pending',
        format: 'HTML',
        content: '<b>Alert</b>',
        language: 'en',
        state: 'Charging',
        startDateTime: '2024-01-01T00:00:00.000Z',
        endDateTime: '2024-12-31T23:59:59.000Z',
        transactionId: 'txn-001',
        evseId: 1,
        messageExtra: [{ key: 'value' }],
        ocppResponse: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const updatedMessage = {
        ...insertedMessage,
        status: 'accepted',
        ocppResponse: { status: 'Accepted' },
      };

      setupDbResults(
        [{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: true }],
        [{ maxId: 5 }],
        [insertedMessage],
        [updatedMessage],
      );

      const responsePromise = app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          priority: 'AlwaysFront',
          format: 'HTML',
          content: '<b>Alert</b>',
          language: 'en',
          state: 'Charging',
          startDateTime: '2024-01-01T00:00:00Z',
          endDateTime: '2024-12-31T23:59:59Z',
          transactionId: 'txn-001',
          evseId: 1,
          messageExtra: [{ key: 'value' }],
        },
      });

      await vi.waitFor(() => {
        expect(mockPublish).toHaveBeenCalled();
      });

      const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
      const notification = JSON.parse(publishCall![1] as string);
      const commandId = notification.commandId;

      // Verify the OCPP payload includes optional fields
      expect(notification.payload.message.message.language).toBe('en');
      expect(notification.payload.message.state).toBe('Charging');
      expect(notification.payload.message.startDateTime).toBe('2024-01-01T00:00:00Z');
      expect(notification.payload.message.endDateTime).toBe('2024-12-31T23:59:59Z');
      expect(notification.payload.message.transactionId).toBe('txn-001');
      expect(notification.payload.message.display).toEqual({ evse: { id: 1 } });

      mockSubscribeCallback!(
        JSON.stringify({
          commandId,
          response: { status: 'Accepted' },
        }),
      );

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
    });

    it('handles maxResult returning null maxId (defaults to 0)', async () => {
      const insertedMessage = {
        id: VALID_MESSAGE_ID,
        stationId: VALID_STATION_ID,
        ocppMessageId: 1,
        priority: 'NormalCycle',
        status: 'pending',
        format: 'UTF8',
        content: 'Hello',
        language: null,
        state: null,
        startDateTime: null,
        endDateTime: null,
        transactionId: null,
        evseId: null,
        messageExtra: null,
        ocppResponse: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const updatedMessage = {
        ...insertedMessage,
        status: 'accepted',
        ocppResponse: { status: 'Accepted' },
      };

      setupDbResults(
        [{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: true }],
        // maxResult returns empty array (no existing messages)
        [],
        [insertedMessage],
        [updatedMessage],
      );

      const responsePromise = app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: basePayload,
      });

      await vi.waitFor(() => {
        expect(mockPublish).toHaveBeenCalled();
      });

      const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
      const notification = JSON.parse(publishCall![1] as string);

      mockSubscribeCallback!(
        JSON.stringify({
          commandId: notification.commandId,
          response: { status: 'Accepted' },
        }),
      );

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
    });

    it('handles response with undefined status (maps to rejected)', async () => {
      const insertedMessage = {
        id: VALID_MESSAGE_ID,
        stationId: VALID_STATION_ID,
        ocppMessageId: 6,
        priority: 'NormalCycle',
        status: 'pending',
        format: 'UTF8',
        content: 'Hello',
        language: null,
        state: null,
        startDateTime: null,
        endDateTime: null,
        transactionId: null,
        evseId: null,
        messageExtra: null,
        ocppResponse: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const updatedMessage = { ...insertedMessage, status: 'rejected', ocppResponse: {} };

      setupDbResults(
        [{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: true }],
        [{ maxId: 5 }],
        [insertedMessage],
        [updatedMessage],
      );

      const responsePromise = app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: basePayload,
      });

      await vi.waitFor(() => {
        expect(mockPublish).toHaveBeenCalled();
      });

      const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
      const notification = JSON.parse(publishCall![1] as string);

      // Send response with no status field
      mockSubscribeCallback!(
        JSON.stringify({
          commandId: notification.commandId,
          response: {},
        }),
      );

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
    });

    it('updates message with null ocppResponse when result.response is undefined', async () => {
      const insertedMessage = {
        id: VALID_MESSAGE_ID,
        stationId: VALID_STATION_ID,
        ocppMessageId: 6,
        priority: 'NormalCycle',
        status: 'pending',
        format: 'UTF8',
        content: 'Hello',
        language: null,
        state: null,
        startDateTime: null,
        endDateTime: null,
        transactionId: null,
        evseId: null,
        messageExtra: null,
        ocppResponse: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const updatedMessage = { ...insertedMessage, status: 'rejected', ocppResponse: null };

      setupDbResults(
        [{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: true }],
        [{ maxId: 5 }],
        [insertedMessage],
        [updatedMessage],
      );

      const responsePromise = app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: basePayload,
      });

      await vi.waitFor(() => {
        expect(mockPublish).toHaveBeenCalled();
      });

      const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
      const notification = JSON.parse(publishCall![1] as string);

      // Send response with no response field (only commandId)
      mockSubscribeCallback!(
        JSON.stringify({
          commandId: notification.commandId,
        }),
      );

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
    });
  });

  // ===================================================================
  // DELETE /v1/stations/:stationId/display-messages/:id
  // ===================================================================

  describe('DELETE /v1/stations/:stationId/display-messages/:id', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/display-messages/${VALID_MESSAGE_ID}`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when message not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/display-messages/${VALID_MESSAGE_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('MESSAGE_NOT_FOUND');
    });

    it('returns 400 when message status is not accepted', async () => {
      setupDbResults([
        {
          id: VALID_MESSAGE_ID,
          ocppMessageId: 1,
          status: 'pending',
          stationOcppId: 'STATION-001',
        },
      ]);

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/display-messages/${VALID_MESSAGE_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('MESSAGE_NOT_CLEARABLE');
    });

    it('returns 200 on successful clear (Accepted response)', async () => {
      setupDbResults(
        // 1. message lookup
        [
          {
            id: VALID_MESSAGE_ID,
            ocppMessageId: 1,
            status: 'accepted',
            stationOcppId: 'STATION-001',
          },
        ],
        // 2. update after clear (does not use returning, no result needed)
        [],
      );

      const responsePromise = app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/display-messages/${VALID_MESSAGE_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      await vi.waitFor(() => {
        expect(mockPublish).toHaveBeenCalled();
      });

      const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
      const notification = JSON.parse(publishCall![1] as string);

      mockSubscribeCallback!(
        JSON.stringify({
          commandId: notification.commandId,
          response: { status: 'Accepted' },
        }),
      );

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('cleared');
    });

    it('returns 400 when station rejects clear (non-Accepted response)', async () => {
      setupDbResults([
        {
          id: VALID_MESSAGE_ID,
          ocppMessageId: 1,
          status: 'accepted',
          stationOcppId: 'STATION-001',
        },
      ]);

      const responsePromise = app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/display-messages/${VALID_MESSAGE_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      await vi.waitFor(() => {
        expect(mockPublish).toHaveBeenCalled();
      });

      const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
      const notification = JSON.parse(publishCall![1] as string);

      mockSubscribeCallback!(
        JSON.stringify({
          commandId: notification.commandId,
          response: { status: 'Unknown' },
        }),
      );

      const response = await responsePromise;
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('MESSAGE_CLEAR_REJECTED');
      expect(body.error).toContain('Unknown');
    });

    it('returns 400 with "Unknown" when response status is undefined', async () => {
      setupDbResults([
        {
          id: VALID_MESSAGE_ID,
          ocppMessageId: 1,
          status: 'accepted',
          stationOcppId: 'STATION-001',
        },
      ]);

      const responsePromise = app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/display-messages/${VALID_MESSAGE_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      await vi.waitFor(() => {
        expect(mockPublish).toHaveBeenCalled();
      });

      const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
      const notification = JSON.parse(publishCall![1] as string);

      // Send response with no status field
      mockSubscribeCallback!(
        JSON.stringify({
          commandId: notification.commandId,
          response: {},
        }),
      );

      const response = await responsePromise;
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Unknown');
    });

    it('returns 504 on timeout', async () => {
      setupDbResults([
        {
          id: VALID_MESSAGE_ID,
          ocppMessageId: 1,
          status: 'accepted',
          stationOcppId: 'STATION-001',
        },
      ]);

      vi.useFakeTimers();

      const responsePromise = app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/display-messages/${VALID_MESSAGE_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      await vi.advanceTimersByTimeAsync(36_000);

      const response = await responsePromise;
      expect(response.statusCode).toBe(504);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('MESSAGE_TIMEOUT');

      vi.useRealTimers();
    });

    it('returns 502 on OCPP error', async () => {
      setupDbResults([
        {
          id: VALID_MESSAGE_ID,
          ocppMessageId: 1,
          status: 'accepted',
          stationOcppId: 'STATION-001',
        },
      ]);

      const responsePromise = app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/display-messages/${VALID_MESSAGE_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      await vi.waitFor(() => {
        expect(mockPublish).toHaveBeenCalled();
      });

      const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
      const notification = JSON.parse(publishCall![1] as string);

      mockSubscribeCallback!(
        JSON.stringify({
          commandId: notification.commandId,
          error: 'Connection lost',
        }),
      );

      const response = await responsePromise;
      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('MESSAGE_CLEAR_FAILED');
    });
  });

  // ===================================================================
  // POST /v1/stations/:stationId/display-messages/refresh
  // ===================================================================

  describe('POST /v1/stations/:stationId/display-messages/refresh', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages/refresh`,
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when station not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages/refresh`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('STATION_NOT_FOUND');
    });

    it('returns 400 when station is offline', async () => {
      setupDbResults([{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: false }]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages/refresh`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('STATION_OFFLINE');
    });

    it('returns 200 on success', async () => {
      setupDbResults([{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: true }]);

      const responsePromise = app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages/refresh`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });

      await vi.waitFor(() => {
        expect(mockPublish).toHaveBeenCalled();
      });

      const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
      const notification = JSON.parse(publishCall![1] as string);

      mockSubscribeCallback!(
        JSON.stringify({
          commandId: notification.commandId,
          response: { status: 'Accepted' },
        }),
      );

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('Accepted');
    });

    it('returns status "Unknown" when response status is undefined', async () => {
      setupDbResults([{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: true }]);

      const responsePromise = app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages/refresh`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });

      await vi.waitFor(() => {
        expect(mockPublish).toHaveBeenCalled();
      });

      const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
      const notification = JSON.parse(publishCall![1] as string);

      // Send response with no status field
      mockSubscribeCallback!(
        JSON.stringify({
          commandId: notification.commandId,
          response: {},
        }),
      );

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('Unknown');
    });

    it('returns 504 on timeout', async () => {
      setupDbResults([{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: true }]);

      vi.useFakeTimers();

      const responsePromise = app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages/refresh`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });

      await vi.advanceTimersByTimeAsync(36_000);

      const response = await responsePromise;
      expect(response.statusCode).toBe(504);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('MESSAGE_TIMEOUT');

      vi.useRealTimers();
    });

    it('returns 502 on OCPP error', async () => {
      setupDbResults([{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: true }]);

      const responsePromise = app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages/refresh`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });

      await vi.waitFor(() => {
        expect(mockPublish).toHaveBeenCalled();
      });

      const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
      const notification = JSON.parse(publishCall![1] as string);

      mockSubscribeCallback!(
        JSON.stringify({
          commandId: notification.commandId,
          error: 'Station communication error',
        }),
      );

      const response = await responsePromise;
      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('MESSAGE_REFRESH_FAILED');
    });
  });

  // ===================================================================
  // sendOcppCommandAndWait internals
  // ===================================================================

  describe('sendOcppCommandAndWait edge cases', () => {
    it('ignores invalid JSON in subscribe callback', async () => {
      const insertedMessage = {
        id: VALID_MESSAGE_ID,
        stationId: VALID_STATION_ID,
        ocppMessageId: 1,
        priority: 'NormalCycle',
        status: 'pending',
        format: 'UTF8',
        content: 'Hello',
        language: null,
        state: null,
        startDateTime: null,
        endDateTime: null,
        transactionId: null,
        evseId: null,
        messageExtra: null,
        ocppResponse: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const updatedMessage = {
        ...insertedMessage,
        status: 'accepted',
        ocppResponse: { status: 'Accepted' },
      };

      setupDbResults(
        [{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: true }],
        [{ maxId: 0 }],
        [insertedMessage],
        [updatedMessage],
      );

      const responsePromise = app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          priority: 'NormalCycle',
          format: 'UTF8',
          content: 'Hello',
        },
      });

      await vi.waitFor(() => {
        expect(mockPublish).toHaveBeenCalled();
      });

      const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
      const notification = JSON.parse(publishCall![1] as string);

      // Send invalid JSON -- should be silently ignored
      mockSubscribeCallback!('not valid json {{{');

      // Then send the valid response
      mockSubscribeCallback!(
        JSON.stringify({
          commandId: notification.commandId,
          response: { status: 'Accepted' },
        }),
      );

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
    });

    it('ignores messages with non-matching commandId', async () => {
      const insertedMessage = {
        id: VALID_MESSAGE_ID,
        stationId: VALID_STATION_ID,
        ocppMessageId: 1,
        priority: 'NormalCycle',
        status: 'pending',
        format: 'UTF8',
        content: 'Hello',
        language: null,
        state: null,
        startDateTime: null,
        endDateTime: null,
        transactionId: null,
        evseId: null,
        messageExtra: null,
        ocppResponse: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const updatedMessage = {
        ...insertedMessage,
        status: 'accepted',
        ocppResponse: { status: 'Accepted' },
      };

      setupDbResults(
        [{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: true }],
        [{ maxId: 0 }],
        [insertedMessage],
        [updatedMessage],
      );

      const responsePromise = app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          priority: 'NormalCycle',
          format: 'UTF8',
          content: 'Hello',
        },
      });

      await vi.waitFor(() => {
        expect(mockPublish).toHaveBeenCalled();
      });

      const publishCall = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
      const notification = JSON.parse(publishCall![1] as string);

      // Send message with a different commandId -- should be ignored
      mockSubscribeCallback!(
        JSON.stringify({
          commandId: 'wrong-command-id',
          response: { status: 'Accepted' },
        }),
      );

      // Then send the correct one
      mockSubscribeCallback!(
        JSON.stringify({
          commandId: notification.commandId,
          response: { status: 'Accepted' },
        }),
      );

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
    });

    it('returns 502 with internal error when subscribe rejects', async () => {
      const insertedMessage = {
        id: VALID_MESSAGE_ID,
        stationId: VALID_STATION_ID,
        ocppMessageId: 1,
        priority: 'NormalCycle',
        status: 'pending',
        format: 'UTF8',
        content: 'Hello',
        language: null,
        state: null,
        startDateTime: null,
        endDateTime: null,
        transactionId: null,
        evseId: null,
        messageExtra: null,
        ocppResponse: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      setupDbResults(
        [{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: true }],
        [{ maxId: 0 }],
        [insertedMessage],
      );

      // Make subscribe reject to trigger the catch block
      mockSubscribe.mockRejectedValueOnce(new Error('Redis connection failed'));

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          priority: 'NormalCycle',
          format: 'UTF8',
          content: 'Hello',
        },
      });

      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Internal error sending command');
      expect(body.code).toBe('MESSAGE_SEND_FAILED');
    });

    it('returns internal error when subscribe rejects with non-Error value', async () => {
      const insertedMessage = {
        id: VALID_MESSAGE_ID,
        stationId: VALID_STATION_ID,
        ocppMessageId: 1,
        priority: 'NormalCycle',
        status: 'pending',
        format: 'UTF8',
        content: 'Hello',
        language: null,
        state: null,
        startDateTime: null,
        endDateTime: null,
        transactionId: null,
        evseId: null,
        messageExtra: null,
        ocppResponse: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      setupDbResults(
        [{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: true }],
        [{ maxId: 0 }],
        [insertedMessage],
      );

      // Make subscribe reject with a string (not Error) to test String(err) path
      mockSubscribe.mockRejectedValueOnce('string error');

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          priority: 'NormalCycle',
          format: 'UTF8',
          content: 'Hello',
        },
      });

      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Internal error sending command');
    });

    it('timeout cleans up subscription when it exists', async () => {
      setupDbResults([{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: true }]);

      vi.useFakeTimers();

      const responsePromise = app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/display-messages/refresh`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });

      // Advance timers to trigger the timeout
      await vi.advanceTimersByTimeAsync(36_000);

      const response = await responsePromise;
      expect(response.statusCode).toBe(504);

      // Verify unsubscribe was called during timeout cleanup
      expect(mockUnsubscribe).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });
});
