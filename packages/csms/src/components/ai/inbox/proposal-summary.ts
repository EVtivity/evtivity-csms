// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { AI_WORKER_ACTION_KINDS } from '@evtivity/lib/ai-proposals';
import type { AiWorkerActionKind } from '@evtivity/lib/ai-proposals';

/**
 * The `aiWorkers.rationale.*` keys a worker proposal's summary can name
 * (`STUCK_RATIONALE_CODES` in `@evtivity/services/ai-workers/proposals`).
 */
export const WORKER_RATIONALE_CODES = [
  'stuckSessionIdle',
  'stuckSessionOffline',
  'stuckSessionConnectorAvailable',
] as const;
export type WorkerRationaleCode = (typeof WORKER_RATIONALE_CODES)[number];

/** The interpolation variables of the `aiWorkers.rationale.*` texts. */
const RATIONALE_PARAMS = ['minutes'] as const;

export interface ProposalSummaryView {
  action: AiWorkerActionKind | null;
  /** MCP: the catalog tool that runs (after the OCPP version mapping). */
  toolName: string | null;
  /** MCP: the tool the client asked for, when it was mapped to another one. */
  requestedTool: string | null;
  /** MCP: the client's name as it sent it (untrusted). */
  clientName: string | null;
  rationale: { code: WorkerRationaleCode; params: Record<string, string | number> } | null;
  /** The values the worker measured, shown next to the rationale. */
  measured: {
    /** Stuck sessions: the last meter value or transaction event (ISO). */
    lastActivityAt: string | null;
    /** Network summary: since when the station is faulted (ISO). */
    faultedSince: string | null;
    transactionId: string | null;
  };
}

/**
 * Reads the structured summary a worker stores on a proposal
 * (`{ action, stationId, transactionId, reason, rationale: { code, params } }`)
 * or an MCP proposal carries (`{ toolName, stationId, requestedTool?, clientName? }`).
 * Unknown values are dropped, so the card falls back to the operation.
 */
export function readProposalSummary(summary: Record<string, unknown>): ProposalSummaryView {
  const action = summary['action'];
  const rationale = summary['rationale'];
  let parsedRationale: ProposalSummaryView['rationale'] = null;
  if (rationale != null && typeof rationale === 'object') {
    const code = (rationale as Record<string, unknown>)['code'];
    const params = (rationale as Record<string, unknown>)['params'];
    if ((WORKER_RATIONALE_CODES as readonly unknown[]).includes(code)) {
      const clean: Record<string, string | number> = {};
      if (params != null && typeof params === 'object') {
        // Only the variables the rationale texts use: other names (lng, ns,
        // count, context) would change how i18next resolves the key.
        for (const name of RATIONALE_PARAMS) {
          const v = (params as Record<string, unknown>)[name];
          if (typeof v === 'string' || typeof v === 'number') clean[name] = v;
        }
      }
      parsedRationale = { code: code as WorkerRationaleCode, params: clean };
    }
  }
  const text = (key: string): string | null => {
    const v = summary[key];
    return typeof v === 'string' && v !== '' ? v : null;
  };
  const time = (key: string): string | null => {
    const v = text(key);
    return v != null && !Number.isNaN(Date.parse(v)) ? v : null;
  };
  const transactionId = summary['transactionId'];
  return {
    toolName: text('toolName'),
    requestedTool: text('requestedTool'),
    clientName: text('clientName'),
    action: (AI_WORKER_ACTION_KINDS as readonly unknown[]).includes(action)
      ? (action as AiWorkerActionKind)
      : null,
    rationale: parsedRationale,
    measured: {
      lastActivityAt: time('lastActivityAt'),
      faultedSince: time('faultedSince'),
      transactionId:
        typeof transactionId === 'string' && transactionId !== ''
          ? transactionId
          : typeof transactionId === 'number'
            ? String(transactionId)
            : null,
    },
  };
}
