// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';
import { AI_WORKER_ACTION_KINDS, findAiWorkerAction } from '@evtivity/lib/ai-proposals';
import type { AiWorkerActionKind } from '@evtivity/lib/ai-proposals';
import { confirmSummary } from '../confirm-summary';
import type { AiInsightActionView } from './insight-api';

/**
 * The action an insight carries (a background worker suggestion), read from
 * its structured summary: no model text is needed to show it (P1).
 */

/**
 * The `aiWorkers.rationale.*` keys an action's summary can name
 * (`STUCK_RATIONALE_CODES` in `@evtivity/services/ai-workers/proposals`).
 */
export const WORKER_RATIONALE_CODES = [
  'stuckSessionIdle',
  'stuckSessionOffline',
  'stuckSessionConnectorAvailable',
] as const;
type WorkerRationaleCode = (typeof WORKER_RATIONALE_CODES)[number];

/** The interpolation variables of the `aiWorkers.rationale.*` texts. */
const RATIONALE_PARAMS = ['minutes'] as const;

interface ActionSummaryView {
  action: AiWorkerActionKind | null;
  rationale: { code: WorkerRationaleCode; params: Record<string, string | number> } | null;
  /** The values the worker measured, shown next to the rationale. */
  measured: {
    /** Stuck sessions: the last meter value or transaction event (ISO). */
    lastActivityAt: string | null;
    /** Station faulted for hours: since when (ISO). */
    faultedSince: string | null;
    transactionId: string | null;
  };
}

/**
 * Reads the structured summary a worker stores on an action
 * (`{ action, stationId, transactionId, reason, rationale: { code, params } }`).
 * Unknown values are dropped, so the section falls back to the operation.
 */
export function readActionSummary(summary: Record<string, unknown>): ActionSummaryView {
  const action = summary['action'];
  const rationale = summary['rationale'];
  let parsedRationale: ActionSummaryView['rationale'] = null;
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
  const time = (key: string): string | null => {
    const v = summary[key];
    return typeof v === 'string' && v !== '' && !Number.isNaN(Date.parse(v)) ? v : null;
  };
  const transactionId = summary['transactionId'];
  return {
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

/**
 * The OCPP transaction id an action is about, as the station knows it: an
 * integer for OCPP 1.6 (`RemoteStopTransaction.transactionId`), a string
 * (usually a UUID) for 2.1. The action's arguments win over the summary, so
 * the card shows the id the command sends. Null for station actions.
 */
export function actionTransactionId(
  action: Pick<AiInsightActionView, 'args' | 'summary'>,
): string | null {
  const fromArgs = action.args['transactionId'];
  if (typeof fromArgs === 'string' && fromArgs !== '') return fromArgs;
  if (typeof fromArgs === 'number' && Number.isFinite(fromArgs)) return String(fromArgs);
  return readActionSummary(action.summary).measured.transactionId;
}

/** The tool name of an operation, as the assistant's catalog names it (`ocppv21_reset`). */
export function actionToolName(operationId: string): string {
  return operationId.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Fix steps an action performs itself, so the card does not list them again. */
const STEPS_THE_ACTION_DOES: Readonly<Record<string, readonly string[]>> = {
  soft_reset: ['reboot_station'],
};

/** The insight's fix steps without the ones its action already does. */
export function stepsBesideAction<T extends { code: string }>(
  fixes: readonly T[],
  action: AiInsightActionView | null,
): T[] {
  if (action == null) return [...fixes];
  const kind =
    readActionSummary(action.summary).action ?? findAiWorkerAction(action.operationId)?.kind;
  const done = new Set(kind != null ? (STEPS_THE_ACTION_DOES[kind] ?? []) : []);
  return fixes.filter((f) => !done.has(f.code));
}

/** The localized sentence of what an action runs (`confirm-summary.ts`). */
export function actionSentence(t: TFunction, action: AiInsightActionView): string {
  return confirmSummary(t, {
    name: actionToolName(action.operationId),
    method: action.method,
    path: action.path,
    arguments: action.args,
  });
}

/** The localized title of an action (`aiInsights.action.kind.*`). */
export function actionLabel(t: TFunction, action: AiInsightActionView): string {
  const kind =
    readActionSummary(action.summary).action ??
    findAiWorkerAction(action.operationId)?.kind ??
    null;
  return kind != null ? t(`aiInsights.action.kind.${kind}`) : t('ai.confirmTitle');
}

/**
 * Whether the insight's action can still be confirmed or rejected now: the
 * insight's one status is `pending` and the action has not expired.
 */
export function isActionOpen(
  insightStatus: string,
  action: Pick<AiInsightActionView, 'expiresAt'>,
  now: number = Date.now(),
): boolean {
  return insightStatus === 'pending' && Date.parse(action.expiresAt) > now;
}

/** Whether the action ran: its stored result answered below 400 (a refusal stores 0). */
export function actionRan(action: Pick<AiInsightActionView, 'result'>): boolean {
  const status = action.result?.httpStatus ?? 0;
  return status > 0 && status < 400;
}
