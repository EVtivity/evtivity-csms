// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';
import { requestHasPermission } from '../middleware/rbac.js';

/**
 * The money fields of the site and station metrics replies: revenue, tax,
 * electricity cost and profit. They need `payments:read` like the dashboard's
 * money routes; without it they are null.
 */
export const METRICS_MONEY_FIELDS = [
  'totalRevenueCents',
  'avgRevenueCentsPerSession',
  'totalElectricityCostCents',
  'totalNetRevenueCents',
  'totalTaxCents',
  'totalProfitCents',
  'costMissingRevenueCents',
] as const;

/** The money field of a revenue history day. */
export const REVENUE_HISTORY_MONEY_FIELDS = ['revenueCents'] as const;

/** Whether the request may read money figures (`payments:read`, API key scope included). */
export function canReadMoney(request: FastifyRequest): Promise<boolean> {
  return requestHasPermission(request, 'payments:read');
}

/** A copy of `value` with the given fields null, or `value` itself when `canRead`. */
export function maskMoneyFields<T extends Record<string, unknown>, K extends keyof T>(
  value: T,
  fields: readonly K[],
  canRead: boolean,
): Omit<T, K> & { [P in K]: T[P] | null } {
  if (canRead) return value;
  const masked: Record<string, unknown> = { ...value };
  for (const field of fields) masked[field as string] = null;
  return masked as Omit<T, K> & { [P in K]: T[P] | null };
}
