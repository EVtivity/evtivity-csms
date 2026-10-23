// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Subscription } from '@evtivity/lib';
import { createLogger, tryParseJson } from '@evtivity/lib';
import { db } from '@evtivity/database';
import { chargingStations } from '@evtivity/database';
import { and, eq } from 'drizzle-orm';
import { publicStationListed } from '../../lib/public-station.js';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { endSseClients, writeSseClient } from '../../lib/sse-broadcast.js';
import { clientAddressKey } from '@evtivity/lib/ip-address';

const logger = createLogger('portal-station-events-sse');

const KEEPALIVE_INTERVAL_MS = 30_000;
const CSMS_EVENTS_CHANNEL = 'csms_events';

/**
 * Bounds of the public (unauthenticated) stream, so one client cannot hold
 * the API's sockets and memory: open streams per client
 * address and per process, and the lifetime of one stream (the portal opens
 * a new one when it ends).
 */
export interface StationStreamLimits {
  perClient: number;
  total: number;
  lifetimeMs: number;
}

export const DEFAULT_STREAM_LIMITS: StationStreamLimits = {
  perClient: 10,
  total: 2000,
  lifetimeMs: 30 * 60_000,
};

interface StationSseClient {
  id: number;
  /** The client key the stream counts against (`clientAddressKey(request.ip)`: an IPv6 /64). */
  ip: string;
  stationDbId: string;
  /** The OCPP station id the client subscribed with (public). */
  stationOcppId: string;
  reply: FastifyReply;
}

let nextClientId = 1;
const clients = new Set<StationSseClient>();
let subscription: Subscription | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

const FORWARDED_EVENTS = new Set(['station.status']);

export function writeToClient(client: StationSseClient, payload: string): void {
  writeSseClient({
    client,
    payload,
    logger,
    onDeadClient: removeClient,
    describe: (c) => ({ clientId: c.id, stationDbId: c.stationDbId }),
  });
}

async function ensureListener(): Promise<void> {
  if (subscription != null) return;

  const pubsub = getPubSub();
  subscription = await pubsub.subscribe(CSMS_EVENTS_CHANNEL, (payload: string) => {
    const parsed = tryParseJson(payload) as
      | { eventType?: string; stationId?: string }
      | null
      | undefined;
    if (parsed == null) return;

    if (parsed.eventType == null || !FORWARDED_EVENTS.has(parsed.eventType)) return;

    // The stream is public: forward only the event type and the OCPP station
    // id the client already knows, never the internal station or site ids.
    for (const client of clients) {
      if (parsed.stationId === client.stationDbId) {
        const event = { eventType: parsed.eventType, stationId: client.stationOcppId };
        writeToClient(client, `data: ${JSON.stringify(event)}\n\n`);
      }
    }
  });

  keepaliveTimer = setInterval(() => {
    const comment = `: keepalive\n\n`;
    for (const client of clients) {
      writeToClient(client, comment);
    }
  }, KEEPALIVE_INTERVAL_MS);
}

function removeClient(client: StationSseClient): void {
  clients.delete(client);
  if (clients.size === 0 && subscription != null) {
    const sub = subscription;
    subscription = null;
    if (keepaliveTimer != null) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    void sub.unsubscribe().catch(() => {});
  }
}

export function portalStationEventRoutes(
  app: FastifyInstance,
  options: Partial<StationStreamLimits> = {},
): void {
  const limits: StationStreamLimits = { ...DEFAULT_STREAM_LIMITS, ...options };
  app.get(
    '/portal/chargers/:stationId/events',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Subscribe to real-time station status events',
        operationId: 'portalStreamStationEvents',
        security: [],
      },
    },
    async (request: FastifyRequest<{ Params: { stationId: string } }>, reply: FastifyReply) => {
      const { stationId } = request.params;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(and(eq(chargingStations.stationId, stationId), publicStationListed()))
        .limit(1);

      if (station == null) {
        return await reply
          .status(404)
          .send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      }

      // One IPv6 client holds a /64: counted by prefix, it cannot fill the
      // process's streams from many addresses.
      const clientKey = clientAddressKey(request.ip);
      let fromClient = 0;
      for (const c of clients) if (c.ip === clientKey) fromClient++;
      if (fromClient >= limits.perClient || clients.size >= limits.total) {
        return await reply.status(429).send({
          error: 'Too many open station event streams',
          code: 'STREAM_LIMIT_REACHED',
        });
      }

      void reply
        .header('Content-Type', 'text/event-stream')
        .header('Cache-Control', 'no-cache')
        .header('Connection', 'keep-alive')
        .header('X-Accel-Buffering', 'no');
      reply.raw.writeHead(200, reply.getHeaders() as Record<string, string | string[]>);

      const client: StationSseClient = {
        id: nextClientId++,
        ip: clientKey,
        stationDbId: station.id,
        stationOcppId: stationId,
        reply,
      };
      clients.add(client);

      await ensureListener();

      reply.raw.write(`: connected\n\n`);

      // The stream ends at its maximum lifetime; the portal reconnects.
      const lifetime = setTimeout(() => {
        removeClient(client);
        reply.raw.end();
      }, limits.lifetimeMs);
      lifetime.unref();

      request.raw.on('close', () => {
        clearTimeout(lifetime);
        removeClient(client);
      });

      await reply;
    },
  );

  app.addHook('preClose', (done) => {
    endSseClients(clients, logger);
    done();
  });

  app.addHook('onClose', async () => {
    if (keepaliveTimer != null) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    if (subscription != null) {
      const sub = subscription;
      subscription = null;
      await sub.unsubscribe().catch(() => {});
    }
    clients.clear();
  });
}
