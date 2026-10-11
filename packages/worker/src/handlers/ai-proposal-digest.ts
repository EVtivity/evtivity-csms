// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from '@evtivity/lib';
import { sendAiProposalDigests } from '@evtivity/services/ai-workers/digest';
import { getSystemTimezone } from '@evtivity/database';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import { config } from '../lib/config.js';

/**
 * Cron `ai-proposal-digest` (daily 07:00): the opt-in email with the pending
 * AI proposal counts (`ai.ProposalDigest`, decision D12). Only operators who
 * turned it on and have pending proposals at their sites get one.
 */
export async function aiProposalDigestHandler(log: Logger, now = new Date()): Promise<void> {
  const result = await sendAiProposalDigests({
    // The date the operators read, in the system timezone (YYYY-MM-DD).
    digestDate: new Intl.DateTimeFormat('en-CA', { timeZone: await getSystemTimezone() }).format(
      now,
    ),
    inboxUrl: `${config.CSMS_URL.replace(/\/$/, '')}/ai/inbox`,
    templatesDirs: ALL_TEMPLATES_DIRS,
    log,
  });
  if (result.sent > 0) log.info(result, 'AI proposal digests sent');
}
