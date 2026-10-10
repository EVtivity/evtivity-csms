// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Subscription } from '@evtivity/lib';
import { createLogger, tryParseJson } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { endSseClients, writeSseClient } from '../../lib/sse-broadcast.js';
import { driverTokenRejection } from '../../plugins/auth.js';

const logger = createLogger('portal-events-sse');

const KEEPALIVE_INTERVAL_MS = 30_000;
const PORTAL_EVENTS_CHANNEL = 'portal_events';

// setTimeout delays above 2^31-1 ms fire at once.
const MAX_TIMER_MS = 2_147_483_647;

interface PortalSseClient {
  id: number;
  driverId: string;
  reply: FastifyReply;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

let nextClientId = 1;
const clients = new Set<PortalSseClient>();
let subscription: Subscription | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

export function writeToClient(client: PortalSseClient, payload: string): void {
  writeSseClient({
    client,
    payload,
    logger,
    onDeadClient: removeClient,
    describe: (c) => ({ clientId: c.id, driverId: c.driverId }),
  });
}

async function ensureListener(): Promise<void> {
  if (subscription != null) return;

  const pubsub = getPubSub();
  subscription = await pubsub.subscribe(PORTAL_EVENTS_CHANNEL, (payload: string) => {
    const parsed = tryParseJson(payload) as { driverId?: unknown } | null | undefined;
    if (parsed == null) return;

    const message = `data: ${payload}\n\n`;
    for (const client of clients) {
      if (parsed.driverId === client.driverId) {
        writeToClient(client, message);
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

function removeClient(client: PortalSseClient): void {
  if (client.expiryTimer != null) {
    clearTimeout(client.expiryTimer);
    client.expiryTimer = null;
  }
  clients.delete(client);
  if (clients.size === 0 && subscription != null) {
    const sub = subscription;
    subscription = null;
    if (keepaliveTimer != null) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    void sub.unsubscribe().catch((err: unknown) => {
      // fail-open: the next stream subscribes again (P9).
      logger.warn({ err }, 'Unsubscribing the portal events listener failed');
    });
  }
}

function endClient(client: PortalSseClient, reason: string): void {
  removeClient(client);
  try {
    client.reply.raw.end();
  } catch (err: unknown) {
    logger.warn({ err, clientId: client.id, reason }, 'Ending portal SSE stream failed');
  }
}

/**
 * Ends every open portal event stream of the driver on this pod (a driver
 * deactivation, `cache_invalidate` kind `driver_active`). A reconnect is
 * refused by `driverTokenRejection`.
 */
export function closeDriverEventStreams(driverId: string): void {
  for (const client of [...clients]) {
    if (client.driverId === driverId) endClient(client, 'driver deactivated');
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
      try {
        await request.jwtVerify();
      } catch (err) {
        request.log.debug({ err }, 'Portal SSE token did not verify, refusing the stream');
        return await reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }
      // The same checks as app.authenticateDriver: driver token, not
      // MFA-pending, active driver.
      const rejection = await driverTokenRejection(request.user);
      if (rejection != null) {
        const { status, ...body } = rejection;
        return await reply.status(status).send(body);
      }
      const { driverId, exp } = request.user as unknown as { driverId: string; exp?: number };

      void reply
        .header('Content-Type', 'text/event-stream')
        .header('Cache-Control', 'no-cache')
        .header('Connection', 'keep-alive')
        .header('X-Accel-Buffering', 'no');
      reply.raw.writeHead(200, reply.getHeaders() as Record<string, string | string[]>);

      const client: PortalSseClient = { id: nextClientId++, driverId, reply, expiryTimer: null };
      clients.add(client);
      // The stream ends when the token expires; the browser reconnects with
      // a fresh token.
      if (typeof exp === 'number') {
        const remainingMs = Math.max(0, exp * 1000 - Date.now());
        client.expiryTimer = setTimeout(
          () => {
            endClient(client, 'token expired');
          },
          Math.min(remainingMs, MAX_TIMER_MS),
        );
        client.expiryTimer.unref();
      }

      await ensureListener();

      reply.raw.write(`: connected\n\n`);

      request.raw.on('close', () => {
        removeClient(client);
      });

      await reply;
    },
  );

  app.addHook('preClose', (done) => {
    for (const client of clients) {
      if (client.expiryTimer != null) clearTimeout(client.expiryTimer);
    }
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
      await sub.unsubscribe().catch((err: unknown) => {
        // fail-open: the app is closing (P9).
        logger.warn({ err }, 'Unsubscribing the portal events listener on close failed');
      });
    }
    clients.clear();
  });
}
