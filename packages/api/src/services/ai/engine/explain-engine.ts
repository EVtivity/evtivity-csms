// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The Explain context engine: the one place that decides what an Explain
 * conversation tells the model about its record, for every kind (station,
 * session, authorization, reservation).
 *
 * - Per kind a short, curated list of fact fields and event kinds
 *   (`EXPLAIN_CONTEXT_SPEC`). A field the record or its evidence does not
 *   list, and a null value, is left out.
 * - The `EXPLAIN_MAX_EVENTS` newest events of the listed kinds, each with the
 *   station-supplied text that belongs to it (vendor error codes, alert info).
 * - The latest insight as its headline (the first sentence of the summary),
 *   root cause, confidence, fixes and site counts. Never the insight body or
 *   the raw insight object.
 *
 * Pure: the caller reads the record, the evidence pack and the insight, then
 * redacts and frames the result (`explainPromptBlock`).
 */

import type { AiContextKind, AiInsightDto } from '@evtivity/lib/ai-insights';

/** The evidence of one record: the pack the insight collectors build. */
export interface ExplainEvidence {
  facts: Record<string, unknown>;
  items: readonly { id: string; kind: string; data: Record<string, unknown> }[];
  /** Station-supplied strings, by the id of the item they belong to. */
  untrusted: readonly { id: string; source: string; text: string }[];
}

export interface ExplainKindSpec {
  /** Fact fields, in order. `station.x` reads `x` of the nested station facts. */
  facts: readonly string[];
  /** Evidence item kinds kept as recent events. */
  events: readonly string[];
}

export const EXPLAIN_MAX_EVENTS = 8;
export const EXPLAIN_HEADLINE_MAX_CHARS = 200;

export const EXPLAIN_CONTEXT_SPEC: Readonly<Record<AiContextKind, ExplainKindSpec>> = {
  station: {
    facts: [
      'stationId',
      'vendor',
      'model',
      'firmwareVersion',
      'ocppProtocol',
      'isOnline',
      'lastHeartbeat',
      'heartbeatAgeSeconds',
      'availability',
      'reportedStatus',
      'statusReason',
      'disabledReason',
      'firmwareState',
      'lastBootAt',
      'lastBootReason',
    ],
    events: ['status_transition', 'connection_event', 'station_alert', 'status_error'],
  },
  session: {
    facts: [
      'stationId',
      'status',
      'stoppedReason',
      'startedAt',
      'endedAt',
      'energyDeliveredWh',
      'finalCostCents',
      'currency',
      'isRoaming',
    ],
    events: ['transaction_event', 'payment_record', 'authorize_attempt', 'last_energy_reading'],
  },
  authorization: {
    facts: [
      'stationId',
      'outcome',
      'reason',
      'tokenType',
      'ocppVersion',
      'createdAt',
      'refusals',
      'tokenKnown',
      'tokenActive',
      'tokenExpired',
      'tokenRevoked',
      'prepaid',
      'prepaidCreditLeft',
      'driverActive',
      'fleetCreditLimited',
      'localListEntry',
      'localListPushed',
    ],
    events: ['authorize_attempt'],
  },
  reservation: {
    facts: [
      'reservationId',
      'stationId',
      'evseId',
      'status',
      'startsAt',
      'expiresAt',
      'cancelledBy',
      'cancelReason',
      'stationAckAt',
      'noShowFeeState',
      'cancellationFeeCents',
      'hasToken',
      'station.isOnline',
      'station.availability',
      'station.reportedStatus',
      'station.lastHeartbeat',
    ],
    events: [
      'reservation_audit',
      'ocpp_message',
      'reservation_fee_payment',
      'status_error',
      'connection_event',
    ],
  },
};

/** The insight part of the context: what it says, not its body. */
export interface ExplainInsightContext {
  kind: string;
  headline?: string;
  cause: string | null;
  confidence: string | null;
  fixes: { code: string; note?: string }[];
  siteScope?: unknown;
}

