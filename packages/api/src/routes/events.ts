// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Subscription } from '@evtivity/lib';
import { createLogger, tryParseJson } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { getUserSiteIds } from '../lib/site-access.js';
import { endSseClients, writeSseClient } from '../lib/sse-broadcast.js';
import { operatorTokenRejection } from '../plugins/auth.js';

const logger = createLogger('events-sse');

const KEEPALIVE_INTERVAL_MS = 30_000;
const EVENTS_CHANNEL = 'csms_events';

// setTimeout delays above 2^31-1 ms fire at once.
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Event types a site-restricted operator receives although they carry no
 * site, reviewed one by one: their data is company-wide and the payload names
 * no station or session.
 * - `ocpp.health`: OCPP server instance health (system status).
 * - `pricing.changed`: pricing groups and tariffs are company-wide; a site or
 *   station pricing change carries its siteId and is filtered like any other.
 * - `token.changed`: driver tokens are company-wide (payload: tokenId).
 * - `roaming.session.changed`, `roaming.cdr.changed`: OCPI roaming refresh
 *   pings with no identifiers.
 * Every other event without a siteId (an unsited station, access logs,
 * conformance runs, or a publisher that cannot resolve the site) reaches
 * all-site operators only.
 */
export const SITELESS_EVENT_TYPES: ReadonlySet<string> = new Set([
  'ocpp.health',
  'pricing.changed',
  'token.changed',
  'roaming.session.changed',
  'roaming.cdr.changed',
]);

/**
 * Support case events. A case at a station carries its siteId; a case without
 * a station carries caseSiteIds (the sites of its linked sessions, null when
 * it has none or one is unsited) and reaches a site-restricted operator only
 * when every one is its own, the scope of supportCaseSiteCondition.
 */
const SUPPORT_CASE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'supportCase.created',
  'supportCase.updated',
  'supportCase.newMessage',
]);

interface SseClient {
  id: number;
  reply: FastifyReply;
  userId: string;
  allowedSiteIds: string[] | null;
  /**
   * True while the stream resolves the user's sites: events wait in
   * `pending` and are filtered once the scope is known, so none is sent
   * under a scope that is not resolved yet.
   */
  scopePending: boolean;
  /** Set by a site, permission or status change during the lookup: look again. */
  scopeStale: boolean;
  pending: string[];
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

// Events held for one stream while its site scope resolves (a cached lookup
// or one database read); older ones are dropped beyond this.
const MAX_PENDING_EVENTS = 500;

/**
 * Whether a csms_events payload may reach a client with these sites (null:
 * all sites). A site-restricted client receives an event whose siteId is one
 * of its sites, a support case event without a station whose caseSiteIds are
 * all its own, or a reviewed siteless type (SITELESS_EVENT_TYPES) that names
 * no station or session. A payload that does not parse reaches all-site
 * clients only.
 */
export function isEventVisible(allowedSiteIds: string[] | null, payload: unknown): boolean {
  if (allowedSiteIds === null) return true;
  if (typeof payload !== 'object' || payload == null) return false;
  const event = payload as Record<string, unknown>;
  const siteId = event['siteId'];
  if (typeof siteId === 'string') return allowedSiteIds.includes(siteId);
  const type = typeof event['eventType'] === 'string' ? event['eventType'] : event['type'];
  if (typeof type === 'string' && SUPPORT_CASE_EVENT_TYPES.has(type)) {
    const caseSiteIds = event['caseSiteIds'];
    return (
      event['stationId'] == null &&
      Array.isArray(caseSiteIds) &&
      caseSiteIds.length > 0 &&
      caseSiteIds.every((id) => typeof id === 'string' && allowedSiteIds.includes(id))
    );
  }
  return (
    typeof type === 'string' &&
    SITELESS_EVENT_TYPES.has(type) &&
    event['stationId'] == null &&
    event['sessionId'] == null
  );
}

let nextClientId = 1;
const clients = new Set<SseClient>();
let subscription: Subscription | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

export function writeToClient(client: SseClient, payload: string): void {
  writeSseClient({
    client,
    payload,
    logger,
    onDeadClient: removeClient,
    describe: (c) => ({ clientId: c.id }),
  });
}

async function ensureListener(): Promise<void> {
  if (subscription != null) return;

  const pubsub = getPubSub();
  subscription = await pubsub.subscribe(EVENTS_CHANNEL, (payload: string) => {
    const parsed = tryParseJson(payload);
    const message = `data: ${payload}\n\n`;
    for (const client of clients) {
      if (client.scopePending) {
        client.pending.push(payload);
        if (client.pending.length > MAX_PENDING_EVENTS) client.pending.shift();
      } else if (isEventVisible(client.allowedSiteIds, parsed)) {
        writeToClient(client, message);
      }
    }
  });

  keepaliveTimer = setInterval(() => {
    const comment = `: keepalive\n\n`;
    for (const client of clients) {
      if (!client.scopePending) writeToClient(client, comment);
    }
  }, KEEPALIVE_INTERVAL_MS);
}

function removeClient(client: SseClient): void {
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
      logger.warn({ err }, 'Unsubscribing the events listener failed');
    });
  }
}

