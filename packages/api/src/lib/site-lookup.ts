// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { sites } from '@evtivity/database';

// Case-insensitive literal-match on sites.name. Used everywhere we need
// "is there already a site with this name?" semantics. Prefer this over
// ilike() because ilike treats % and _ in the user-supplied value as
// wildcards, which produces false-positive collisions and silently
// blocks legitimate names.
export function siteNameEq(nameValue: string): SQL {
  return sql`LOWER(${sites.name}) = LOWER(${nameValue})`;
}
