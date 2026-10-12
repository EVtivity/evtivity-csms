// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import type { AiInsightDto } from '@evtivity/lib/ai-insights';
import {
  EXPLAIN_HEADLINE_MAX_CHARS,
  EXPLAIN_MAX_EVENTS,
  buildExplainContext,
  insightHeadline,
} from '../services/ai/engine/explain-engine.js';
import type { ExplainEvidence } from '../services/ai/engine/explain-engine.js';

const INSIGHT: AiInsightDto = {
  id: 'ins_1',
  kind: 'station_offline',
  status: 'active',
  skipReason: null,
  siteId: 'site_1',
  stationId: 'sta_1',
  sessionId: null,
  authorizeAttemptId: null,
  reservationId: null,
  parentInsightId: null,
  category: 'connectivity',
  confidence: 'high',
  fixes: [{ code: 'check_network_connection', note: 'Check the modem.' }],
  scope: { site: { stations: 4, stationsOffline: 1 } },
  generatedBy: 'model',
  language: 'en',
  summary: 'The station lost its network link. It last sent a heartbeat an hour ago.',
  textStatus: 'ready',
  stale: false,
  basisAt: '2026-10-10T11:58:00Z',
  createdAt: '2026-10-10T11:59:00Z',
  resolvedAt: null,
  dismissedAt: null,
  action: null,
};

function at(minute: number): string {
  return `2026-10-10T11:${String(minute).padStart(2, '0')}:00.000Z`;
}

