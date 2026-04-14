// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Subscription } from '@evtivity/lib';
import { getPubSub } from '../../lib/pubsub.js';

const KEEPALIVE_INTERVAL_MS = 30_000;
const PORTAL_EVENTS_CHANNEL = 'portal_events';

interface PortalSseClient {
  id: number;
  driverId: string;
  reply: FastifyReply;
}

let nextClientId = 1;
const clients = new Set<PortalSseClient>();
let subscription: Subscription | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

async function ensureListener(): Promise<void> {
  if (subscription != null) return;

  const pubsub = getPubSub();
  subscription = await pubsub.subscribe(PORTAL_EVENTS_CHANNEL, (payload: string) => {
    let parsed: { driverId?: string };
    try {
      parsed = JSON.parse(payload) as { driverId?: string };
    } catch {
      return;
    }

    const message = `data: ${payload}\n\n`;
    for (const client of clients) {
      if (parsed.driverId === client.driverId) {
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

function removeClient(client: PortalSseClient): void {
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

export function portalEventRoutes(app: FastifyInstance): void {
  app.get(
    '/portal/events',
    {
      schema: {
        tags: ['Portal Events'],
        summary: 'Subscribe to real-time portal events',
        operationId: 'portalStreamEvents',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      let driverId: string;
      try {
        await request.jwtVerify();
        const payload = request.user as unknown as Record<string, unknown>;
        if (payload['type'] !== 'driver') {
          return await reply.status(403).send({ error: 'Forbidden' });
        }
        driverId = payload['driverId'] as string;
      } catch {
        return await reply.status(401).send({ error: 'Unauthorized' });
      }

      void reply
        .header('Content-Type', 'text/event-stream')
        .header('Cache-Control', 'no-cache')
        .header('Connection', 'keep-alive')
        .header('X-Accel-Buffering', 'no');
      reply.raw.writeHead(200, reply.getHeaders() as Record<string, string | string[]>);

      const client: PortalSseClient = { id: nextClientId++, driverId, reply };
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
