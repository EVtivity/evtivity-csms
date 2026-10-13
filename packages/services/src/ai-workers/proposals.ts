// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The actions the background workers suggest with an insight, built from the
 * closed action set (`AI_WORKER_ACTIONS`): the action of the station's OCPP
 * version, its fixed arguments, a precondition checked again at confirm, and
 * a structured summary the CSMS renders with locale keys
 * (`aiInsights.action.*`, `aiWorkers.rationale.*`). No model text is needed
 * for any of it (P1).
 */

import { AI_WORKER_ACTIONS } from '@evtivity/lib/ai-proposals';
import type { AiWorkerAction, AiWorkerActionKind, AiWorkerJob } from '@evtivity/lib/ai-proposals';
import type { InsightConfidence, RootCauseCategory } from '@evtivity/lib/ai-insights';
import type { WorkerSuggestion } from './suggest.js';
import type { StuckSession } from './stuck-sessions.js';
import type { FaultedStation } from './network-summary.js';

/** The locale key under `aiWorkers.rationale.*` of a stuck-session reason. */
export const STUCK_RATIONALE_CODES = {
  no_activity: 'stuckSessionIdle',
  station_offline: 'stuckSessionOffline',
  connector_available: 'stuckSessionConnectorAvailable',
} as const;

/**
 * The root cause of a stuck session, from the reason the worker found it. An
 * offline station is a fact (connectivity, high). A connector the station
 * reports available under an open session means the station ended the
 * transaction and its end message never arrived (connectivity, medium). No
 * activity on an online station names no cause (unknown, low).
 */
export const STUCK_ROOT_CAUSES = {
  station_offline: { category: 'connectivity', confidence: 'high' },
  connector_available: { category: 'connectivity', confidence: 'medium' },
  no_activity: { category: 'unknown', confidence: 'low' },
} as const satisfies Record<
  StuckSession['reason'],
  { category: RootCauseCategory; confidence: InsightConfidence }
>;

/** The action of a kind for a station's OCPP version; 2.1 when the station never connected. */
export function workerAction(
  kind: AiWorkerActionKind,
  ocppProtocol: string | null,
): AiWorkerAction {
  const version = ocppProtocol === 'ocpp1.6' ? '1.6' : '2.1';
  const action = AI_WORKER_ACTIONS.find((a) => a.kind === kind && a.ocppVersion === version);
  if (action === undefined) throw new Error(`No worker action ${kind} for OCPP ${version}`);
  return action;
}

const SYSTEM_ACTOR = (job: AiWorkerJob) => ({ actor: 'system' as const, actorLabel: `ai-${job}` });

/**
 * Stop a stuck session: a `stuck_session` insight about the session with the
 * stop action. One insight per session and run period (`triggerKey`); the
 * pending action's dedup key keeps a second one from being suggested while
 * the first waits. Null when the transaction id cannot be sent to a 1.6
 * station (1.6 transaction ids are integers).
 */
export function stopSessionProposal(
  session: StuckSession,
  input: {
    idleMinutes: number;
    expiresAt: Date;
    workerRunId: number | null;
    period: string;
    now: Date;
  },
): WorkerSuggestion | null {
  const action = workerAction('stop_transaction', session.ocppProtocol);
  let transactionId: string | number = session.transactionId;
  if (action.ocppVersion === '1.6') {
    const n = Number(session.transactionId);
    if (!Number.isSafeInteger(n)) return null;
    transactionId = n;
  }
  const idleMinutes = Math.floor((input.now.getTime() - session.lastActivityAt.getTime()) / 60_000);
  const dedupKey = `stuck_sessions:${session.sessionId}`;
  return {
    insight: {
      kind: 'stuck_session',
      siteId: session.siteId,
      stationId: session.stationId,
      sessionId: session.sessionId,
      triggerKey: `${dedupKey}:${input.period}`,
      narrative: null,
      rootCause: STUCK_ROOT_CAUSES[session.reason],
    },
    action: {
      job: 'stuck_sessions',
      workerRunId: input.workerRunId,
      siteId: session.siteId,
      stationId: session.stationId,
      sessionId: session.sessionId,
      operationId: action.operationId,
      method: action.method,
      path: action.path,
      args: { stationId: session.ocppStationId, transactionId, ...action.fixedArgs },
      summary: {
        action: 'stop_transaction',
        stationId: session.ocppStationId,
        transactionId: session.transactionId,
        reason: session.reason,
        rationale: {
          code: STUCK_RATIONALE_CODES[session.reason],
          params: { minutes: Math.max(idleMinutes, input.idleMinutes) },
        },
        lastActivityAt: session.lastActivityAt.toISOString(),
      },
      precondition: {
        kind: 'session_active',
        params: { sessionId: session.sessionId, transactionId: session.transactionId },
      },
      dedupKey,
      expiresAt: input.expiresAt,
      actor: SYSTEM_ACTOR('stuck_sessions'),
    },
  };
}

/**
 * Soft reset (2.1 OnIdle, 1.6 Soft) of a station faulted for hours: a
 * `station_long_faulted` insight about the station with the reset action,
 * one per station and day.
 */
export function softResetProposal(
  station: FaultedStation,
  input: { expiresAt: Date; workerRunId: number | null; period: string },
): WorkerSuggestion {
  const action = workerAction('soft_reset', station.ocppProtocol);
  const dedupKey = `network_summary:soft_reset:${station.stationId}`;
  return {
    insight: {
      kind: 'station_long_faulted',
      siteId: station.siteId,
      stationId: station.stationId,
      sessionId: null,
      triggerKey: `${dedupKey}:${input.period}`,
      narrative: null,
    },
    action: {
      job: 'network_summary',
      workerRunId: input.workerRunId,
      siteId: station.siteId,
      stationId: station.stationId,
      operationId: action.operationId,
      method: action.method,
      path: action.path,
      args: { stationId: station.ocppStationId, ...action.fixedArgs },
      summary: {
        action: 'soft_reset',
        stationId: station.ocppStationId,
        faultedSince: station.faultedSince.toISOString(),
      },
      precondition: { kind: 'station_faulted', params: { stationId: station.stationId } },
      dedupKey,
      expiresAt: input.expiresAt,
      actor: SYSTEM_ACTOR('network_summary'),
    },
  };
}
