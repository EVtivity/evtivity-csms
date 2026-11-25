// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply, FastifyRequest } from 'fastify';
import { client, markSitePlanStale, requestLoadManagementRecompute } from '@evtivity/database';

function writtenSiteId(
  request: FastifyRequest,
  reply: FastifyReply,
  siteParam: string,
): string | null {
  if (reply.statusCode < 200 || reply.statusCode >= 300) return null;
  const params = request.params as Record<string, unknown> | undefined;
  const siteId = params?.[siteParam];
  return typeof siteId === 'string' && siteId !== '' ? siteId : null;
}

/**
 * Asks the worker to compute the site's load management allocation again
 * soon (debounced per site), so an operator change reaches the stations
 * without waiting for the periodic cycle. Fail-open: the cycle covers it.
 */
async function recomputeSite(request: FastifyRequest, siteId: string, trigger: string) {
  try {
    await requestLoadManagementRecompute(client, { siteId }, trigger);
  } catch (err: unknown) {
    request.log.warn(
      { err, siteId, trigger },
      'Asking for a load management recompute failed, the periodic cycle covers it',
    );
  }
}

/**
 * A route `onResponse` hook for writes that change what load management and a
 * depot plan read (panels, circuits, unmanaged loads, station circuits, the
 * load management config, unit budgets, power equipment, electricity rates).
 * After a successful answer it marks the plan of the site in `siteParam`
 * stale (only when the site plans departures) and asks for a recompute of
 * the site's allocation. Runs after the reply and never throws.
 */
export function replanSiteAfterWrite(
  trigger: string,
  siteParam = 'siteId',
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    const siteId = writtenSiteId(request, reply, siteParam);
    if (siteId == null) return;
    await markSitePlanStale(siteId, trigger, request.log, { departureAwareOnly: true });
    await recomputeSite(request, siteId, trigger);
  };
}

/** A route `onResponse` hook that only asks for a recompute (no depot plan input changed). */
export function recomputeSiteAfterWrite(
  trigger: string,
  siteParam = 'siteId',
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    const siteId = writtenSiteId(request, reply, siteParam);
    if (siteId == null) return;
    await recomputeSite(request, siteId, trigger);
  };
}