export interface ExplainContextPayload {
  kind: AiContextKind;
  record: Record<string, unknown>;
  recentEvents?: Record<string, unknown>[] | string;
  latestInsight?: ExplainInsightContext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function present(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

/** The curated facts: record fields win over the evidence facts of the same name. */
export function curatedFacts(
  kind: AiContextKind,
  record: Record<string, unknown>,
  evidenceFacts: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...evidenceFacts, ...record };
  const out: Record<string, unknown> = {};
  for (const field of EXPLAIN_CONTEXT_SPEC[kind].facts) {
    const dot = field.indexOf('.');
    if (dot === -1) {
      const value = merged[field];
      if (present(value)) out[field] = value;
      continue;
    }
    const parent = field.slice(0, dot);
    const child = field.slice(dot + 1);
    const nested = evidenceFacts[parent];
    if (!isRecord(nested) || !present(nested[child])) continue;
    const target = isRecord(out[parent]) ? out[parent] : {};
    target[child] = nested[child];
    out[parent] = target;
  }
  return out;
}

function eventTime(data: Record<string, unknown>): number | null {
  const at = data['at'];
  if (typeof at !== 'string') return null;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The newest events of the kind's listed item kinds, newest first. Items
 * without a time (a payment record) come first: there are at most a few.
 */
export function recentEvents(
  kind: AiContextKind,
  evidence: ExplainEvidence,
): Record<string, unknown>[] {
  const allowed = new Set(EXPLAIN_CONTEXT_SPEC[kind].events);
  const kept = evidence.items.filter((i) => allowed.has(i.kind));
  const undated = kept.filter((i) => eventTime(i.data) === null);
  const dated = kept
    .filter((i) => eventTime(i.data) !== null)
    .sort((a, b) => (eventTime(b.data) ?? 0) - (eventTime(a.data) ?? 0));
  return [...undated, ...dated].slice(0, EXPLAIN_MAX_EVENTS).map((item) => {
    const event: Record<string, unknown> = { kind: item.kind };
    for (const [key, value] of Object.entries(item.data)) {
      if (present(value)) event[key] = value;
    }
    const text = evidence.untrusted.filter((u) => u.id === item.id);
    if (text.length > 0) {
      event['stationText'] = Object.fromEntries(text.map((u) => [u.source, u.text]));
    }
    return event;
  });
}

/** The first sentence of an insight summary, cut to `EXPLAIN_HEADLINE_MAX_CHARS`. */
export function insightHeadline(summary: string | null): string | null {
  if (summary == null) return null;
  const text = summary.trim();
  if (text === '') return null;
  // A Latin stop ends a sentence before a space; a CJK full stop always does.
  const end = /[.!?](?=\s|$)|[。！？]/u.exec(text);
  const first = end === null ? text : text.slice(0, end.index + 1);
  return first.length > EXPLAIN_HEADLINE_MAX_CHARS
    ? `${first.slice(0, EXPLAIN_HEADLINE_MAX_CHARS - 1)}…`
    : first;
}

export function insightContext(insight: AiInsightDto): ExplainInsightContext {
  const headline = insightHeadline(insight.summary);
  return {
    kind: insight.kind,
    ...(headline !== null ? { headline } : {}),
    cause: insight.category,
    confidence: insight.confidence,
    fixes: insight.fixes.map((f) => ({
      code: f.code,
      ...(f.note !== undefined ? { note: f.note } : {}),
    })),
    // The site counts are the only scope an insight carries.
    ...(insight.scope.site !== undefined ? { siteScope: insight.scope.site } : {}),
  };
}

/** The curated Explain context of one record. */
export function buildExplainContext(
  kind: AiContextKind,
  record: Record<string, unknown>,
  evidence: ExplainEvidence | null,
  insight: AiInsightDto | null,
): ExplainContextPayload {
  const payload: ExplainContextPayload = {
    kind,
    record: curatedFacts(kind, record, evidence?.facts ?? {}),
  };
  if (evidence !== null) {
    const events = recentEvents(kind, evidence);
    if (events.length > 0) payload.recentEvents = events;
  }
  if (insight !== null) payload.latestInsight = insightContext(insight);
  return payload;
}
