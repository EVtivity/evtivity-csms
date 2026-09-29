// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { chargingSessions } from '@evtivity/database';

/**
 * Condition that keeps rows billed in the company currency. Money aggregates
 * sum only these rows, so amounts in another currency are never reported
 * under the company currency label.
 */
export function inCompanyCurrency(currencyColumn: AnyColumn | SQL, companyCurrency: string): SQL {
  return sql`upper(${currencyColumn}) = ${companyCurrency}`;
}

/** A session's billing currency for API responses. */
export function sessionCurrencySql(): SQL<string> {
  return sql<string>`upper(${chargingSessions.currency})`;
}
