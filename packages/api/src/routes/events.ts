// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Subscription } from '@evtivity/lib';
import { getPubSub } from '../lib/pubsub.js';
import { getUserSiteIds } from '../lib/site-access.js';

const KEEPALIVE_INTERVAL_MS = 30_000;
const EVENTS_CHANNEL = 'csms_events';

interface SseClient {
  id: number;
  reply: FastifyReply;
  allowedSiteIds: string[] | null;
}

let nextClientId = 1;
const clients = new Set<SseClient>();
let subscription: Subscription | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

async function ensureListener(): Promise<void> {
  if (subscription != null) return;

  const pubsub = getPubSub();
  subscription = await pubsub.subscribe(EVENTS_CHANNEL, (payload: string) => {
    let eventSiteId: string | undefined;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      if (typeof parsed.siteId === 'string') {
        eventSiteId = parsed.siteId;
      }
    } catch {
      // If JSON parse fails, send to all clients (safe fallback)
    }

    const message = `data: ${payload}\n\n`;
    for (const client of clients) {
      if (
        client.allowedSiteIds === null ||
        eventSiteId == null ||
        client.allowedSiteIds.includes(eventSiteId)
      ) {
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

function removeClient(client: SseClient): void {
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

export function eventStreamRoutes(app: FastifyInstance): void {
  app.get(
    '/events/stream',
    {
      schema: {
        tags: ['Events'],
        summary: 'Subscribe to real-time server-sent events',
        operationId: 'streamEvents',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest<{ Querystring: { token?: string } }>, reply: FastifyReply) => {
      let token: string | undefined;
      if (request.query.token != null && request.query.token !== '') {
        // Query param tokens are plain JWTs (no cookie signing)
        token = request.query.token;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        const rawCookie = request.cookies?.['csms_token'];
        if (rawCookie != null && rawCookie !== '') {
          // Unsign the cookie; fall back to raw value for backward compatibility
          const unsigned = request.unsignCookie(rawCookie);
          token = unsigned.valid ? unsigned.value : rawCookie;
        }
      }
      if (token == null || token === '') {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      let userId: string;
      try {
        const decoded = app.jwt.verify(token);
        userId = (decoded as { userId: string }).userId;
      } catch {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const allowedSiteIds = await getUserSiteIds(userId);

      void reply
        .header('Content-Type', 'text/event-stream')
        .header('Cache-Control', 'no-cache')
        .header('Connection', 'keep-alive')
        .header('X-Accel-Buffering', 'no');
      reply.raw.writeHead(200, reply.getHeaders() as Record<string, string | string[]>);

      const client: SseClient = { id: nextClientId++, reply, allowedSiteIds };
      clients.add(client);

      await ensureListener();

      // Send initial connection confirmation
      reply.raw.write(`: connected\n\n`);

      request.raw.on('close', () => {
        removeClient(client);
      });

      // Prevent Fastify from closing the response
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