function endClient(client: SseClient, reason: string): void {
  removeClient(client);
  try {
    client.reply.raw.end();
  } catch (err: unknown) {
    logger.warn({ err, clientId: client.id, reason }, 'Ending SSE stream failed');
  }
}

/** Whether closeUserEventStreams marked the client while its sites were read. */
function scopeChangedDuringLookup(client: SseClient): boolean {
  return client.scopeStale;
}

/**
 * Ends the user's open streams on this process. Called by the
 * cache_invalidate listener when the user's sites, permissions or active
 * status change, so the browser reconnects (EventSource retry) and the new
 * stream applies the new site scope, or is refused for a deactivated user.
 */
export function closeUserEventStreams(userId: string): void {
  for (const client of [...clients]) {
    if (client.userId !== userId) continue;
    // A stream still resolving its scope looks the sites up again instead.
    if (client.scopePending) client.scopeStale = true;
    else endClient(client, 'access changed');
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
        return reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }

      let decoded: unknown;
      try {
        decoded = app.jwt.verify(token);
      } catch (err) {
        request.log.debug({ err }, 'SSE token did not verify, refusing the stream');
        return reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }
      // The same checks as app.authenticate: operator token, not MFA-pending,
      // active user.
      const rejection = await operatorTokenRejection(decoded);
      if (rejection != null) {
        return reply.status(401).send(rejection);
      }
      const { userId, exp } = decoded as { userId: string; exp?: number };

      // Register the client before its sites are resolved, so an access
      // change during the lookup is not lost (closeUserEventStreams marks
      // it stale and the lookup runs again) and events published meanwhile
      // wait in `pending` until the scope is known.
      const client: SseClient = {
        id: nextClientId++,
        reply,
        userId,
        allowedSiteIds: [],
        scopePending: true,
        scopeStale: false,
        pending: [],
        expiryTimer: null,
      };
      clients.add(client);
      request.raw.on('close', () => {
        removeClient(client);
      });
      try {
        await ensureListener();
        do {
          client.scopeStale = false;
          client.allowedSiteIds = await getUserSiteIds(userId);
        } while (scopeChangedDuringLookup(client));
      } catch (err) {
        removeClient(client);
        throw err;
      }
      client.scopePending = false;

      void reply
        .header('Content-Type', 'text/event-stream')
        .header('Cache-Control', 'no-cache')
        .header('Connection', 'keep-alive')
        .header('X-Accel-Buffering', 'no');
      reply.raw.writeHead(200, reply.getHeaders() as Record<string, string | string[]>);

      // The stream ends when the token expires; the browser reconnects with
      // a fresh token. A stream closed during the lookup keeps no timer.
      if (typeof exp === 'number' && clients.has(client)) {
        const remainingMs = Math.max(0, exp * 1000 - Date.now());
        client.expiryTimer = setTimeout(
          () => {
            endClient(client, 'token expired');
          },
          Math.min(remainingMs, MAX_TIMER_MS),
        );
        client.expiryTimer.unref();
      }

      // Send initial connection confirmation, then the events held during
      // the lookup that the resolved scope may see.
      reply.raw.write(`: connected\n\n`);
      const held = client.pending;
      client.pending = [];
      for (const payload of held) {
        if (isEventVisible(client.allowedSiteIds, tryParseJson(payload))) {
          writeToClient(client, `data: ${payload}\n\n`);
        }
      }

      // Prevent Fastify from closing the response
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
        logger.warn({ err }, 'Unsubscribing the events listener on close failed');
      });
    }
    clients.clear();
  });
}
