// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { chargingSessions } from '@evtivity/database';

/**
 * Condition that keeps rows billed in the company currency. Money aggregates
 * sum only these rows, so amounts in another currency are never reported
 * under the company currency label. A null session currency (written by a pod
 * from before single-currency) counts as the company currency.
 */
export function inCompanyCurrency(currencyColumn: AnyColumn | SQL, companyCurrency: string): SQL {
  return sql`coalesce(upper(${currencyColumn}), ${companyCurrency}) = ${companyCurrency}`;
}

/**
 * A session's billing currency for API responses. Sessions written by a pod
 * from before single-currency can have a null currency; those read as the
 * company currency.
 */
export function sessionCurrencySql(companyCurrency: string): SQL<string> {
  return sql<string>`coalesce(upper(${chargingSessions.currency}), ${companyCurrency})`;
}

/** In-memory counterpart of `sessionCurrencySql` for rows already loaded. */
export function resolveSessionCurrency(
  currency: string | null | undefined,
  companyCurrency: string,
): string {
  return currency != null && currency !== '' ? currency.toUpperCase() : companyCurrency;
}
