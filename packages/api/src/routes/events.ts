// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Subscription } from '@evtivity/lib';
import { createLogger, hasPermission, tryParseJson } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { getUserSiteIds } from '../lib/site-access.js';
import { endSseClients, writeSseClient } from '../lib/sse-broadcast.js';
import { operatorTokenRejection } from '../plugins/auth.js';
import { getUserPermissions } from '../middleware/rbac.js';
import { noteDashboardEvent } from '../plugins/response-cache.js';
import { readSignedCookie } from '../lib/auth-cookies.js';

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
  /** Whether the user holds payments:read: else payment events lose their reasons. */
  canSeePayments: boolean;
  /** The user's permissions: each event type needs its read permission. */
  permissions: string[];
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

/**
 * The read permission an event type needs, by its family (the text before the
 * first dot), so a client gets the events of the pages it may read: a support-only user gets no session events.
 * Payment events reach every client, without their failure reasons
 * (`eventForClient`), so session and station pages refresh. A family in
 * neither this map nor `OPEN_EVENT_FAMILIES` reaches no client (deny by
 * default); `sse-event-families.test.ts`
 * fails on a published family in neither list.
 */
const EVENT_FAMILY_PERMISSION: Readonly<Record<string, string>> = {
  session: 'sessions:read',
  reservation: 'reservations:read',
  supportCase: 'support:read',
  driver: 'drivers:read',
  token: 'drivers:read',
  authorize: 'drivers:read',
  invoice: 'payments:read',
  station: 'stations:read',
  ocpp: 'stations:read',
  command: 'stations:read',
  config: 'stations:read',
  localAuthList: 'stations:read',
  access: 'logs:read',
  octt: 'conformance:read',
  pnc: 'certificates:read',
  certificate: 'certificates:read',
  maintenance: 'maintenance:read',
  load: 'loadManagement:read',
  roaming: 'roaming:read',
  pricing: 'pricing:read',
  displayMessage: 'stations:read',
  firmwareCampaign: 'settings.firmware:read',
  meter: 'stations:read',
};

/**
 * Families every client gets: payment events (masked by `eventForClient`) so
 * session and station pages refresh, and AI events (insight, proposal, alert
 * and usage notices), which carry ids only and are site-filtered.
 */
export const OPEN_EVENT_FAMILIES: ReadonlySet<string> = new Set(['payment', 'ai']);

/** The families with a read permission. */
export function mappedEventFamilies(): string[] {
  return Object.keys(EVENT_FAMILY_PERMISSION);
}

/**
 * The read permission an event type needs, null when every client gets it, or
 * false when no client does (a family in neither list).
 */
export function eventReadPermission(type: string): string | null | false {
  const family = type.split('.', 1)[0] ?? '';
  const permission = EVENT_FAMILY_PERMISSION[family];
  if (permission != null) return permission;
  return OPEN_EVENT_FAMILIES.has(family) ? null : false;
}

/** Whether a client with these permissions may receive the event (its type's read permission). */
export function isEventPermitted(permissions: string[], payload: unknown): boolean {
  if (typeof payload !== 'object' || payload == null) return true;
  const event = payload as Record<string, unknown>;
  const type = typeof event['eventType'] === 'string' ? event['eventType'] : event['type'];
  if (typeof type !== 'string') return true;
  const permission = eventReadPermission(type);
  if (permission === false) return false;
  return permission == null || hasPermission(permissions, permission);
}

/** Whether an event reaches this client: its sites and its permissions. */
function deliverable(client: SseClient, parsed: unknown): boolean {
  return (
    isEventVisible(client.allowedSiteIds, parsed) && isEventPermitted(client.permissions, parsed)
  );
}

/** Fields of a payment event that only payments:read may see (failure reasons). */
const PAYMENT_DETAIL_FIELDS = ['reason', 'failureReason', 'errorMessage'] as const;

/**
 * The payload a client receives: unchanged, or for a client without
 * payments:read a payment event (`payment.*`) without its failure reasons.
 */
export function eventForClient(canSeePayments: boolean, payload: string, parsed: unknown): string {
  if (canSeePayments || typeof parsed !== 'object' || parsed == null) return payload;
  const event = parsed as Record<string, unknown>;
  const type = typeof event['eventType'] === 'string' ? event['eventType'] : event['type'];
  if (typeof type !== 'string' || !type.startsWith('payment.')) return payload;
  if (!PAYMENT_DETAIL_FIELDS.some((field) => field in event)) return payload;
  const hidden: ReadonlySet<string> = new Set(PAYMENT_DETAIL_FIELDS);
  return JSON.stringify(Object.fromEntries(Object.entries(event).filter(([k]) => !hidden.has(k))));
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
    if (parsed != null && typeof parsed === 'object') {
      noteDashboardEvent((parsed as { eventType?: unknown }).eventType);
    }
    for (const client of clients) {
      if (client.scopePending) {
        client.pending.push(payload);
        if (client.pending.length > MAX_PENDING_EVENTS) client.pending.shift();
      } else if (deliverable(client, parsed)) {
        writeToClient(
          client,
          `data: ${eventForClient(client.canSeePayments, payload, parsed)}\n\n`,
        );
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
    async (request: FastifyRequest, reply: FastifyReply) => {
      // The signed csms_token cookie (the CSMS) or a Bearer header. Never a token in
      // the URL, which proxy and load balancer logs keep,
      // and never an unsigned cookie.
      let token: string | undefined;
      const authorization = request.headers.authorization;
      if (typeof authorization === 'string' && /^Bearer\s+\S/i.test(authorization)) {
        token = authorization.replace(/^Bearer\s+/i, '');
      } else {
        const cookie = readSignedCookie(request, 'csms_token');
        if (cookie.status === 'valid') token = cookie.value;
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

      // The stream carries data of every page: a user without any permission
      // (each one is a read or a write, and write implies read) gets none.
      const permissions = await getUserPermissions(userId);
      if (permissions.length === 0) {
        return reply
          .status(403)
          .send({ error: 'Insufficient permissions', code: 'INSUFFICIENT_PERMISSIONS' });
      }

      // Register the client before its sites are resolved, so an access
      // change during the lookup is not lost (closeUserEventStreams marks
      // it stale and the lookup runs again) and events published meanwhile
      // wait in `pending` until the scope is known.
      const client: SseClient = {
        id: nextClientId++,
        reply,
        userId,
        allowedSiteIds: [],
        canSeePayments: false,
        permissions: [],
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
          client.permissions = await getUserPermissions(userId);
          client.canSeePayments = hasPermission(client.permissions, 'payments:read');
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
        const parsed = tryParseJson(payload);
        if (deliverable(client, parsed)) {
          writeToClient(
            client,
            `data: ${eventForClient(client.canSeePayments, payload, parsed)}\n\n`,
          );
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
