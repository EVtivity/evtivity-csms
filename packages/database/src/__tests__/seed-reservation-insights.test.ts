// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  INSIGHT_KIND_FALLBACKS,
  RESERVATION_INSIGHT_KINDS,
  RESERVATION_INSIGHT_TRIGGERS,
  reservationAuditRaisesInsight,
  reservationRuleInsightFor,
} from '@evtivity/lib/ai-insights';
import {
  RESERVATION_INSIGHT_DEMO_IDS,
  demoRuleInsight,
  reservationInsightDemoPlan,
} from '../seed-reservation-insights.js';

describe('reservationInsightDemoPlan', () => {
  const now = new Date('2026-10-11T12:00:00Z');
  const plan = reservationInsightDemoPlan(now);
  const triggers = plan.flatMap((r) =>
    r.audits
      .filter((a) => Object.hasOwn(RESERVATION_INSIGHT_TRIGGERS, a.action))
      .map((a) => ({ reservation: r, audit: a })),
  );

  it('raises exactly one insight of each reservation kind', () => {
    const kinds = triggers.map(
      ({ audit }) =>
        RESERVATION_INSIGHT_TRIGGERS[audit.action as keyof typeof RESERVATION_INSIGHT_TRIGGERS],
    );
    expect([...kinds].sort()).toEqual([...RESERVATION_INSIGHT_KINDS].sort());
    for (const { audit } of triggers) {
      expect(reservationAuditRaisesInsight(audit.action, audit.reason)).toBe(true);
    }
  });

  it('keys the reservations by fixed ids in the createId format', () => {
    expect(plan.map((r) => r.id)).toEqual(Object.values(RESERVATION_INSIGHT_DEMO_IDS));
    for (const r of plan) expect(r.id).toMatch(/^rsv_[0-9a-z]{12}$/);
  });

  it('leaves each reservation in the state its trigger implies, all in the past', () => {
    for (const r of plan) {
      expect(r.expiresAt.getTime()).toBeLessThan(now.getTime());
      expect(r.createdAt.getTime()).toBeLessThan(r.expiresAt.getTime());
    }
    const byId = new Map(plan.map((r) => [r.id, r]));
    expect(byId.get(RESERVATION_INSIGHT_DEMO_IDS.rejected)).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'system',
      cancelReason: 'station_rejected_occupied',
      stationAckAt: null,
    });
    expect(byId.get(RESERVATION_INSIGHT_DEMO_IDS.cancelFailed)).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'operator',
    });
    expect(byId.get(RESERVATION_INSIGHT_DEMO_IDS.stationFaulted)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'station_unavailable_during_hold',
    });
    const noShow = byId.get(RESERVATION_INSIGHT_DEMO_IDS.noShowFeeFailed);
    expect(noShow).toMatchObject({
      status: 'expired',
      noShowFeeState: 'failed',
      declinedNoShowFee: true,
    });
    expect(noShow?.stationAckAt).not.toBeNull();
    // The expiry is audited before the fee that follows it.
    expect(noShow?.audits.map((a) => a.action)).toEqual(['expired', 'fee_failed']);
  });

  it('stores the rule of a known cause at high confidence, else the kind fallback at low', () => {
    for (const { audit } of triggers) {
      const action = audit.action as keyof typeof RESERVATION_INSIGHT_TRIGGERS;
      const result = demoRuleInsight(action, audit.reason);
      const known = reservationRuleInsightFor(action, audit.reason);
      if (known != null) {
        expect(result).toMatchObject({ rule: known, confidence: 'high' });
      } else {
        expect(result).toMatchObject({
          rule: INSIGHT_KIND_FALLBACKS[result.kind],
          confidence: 'low',
        });
      }
    }
    expect(demoRuleInsight('station_faulted', 'station_unavailable_during_hold').confidence).toBe(
      'low',
    );
    expect(demoRuleInsight('expired', 'no_show').confidence).toBe('high');
  });
});
