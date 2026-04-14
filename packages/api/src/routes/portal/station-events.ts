// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Subscription } from '@evtivity/lib';
import { db } from '@evtivity/database';
import { chargingStations } from '@evtivity/database';
import { eq } from 'drizzle-orm';
import { getPubSub } from '../../lib/pubsub.js';

const KEEPALIVE_INTERVAL_MS = 30_000;
const CSMS_EVENTS_CHANNEL = 'csms_events';

interface StationSseClient {
  id: number;
  stationDbId: string;
  reply: FastifyReply;
}

let nextClientId = 1;
const clients = new Set<StationSseClient>();
let subscription: Subscription | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

const FORWARDED_EVENTS = new Set(['station.status']);

async function ensureListener(): Promise<void> {
  if (subscription != null) return;

  const pubsub = getPubSub();
  subscription = await pubsub.subscribe(CSMS_EVENTS_CHANNEL, (payload: string) => {
    let parsed: { eventType?: string; stationId?: string };
    try {
      parsed = JSON.parse(payload) as { eventType?: string; stationId?: string };
    } catch {
      return;
    }

    if (parsed.eventType == null || !FORWARDED_EVENTS.has(parsed.eventType)) return;

    const message = `data: ${payload}\n\n`;
    for (const client of clients) {
      if (parsed.stationId === client.stationDbId) {
        client.reply.raw.write(message);
      }
    }
  });

  keepaliveTimer = setInterval(() => {
    const comment = `: keepalive\n\n`;
    for (const client of clients) {
      client.reply.raw.write(comment);
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
        .where(eq(chargingStations.stationId, stationId))
        .limit(1);

      if (station == null) {
        return await reply.status(404).send({ error: 'Station not found' });
      }

      void reply
        .header('Content-Type', 'text/event-stream')
        .header('Cache-Control', 'no-cache')
        .header('Connection', 'keep-alive')
        .header('X-Accel-Buffering', 'no');
      reply.raw.writeHead(200, reply.getHeaders() as Record<string, string | string[]>);

      const client: StationSseClient = { id: nextClientId++, stationDbId: station.id, reply };
      clients.add(client);

      await ensureListener();

      reply.raw.write(`: connected\n\n`);

      request.raw.on('close', () => {
        removeClient(client);
      });

      await reply;
    },
  );

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
