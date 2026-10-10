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

const logger = createLogger('portal-station-events-sse');

const KEEPALIVE_INTERVAL_MS = 30_000;
const CSMS_EVENTS_CHANNEL = 'csms_events';

interface StationSseClient {
  id: number;
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

export function portalStationEventRoutes(app: FastifyInstance): void {
  app.get(
    '/portal/chargers/:stationId/events',
    {
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

      void reply
        .header('Content-Type', 'text/event-stream')
        .header('Cache-Control', 'no-cache')
        .header('Connection', 'keep-alive')
        .header('X-Accel-Buffering', 'no');
      reply.raw.writeHead(200, reply.getHeaders() as Record<string, string | string[]>);

      const client: StationSseClient = {
        id: nextClientId++,
        stationDbId: station.id,
        stationOcppId: stationId,
        reply,
      };
      clients.add(client);

      await ensureListener();

      reply.raw.write(`: connected\n\n`);

      request.raw.on('close', () => {
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
