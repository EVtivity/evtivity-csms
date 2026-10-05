// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { db, accessLogs } from '@evtivity/database';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { redactAccessLogBody } from '../lib/access-log-redaction.js';

// Paths not recorded in the 'api' access-log category.
const SKIP_LOG_PATHS = new Set([
  '/v1/health',
  '/v1/events',
  // Long-lived SSE. Without this skip, every operator dashboard tab logs
  // an access-log row each time the EventSource closes (network blip,
  // navigation, reload), with a multi-hour `durationMs` that's
  // meaningless. Path comes from packages/api/src/routes/events.ts.
  '/v1/events/stream',
  '/v1/access-logs',
  '/v1/portal/access-logs',
]);

// The 'api' access-log category fires on every request, so its SSE fan-out is
// throttled to one publish per window to avoid flooding the channel.
export const API_ACCESS_LOG_SSE_THROTTLE_MS = 5_000;

/**
 * Records every /v1 request in access_logs (category 'api') from an onResponse
 * hook. Best-effort (P9, fail-open): the write and the SSE publish run in the
 * background so the response is not held, and a failure is logged at warn,
 * never thrown or silently dropped.
 */
export function registerApiAccessLog(app: FastifyInstance): void {
  let lastSsePublish = 0;

  app.addHook('onResponse', async (request, reply) => {
    const url = request.url;
    if (!url.startsWith('/v1/')) return;
    const pathOnly = url.split('?')[0] ?? url;
    if (SKIP_LOG_PATHS.has(pathOnly)) return;

    let userId: string | null = null;
    let authType = 'anonymous';
    let apiKeyName: string | null = null;
    const payload = request.user as unknown as Record<string, unknown> | undefined;
    if (payload != null && typeof payload['userId'] === 'string') {
      userId = payload['userId'];
      if (payload['isApiKey'] === true) {
        authType = 'api_key';
        apiKeyName = typeof payload['apiKeyName'] === 'string' ? payload['apiKeyName'] : null;
      } else {
        authType = 'session';
      }
    }

    const hasBody = request.method !== 'GET' && request.method !== 'DELETE';
    let metadata: Record<string, unknown> | undefined;
    if (hasBody && request.body != null && typeof request.body === 'object') {
      // Operators with access-log read must never see another operator's
      // newly-set credentials, so secret fields are redacted by name.
      metadata = redactAccessLogBody(pathOnly, request.body as Record<string, unknown>);
    }

    // Not awaited, so the onResponse hook does not keep the request alive
    // waiting on an INSERT. A failed write (for example a request whose user
    // was deleted by that request, a foreign key violation) loses the row.
    void db
      .insert(accessLogs)
      .values({
        userId,
        action: `${request.method} ${pathOnly}`,
        category: 'api',
        authType,
        apiKeyName,
        method: request.method,
        path: pathOnly,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        remoteAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        metadata,
      })
      .catch((err: unknown) => {
        request.log.warn({ err, path: pathOnly }, 'API access log write failed');
      });

    // Throttled SSE so the Access Logs 'api' tab reloads itself.
    const now = Date.now();
    if (now - lastSsePublish >= API_ACCESS_LOG_SSE_THROTTLE_MS) {
      lastSsePublish = now;
      void getPubSub()
        .publish('csms_events', JSON.stringify({ eventType: 'access.log', category: 'api' }))
        .catch((err: unknown) => {
          request.log.warn({ err }, 'API access log SSE publish failed');
        });
    }
  });
}