describe('Explain context engine', () => {
  it('station: curated facts, the newest events with their station text, nulls left out', () => {
    const evidence: ExplainEvidence = {
      facts: {
        stationId: 'CS-1',
        vendor: 'Acme',
        isOnline: false,
        heartbeatAgeSeconds: 3600,
        firmwareState: null,
        internalNote: 'not curated',
      },
      items: [
        ...Array.from({ length: 12 }, (_, i) => ({
          id: `conn:${String(i)}`,
          kind: 'connection_event',
          data: { event: 'disconnected', reason: null, at: at(i) },
        })),
        { id: 'error:1', kind: 'status_error', data: { errorCode: 'GroundFailure', at: at(30) } },
        { id: 'other:1', kind: 'meter_value', data: { value: 1, at: at(59) } },
      ],
      untrusted: [
        { id: 'error:1', source: 'station_vendor_error_code', text: 'E42' },
        { id: 'station', source: 'station_model', text: 'X1' },
      ],
    };
    const ctx = buildExplainContext(
      'station',
      { stationId: 'CS-1', model: 'X1', firmwareVersion: null, isOnline: false },
      evidence,
      INSIGHT,
    );
    expect(ctx.record).toEqual({
      stationId: 'CS-1',
      vendor: 'Acme',
      model: 'X1',
      isOnline: false,
      heartbeatAgeSeconds: 3600,
    });
    const events = ctx.recentEvents as Record<string, unknown>[];
    expect(events).toHaveLength(EXPLAIN_MAX_EVENTS);
    expect(events[0]).toEqual({
      kind: 'status_error',
      errorCode: 'GroundFailure',
      at: at(30),
      stationText: { station_vendor_error_code: 'E42' },
    });
    expect(events[1]).toEqual({ kind: 'connection_event', event: 'disconnected', at: at(11) });
    expect(events.some((e) => e['kind'] === 'meter_value')).toBe(false);
    expect(ctx.latestInsight).toEqual({
      kind: 'station_offline',
      headline: 'The station lost its network link.',
      cause: 'connectivity',
      confidence: 'high',
      fixes: [{ code: 'check_network_connection', note: 'Check the modem.' }],
      siteScope: { stations: 4, stationsOffline: 1 },
    });
    expect(JSON.stringify(ctx)).not.toContain('heartbeat an hour ago');
    expect(JSON.stringify(ctx)).not.toContain('not curated');
  });

  it('session: status, stop reason, cost and the transaction, payment and authorize events', () => {
    const ctx = buildExplainContext(
      'session',
      { sessionId: 'ses_1', stationId: 'CS-1', status: 'failed', stoppedReason: 'EVDisconnected' },
      {
        facts: { finalCostCents: 0, currency: 'EUR', currentCostCents: 12, stationCostCents: 3 },
        items: [
          { id: 'tx:1', kind: 'transaction_event', data: { eventType: 'ended', at: at(10) } },
          { id: 'payment:1', kind: 'payment_record', data: { status: 'failed' } },
          { id: 'meter:1', kind: 'first_energy_reading', data: { value: '0', at: at(1) } },
          { id: 'meter:2', kind: 'last_energy_reading', data: { value: '12', at: at(9) } },
        ],
        untrusted: [{ id: 'payment:1', source: 'payment_failure_reason', text: 'card_declined' }],
      },
      null,
    );
    expect(ctx.record).toEqual({
      stationId: 'CS-1',
      status: 'failed',
      stoppedReason: 'EVDisconnected',
      finalCostCents: 0,
      currency: 'EUR',
    });
    expect(ctx.recentEvents).toEqual([
      {
        kind: 'payment_record',
        status: 'failed',
        stationText: { payment_failure_reason: 'card_declined' },
      },
      { kind: 'transaction_event', eventType: 'ended', at: at(10) },
      { kind: 'last_energy_reading', value: '12', at: at(9) },
    ]);
    expect(ctx).not.toHaveProperty('latestInsight');
  });

  it('authorization: the attempt and the token state, never the token value', () => {
    const ctx = buildExplainContext(
      'authorization',
      { attemptId: 7, stationId: 'CS-1', outcome: 'blocked', reason: 'token_blocked' },
      {
        facts: { idToken: 'RFID-1', refusals: 3, tokenKnown: true, tokenActive: false },
        items: [
          { id: 'auth:7', kind: 'authorize_attempt', data: { outcome: 'blocked', at: at(5) } },
        ],
        untrusted: [],
      },
      null,
    );
    expect(ctx.record).toEqual({
      stationId: 'CS-1',
      outcome: 'blocked',
      reason: 'token_blocked',
      refusals: 3,
      tokenKnown: true,
      tokenActive: false,
    });
    expect(JSON.stringify(ctx)).not.toContain('RFID-1');
    expect(ctx.recentEvents).toEqual([
      { kind: 'authorize_attempt', outcome: 'blocked', at: at(5) },
    ]);
  });

  it('reservation: its state, four station facts and the reservation events', () => {
    const ctx = buildExplainContext(
      'reservation',
      {
        reservationId: 7,
        stationId: 'CS-1',
        status: 'cancelled',
        cancelReason: 'station_rejected',
      },
      {
        facts: {
          driverRef: 'drv-hash',
          noShowFeeState: 'none',
          station: { isOnline: true, reportedStatus: 'Faulted', vendor: 'Acme', lastBootAt: null },
        },
        items: [
          { id: 'audit:1', kind: 'reservation_audit', data: { action: 'cancelled', at: at(3) } },
          { id: 'status:1', kind: 'status_transition', data: { newStatus: 'Faulted', at: at(4) } },
        ],
        untrusted: [],
      },
      { ...INSIGHT, kind: 'reservation_rejected', summary: null, fixes: [] },
    );
    expect(ctx.record).toEqual({
      reservationId: 7,
      stationId: 'CS-1',
      status: 'cancelled',
      cancelReason: 'station_rejected',
      noShowFeeState: 'none',
      station: { isOnline: true, reportedStatus: 'Faulted' },
    });
    expect(ctx.recentEvents).toEqual([
      { kind: 'reservation_audit', action: 'cancelled', at: at(3) },
    ]);
    expect(ctx.latestInsight).toEqual({
      kind: 'reservation_rejected',
      cause: 'connectivity',
      confidence: 'high',
      fixes: [],
      siteScope: { stations: 4, stationsOffline: 1 },
    });
  });

  it('no evidence: the record facts only', () => {
    const ctx = buildExplainContext('station', { stationId: 'CS-1' }, null, null);
    expect(ctx).toEqual({ kind: 'station', record: { stationId: 'CS-1' } });
  });

  it('the headline is the first sentence, cut to its limit', () => {
    expect(insightHeadline('Offline. Since noon.')).toBe('Offline.');
    expect(insightHeadline('离线了。从中午开始。')).toBe('离线了。');
    expect(insightHeadline('v1.2 firmware is old')).toBe('v1.2 firmware is old');
    expect(insightHeadline('  ')).toBeNull();
    expect(insightHeadline(null)).toBeNull();
    const long = insightHeadline('x'.repeat(500));
    expect(long).toHaveLength(EXPLAIN_HEADLINE_MAX_CHARS);
    expect(long?.endsWith('…')).toBe(true);
  });
});
