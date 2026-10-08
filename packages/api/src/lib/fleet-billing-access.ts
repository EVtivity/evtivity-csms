// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply, FastifyRequest } from 'fastify';
import { getUserSiteIds } from './site-access.js';

/**
 * A fleet invoice spans the sites the fleet's members charged at, so only a
 * user with access to every site (getUserSiteIds is null) may preview,
 * generate or list fleet invoices. A site-restricted user gets 404
 * FLEET_NOT_FOUND, not 403, so the fleet's existence does not leak (design
 * principle P11, multi-tenant isolation). Returns true when the reply was
 * sent.
 */
export async function refuseSiteRestrictedFleetBilling(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const { userId } = request.user as { userId: string };
  if ((await getUserSiteIds(userId)) === null) return false;
  await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
  return true;
}

/**
 * The per-invoice routes (/v1/invoices/:id and its actions) apply the same
 * rule to a fleet invoice and its credit note: a site-restricted user gets 404
 * INVOICE_NOT_FOUND, the answer for a missing invoice, so the user cannot tell
 * a fleet invoice id from an unknown one. `fleetIdOf` is read only for a
 * site-restricted user, so an unrestricted request costs no extra read. Driver
 * invoices are not affected. Returns true when the reply was sent.
 */
export async function refuseSiteRestrictedFleetInvoice(
  request: FastifyRequest,
  reply: FastifyReply,
  fleetIdOf: () => Promise<string | null>,
): Promise<boolean> {
  const { userId } = request.user as { userId: string };
  if ((await getUserSiteIds(userId)) === null) return false;
  if ((await fleetIdOf()) == null) return false;
  await reply.status(404).send({ error: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
  return true;
}
