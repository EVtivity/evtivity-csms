// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * A background worker suggestion: an automatic insight that carries an
 * action to confirm, or advice only (a stuck session at a station that has
 * not been offline long enough for the CSMS end). The insight is written
 * through the insight service, the action through the action service (P3),
 * in that order: the action names its insight. A suggestion whose action is
 * still pending (same dedup key), or whose insight trigger was seen before,
 * makes nothing new (P7).
 */

import { getAiInsightSettings } from '@evtivity/database';
import type { ServiceLogger } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import {
  getInsightRow,
  publishInsightUpdated,
  resolveInsights,
  storeWorkerActionInsight,
} from '../ai-insight.service.js';
import type { WorkerActionInsightInput } from '../ai-insight.service.js';
import { createAiProposal, hasPendingAiProposal } from '../ai-proposal.service.js';
import type { CreateAiProposalInput } from '../ai-proposal.service.js';

export interface WorkerSuggestion {
  insight: Omit<WorkerActionInsightInput, 'primaryLanguage'>;
  /** The action to confirm; null for an insight that carries advice only. */
  action: Omit<CreateAiProposalInput, 'insightId'> | null;
}

export type SuggestionOutcome = 'created' | 'duplicate';

/**
 * Writes the insight, then its action. `duplicate` when the action is still
 * pending from an earlier run or the insight's trigger was seen before. When
 * the action is not created (a concurrent run made it first) or its create
 * throws, the new insight is resolved, so no insight shows an action it
 * does not have; a throw is rethrown. An advice-only suggestion writes the
 * insight alone.
 */
export async function suggestWorkerAction(
  suggestion: WorkerSuggestion,
  log: ServiceLogger,
): Promise<SuggestionOutcome> {
  const dedupKey = suggestion.action?.dedupKey;
  if (dedupKey != null && (await hasPendingAiProposal(dedupKey))) return 'duplicate';
  const { primaryLanguage } = await getAiInsightSettings();
  const pubsub = getPubSub();
  const insightId = await storeWorkerActionInsight(
    { ...suggestion.insight, primaryLanguage },
    pubsub,
  );
  if (insightId === null) return 'duplicate';
  if (suggestion.action === null) return 'created';
  const withdraw = async (): Promise<void> => {
    await resolveInsights([insightId]);
    const row = await getInsightRow(insightId);
    if (row !== null) await publishInsightUpdated(pubsub, row);
  };
  let created;
  try {
    created = await createAiProposal({ ...suggestion.action, insightId }, log);
  } catch (err) {
    await withdraw();
    throw err;
  }
  if (created !== null) return 'created';
  await withdraw();
  return 'duplicate';
}
