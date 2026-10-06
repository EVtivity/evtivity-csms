// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, sql } from 'drizzle-orm';
import type { AnyColumn, SQL } from 'drizzle-orm';

/**
 * Case-insensitive exact email match: `lower(column) = <lowercased email>`.
 * Use it for every email lookup. `ilike` treats `_` and `%` in the address as
 * wildcards, so `a_b@x.com` would also match `axb@x.com`.
 */
export function emailEquals(column: AnyColumn, email: string): SQL {
  return eq(sql<string>`lower(${column})`, email.toLowerCase());
}
