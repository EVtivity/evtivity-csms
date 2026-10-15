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
 * The locale keys under `aiWorkers.billing.*` of how the action bills the
 * session. The CSMS end bills it at its last metered energy, once
 * (`stuckSessionEnd`). The stop depends on the station's answer to
 * GetTransactionStatus (`transaction-probe.ts`): still running, the station
 * ends it and it is billed from the final meter reading
 * (`stuckSessionStopOngoing`); not running, the stop is answered TxNotFound
 * and the CSMS ends it at its last metered energy
 * (`stuckSessionStopNotOngoing`); unknown (OCPP 1.6, no answer), both
 * outcomes are named (`stuckSessionStop`).
 */
export const STUCK_BILLING_CODES = [
  'stuckSessionStop',
  'stuckSessionStopOngoing',
  'stuckSessionStopNotOngoing',
  'stuckSessionEnd',
] as const;
export type StuckBillingCode = (typeof STUCK_BILLING_CODES)[number];

export function stuckBillingCode(
  kind: 'stop_transaction' | 'end_session',
  transactionOngoing: boolean | null,
): StuckBillingCode {
  if (kind === 'end_session') return 'stuckSessionEnd';
  if (transactionOngoing === true) return 'stuckSessionStopOngoing';
  if (transactionOngoing === false) return 'stuckSessionStopNotOngoing';
  return 'stuckSessionStop';
}

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

/**
 * The action of a kind for a station's OCPP version (2.1 when the station
 * never connected); an action whose route serves both versions is returned
 * for either.
 */
export function workerAction(
  kind: AiWorkerActionKind,
  ocppProtocol: string | null,
): AiWorkerAction {
  const version = ocppProtocol === 'ocpp1.6' ? '1.6' : '2.1';
  const action = AI_WORKER_ACTIONS.find(
    (a) => a.kind === kind && (a.ocppVersion === null || a.ocppVersion === version),
  );
  if (action === undefined) throw new Error(`No worker action ${kind} for OCPP ${version}`);
  return action;
}

const SYSTEM_ACTOR = (job: AiWorkerJob) => ({ actor: 'system' as const, actorLabel: `ai-${job}` });

/**
 * What the stuck-session worker suggests for a session:
 * - `stop`: the station is online; the EVSE stop goes to it (a session the
 *   station no longer knows is ended and billed by the CSMS).
 * - `offline_advice`: the station is offline for less than
 *   `offlineEndAfterHours`; the insight advises restoring the connection (on
 *   reconnect the station sends its stored transaction messages, so the
 *   session ends with its real final meter reading) and carries no action.
 * - `offline_end`: the station is offline for at least that long; the CSMS
 *   end closes the session at its last metered energy without the station.
 */
export type StuckSessionCase = 'stop' | 'offline_advice' | 'offline_end';

/** Whole minutes the station has been offline, null for an online station. */
export function stationOfflineMinutes(
  session: Pick<StuckSession, 'stationOfflineSince'>,
  now: Date,
): number | null {
  if (session.stationOfflineSince === null) return null;
  return Math.max(0, Math.floor((now.getTime() - session.stationOfflineSince.getTime()) / 60_000));
}

export function stuckSessionCase(
  session: StuckSession,
  input: { now: Date; offlineEndAfterHours: number },
): StuckSessionCase {
  if (session.reason !== 'station_offline') return 'stop';
  const minutes = stationOfflineMinutes(session, input.now) ?? 0;
  return minutes >= input.offlineEndAfterHours * 60 ? 'offline_end' : 'offline_advice';
}

/** What to check at an offline station, before anything is ended. */
export const STUCK_OFFLINE_FIXES = [
  'check_power_supply',
  'check_network_connection',
  'contact_site',
] as const;

/**
 * A stuck session's insight and the action that fits its station's connection
 * now (`stuckSessionCase`). An online station gets the EVSE stop
 * (`stop_transaction`). An offline station first gets advice only, with one
 * insight per session (trigger `stuck_sessions:<sessionId>:offline`): how
 * long it is offline (`scope.stationOffline`) and what to check. Once it is
 * offline for `offlineEndAfterHours`, it gets the CSMS end (`end_session`)
 * with the same advice first. The precondition records the connection the
 * action was chosen for (`stationOnline`) and is checked again at confirm: a
 * station that came back online or went offline since makes the action
 * stale, and the next run suggests the other one. An action insight is one
 * per session and run period (`triggerKey`); the pending action's dedup key
 * keeps a second one from being suggested while the first waits.
 * `transactionOngoing` is the online station's answer to GetTransactionStatus
 * (null when not asked or unknown), which picks the billing text. Null for an
 * online station when the session's EVSE is unknown (the stop route acts on
 * the EVSE).
 */
export function stuckSessionProposal(
  session: StuckSession,
  input: {
    idleMinutes: number;
    offlineEndAfterHours: number;
    expiresAt: Date;
    workerRunId: number | null;
    period: string;
    now: Date;
    transactionOngoing?: boolean | null;
  },
): WorkerSuggestion | null {
  const transactionOngoing = input.transactionOngoing ?? null;
  const which = stuckSessionCase(session, input);
  const dedupKey = `stuck_sessions:${session.sessionId}`;
  const offline =
    session.stationOfflineSince === null
      ? {}
      : {
          fixes: STUCK_OFFLINE_FIXES,
          scope: { stationOffline: { since: session.stationOfflineSince.toISOString() } },
        };
  const insight = {
    kind: 'stuck_session' as const,
    siteId: session.siteId,
    stationId: session.stationId,
    sessionId: session.sessionId,
    triggerKey: which === 'offline_advice' ? `${dedupKey}:offline` : `${dedupKey}:${input.period}`,
    narrative: null,
    rootCause: STUCK_ROOT_CAUSES[session.reason],
    ...offline,
  };
  if (which === 'offline_advice') return { insight, action: null };

  const kind = which === 'stop' ? 'stop_transaction' : 'end_session';
  const stationOnline = which === 'stop';
  const action = workerAction(kind, session.ocppProtocol);
  let args: Record<string, unknown>;
  if (stationOnline) {
    if (session.ocppEvseId === null) return null;
    args = { id: session.stationId, evseId: session.ocppEvseId, ...action.fixedArgs };
  } else {
    args = { id: session.sessionId, ...action.fixedArgs };
  }
  const idleMinutes = Math.floor((input.now.getTime() - session.lastActivityAt.getTime()) / 60_000);
  return {
    insight,
    action: {
      job: 'stuck_sessions',
      workerRunId: input.workerRunId,
      siteId: session.siteId,
      stationId: session.stationId,
      sessionId: session.sessionId,
      operationId: action.operationId,
      method: action.method,
      path: action.path,
      args,
      summary: {
        action: kind,
        stationId: session.ocppStationId,
        transactionId: session.transactionId,
        reason: session.reason,
        rationale: {
          code: STUCK_RATIONALE_CODES[session.reason],
          params: { minutes: Math.max(idleMinutes, input.idleMinutes) },
        },
        lastActivityAt: session.lastActivityAt.toISOString(),
        transactionOngoing,
        billing: {
          code: stuckBillingCode(kind, transactionOngoing),
          params: {
            energyWh: session.energyWh,
            costCents: session.currentCostCents,
            currency: session.currency,
          },
        },
      },
      precondition: {
        kind: 'session_active',
        params: {
          sessionId: session.sessionId,
          transactionId: session.transactionId,
          stationOnline,
        },
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
