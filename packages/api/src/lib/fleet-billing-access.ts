// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { db, fleets } from '@evtivity/database';
import { isAllSiteUser, requireAllSiteAccess } from './site-access.js';
import { isFleetUser, requireFleetAccess } from './fleet-scope.js';

const FLEET_NOT_FOUND = { error: 'Fleet not found', code: 'FLEET_NOT_FOUND' } as const;

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
  return !(await requireAllSiteAccess(request, reply, FLEET_NOT_FOUND));
}

/**
 * The fleet billing reads a fleet user may make (credit limit, invoice preview,
 * invoice list): a fleet user reaches only its assigned fleets (else 404
 * FLEET_NOT_FOUND), an operator needs access to every site as above. Returns
 * true when the reply was sent.
 */
export async function refuseFleetBillingRead(
  request: FastifyRequest,
  reply: FastifyReply,
  fleetId: string,
): Promise<boolean> {
  const { userId } = request.user as { userId: string };
  if (await isFleetUser(userId)) return !(await requireFleetAccess(request, reply, fleetId));
  return refuseSiteRestrictedFleetBilling(request, reply);
}

/**
 * Fleet membership decides what a driver pays at every site when the fleet
 * has a pricing group (fleet tariffs) or bills on account. A site-restricted
 * user may add or remove members only of a fleet with neither (owner
 * decision 2026-10-09); otherwise, and for a missing fleet, it gets 404
 * FLEET_NOT_FOUND. All-site users pass; the route answers its own 404 for a
 * missing fleet. Returns true when the reply was sent.
 */
export async function refuseSiteRestrictedFleetMembership(
  request: FastifyRequest,
  reply: FastifyReply,
  fleetId: string,
): Promise<boolean> {
  const { userId } = request.user as { userId: string };
  if (await isAllSiteUser(userId)) return false;
  const [fleet] = await db
    .select({
      accountBillingEnabled: fleets.accountBillingEnabled,
      // Written out: a single-table select renders columns unqualified, and
      // the correlated fleet id must name the outer fleets row.
      hasPricingGroup: sql<boolean>`exists (select 1 from pricing_group_fleets pgf where pgf.fleet_id = "fleets"."id")`,
    })
    .from(fleets)
    .where(eq(fleets.id, fleetId));
  if (fleet != null && !fleet.accountBillingEnabled && !fleet.hasPricingGroup) return false;
  await reply.status(404).send(FLEET_NOT_FOUND);
  return true;
}

/** The permission a fleet user needs to edit its fleet's billing profile. */
export const FLEET_BILLING_PROFILE_PERMISSION = 'fleetBilling:write';

/**
 * The billing profile fields a holder of fleetBilling:write edits: the
 * invoice contacts, the company name and address, the VAT ID or tax number
 * and the invoice language. Payment terms, automatic invoicing, the invoice
 * date, the credit limit, charge on account and the invoices stay with
 * operators who hold fleets:write and payments:write.
 */
export const FLEET_MANAGER_PROFILE_FIELDS = [
  'billingContactEmails',
  'billingLegalName',
  'billingStreet',
  'billingCity',
  'billingState',
  'billingZip',
  'billingCountry',
  'billingTaxId',
  'invoiceLanguage',
] as const;

const MANAGER_FIELD_SET = new Set<string>(FLEET_MANAGER_PROFILE_FIELDS);

/** The sent keys a holder of fleetBilling:write alone may not change. */
export function fieldsOutsideFleetManagerProfile(body: Record<string, unknown>): string[] {
  return Object.keys(body).filter((key) => body[key] !== undefined && !MANAGER_FIELD_SET.has(key));
}

/** A fleet with only the billing profile fields a fleet billing reader may see. */
export function fleetManagerProfileView<T extends Record<string, unknown>>(fleet: T): Partial<T> {
  const view: Record<string, unknown> = {};
  for (const key of FLEET_MANAGER_PROFILE_FIELDS) {
    if (key in fleet) view[key] = fleet[key];
  }
  return view as Partial<T>;
}
