// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Deterministic scope counts of an insight, computed in SQL and never by the
 * model: the counts of the subject's site (`site`), from the one shared query
 * `computeInsightScopeCounts` in `@evtivity/database` (the demo seed uses it too). A subject without a site
 * has no counts. No count spans every site (v0.1.45, plan section 5: the
 * all-sites counts were removed).
 */

import { computeInsightScopeCounts } from '@evtivity/database';
import type { InsightScopeInput } from '@evtivity/database';
import type { InsightScope } from '@evtivity/lib/ai-insights';

export type ScopeInput = InsightScopeInput;

/** The site counts of the subject; empty for a subject without a site. */
export async function computeInsightScope(input: ScopeInput): Promise<InsightScope> {
  return computeInsightScopeCounts(input);
}
