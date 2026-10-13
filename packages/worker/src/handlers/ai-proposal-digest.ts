// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from '@evtivity/lib';
import { sendAiProposalDigests } from '@evtivity/services/ai-workers/digest';
import { getSystemTimezone } from '@evtivity/database';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import { config } from '../lib/config.js';

/**
 * Cron `ai-proposal-digest` (daily 07:00): the opt-in email with the counts
 * of AI insight actions waiting for a decision (`ai.ProposalDigest`, decision
 * D12), linking the insights with status pending (an action waits). Only operators who turned
 * it on and have pending actions at their sites get one.
 */
export async function aiProposalDigestHandler(log: Logger, now = new Date()): Promise<void> {
  const result = await sendAiProposalDigests({
    // The date the operators read, in the system timezone (YYYY-MM-DD).
    digestDate: new Intl.DateTimeFormat('en-CA', { timeZone: await getSystemTimezone() }).format(
      now,
    ),
    insightsUrl: `${config.CSMS_URL.replace(/\/$/, '')}/ai/insights?status=pending`,
    templatesDirs: ALL_TEMPLATES_DIRS,
    log,
  });
  if (result.sent > 0) log.info(result, 'AI proposal digests sent');
}
