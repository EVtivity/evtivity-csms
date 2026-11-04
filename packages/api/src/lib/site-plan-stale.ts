// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply, FastifyRequest } from 'fastify';
import { markSitePlanStale } from '@evtivity/database';

/**
 * A route `onResponse` hook for writes that change what a depot plan reads
 * (panels, circuits, unmanaged loads, station circuits, the load management
 * config, electricity rates). After a successful answer it marks the plan of
 * the site in `siteParam` stale, only when the site plans departures, so the
 * next load management cycle replans. Runs after the reply and never throws.
 */
export function replanSiteAfterWrite(
  trigger: string,
  siteParam = 'siteId',
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    if (reply.statusCode < 200 || reply.statusCode >= 300) return;
    const params = request.params as Record<string, unknown> | undefined;
    const siteId = params?.[siteParam];
    if (typeof siteId !== 'string' || siteId === '') return;
    await markSitePlanStale(siteId, trigger, request.log, { departureAwareOnly: true });
  };
}
