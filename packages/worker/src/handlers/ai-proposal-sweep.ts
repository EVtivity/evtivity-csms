// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from '@evtivity/lib';
import { sweepAiProposals } from '@evtivity/services/ai-proposal.service';
import { failStaleAiWorkerRuns } from '@evtivity/services/ai-workers/runs';

/**
 * Cron `ai-proposal-sweep` (every 5 minutes): expires proposals past their
 * expiry and fails confirms that never finished (the proposal service), and
 * fails background worker runs left `running` by a crash so their period can
 * run again.
 */
export async function aiProposalSweepHandler(log: Logger): Promise<void> {
  const result = await sweepAiProposals(log);
  const staleRuns = await failStaleAiWorkerRuns();
  if (result.expired > 0 || result.interrupted > 0 || result.stale > 0 || staleRuns > 0) {
    log.info({ ...result, staleRuns }, 'AI proposals swept');
  }
}
