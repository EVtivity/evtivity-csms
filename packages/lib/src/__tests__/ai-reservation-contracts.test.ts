// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  AI_CONTEXT_KINDS,
  AI_INSIGHT_SETTING_KEYS,
  FIX_CODES,
  INSIGHT_KINDS,
  RESERVATION_CANCEL_FAILURE_REASONS,
  RESERVATION_EXPIRY_REASONS,
  RESERVATION_FEE_FAILURE_REASONS,
  RESERVATION_FIX_CODES,
  RESERVATION_INSIGHT_ACTIONS,
  RESERVATION_INSIGHT_KINDS,
  RESERVATION_INSIGHT_TRIGGERS,
  RESERVATION_REJECT_REASONS,
  ROOT_CAUSE_CATEGORIES,
  RULE_INSIGHTS,
  aiInsightDtoSchema,
  insightScopeSchema,
  isReservationInsightKind,
  reservationAuditRaisesInsight,
  reservationAuditReason,
  reservationRuleInsightFor,
} from '../ai-insights.js';

// Reasons each trigger action writes (plan sections 3.2 and 4.1).
const REASONS_BY_ACTION: Readonly<Record<string, readonly string[]>> = {
  station_rejected: RESERVATION_REJECT_REASONS,
  station_cancel_failed: RESERVATION_CANCEL_FAILURE_REASONS,
  fee_failed: RESERVATION_FEE_FAILURE_REASONS,
  expired: RESERVATION_EXPIRY_REASONS,
  station_faulted: ['station_unavailable_during_hold'],
};

describe('reservation insight contracts', () => {
  it('lists the reservation kinds, fix codes and context kind in the main lists (I1)', () => {
    expect(new Set(RESERVATION_INSIGHT_KINDS).size).toBe(5);
    expect(new Set(RESERVATION_FIX_CODES).size).toBe(5);
    for (const kind of RESERVATION_INSIGHT_KINDS) expect(INSIGHT_KINDS).toContain(kind);
    for (const code of RESERVATION_FIX_CODES) expect(FIX_CODES).toContain(code);
    expect(new Set(INSIGHT_KINDS).size).toBe(INSIGHT_KINDS.length);
    expect(new Set(FIX_CODES).size).toBe(FIX_CODES.length);
    expect(AI_CONTEXT_KINDS).toContain('reservation');
    expect(isReservationInsightKind('reservation_no_show')).toBe(true);
    expect(isReservationInsightKind('session_failed')).toBe(false);
  });

  it('maps every trigger action to one reservation kind and back', () => {
    const kinds = Object.values(RESERVATION_INSIGHT_TRIGGERS);
    expect([...kinds].sort()).toEqual([...RESERVATION_INSIGHT_KINDS].sort());
    expect(Object.keys(RESERVATION_INSIGHT_TRIGGERS).sort()).toEqual(
      Object.keys(REASONS_BY_ACTION).sort(),
    );
    for (const [action, kind] of Object.entries(RESERVATION_INSIGHT_TRIGGERS)) {
      expect(RESERVATION_INSIGHT_ACTIONS[kind]).toBe(action);
    }
  });

  it('TC-AI-RI-02 keys every reservation rule by a trigger action and a reason that action writes', () => {
    const keys = Object.keys(RULE_INSIGHTS).filter((k) => k.includes(':'));
    expect(keys.length).toBe(8);
    for (const key of keys) {
      const rule = RULE_INSIGHTS[key];
      const [action = '', reason = ''] = key.split(':');
      expect(Object.keys(RESERVATION_INSIGHT_TRIGGERS), key).toContain(action);
      expect(REASONS_BY_ACTION[action], key).toContain(reason);
      expect(ROOT_CAUSE_CATEGORIES, key).toContain(rule?.category);
      expect(rule?.fixes.length, key).toBeGreaterThan(0);
      for (const fix of rule?.fixes ?? [])
        expect(FIX_CODES as readonly string[], key).toContain(fix);
    }
  });

  it('TC-AI-RI-02 gives known causes a rule insight and sends the others to the model', () => {
    for (const reason of [
      'station_rejected_occupied',
      'evse_in_use_at_activation',
      'station_offline_at_activation',
      'station_faulted_at_activation',
    ]) {
      expect(reservationRuleInsightFor('station_rejected', reason), reason).toBeDefined();
    }
    expect(reservationRuleInsightFor('expired', 'no_show')).toBeDefined();
    expect(reservationRuleInsightFor('station_cancel_failed', 'station_offline')).toBeDefined();
    expect(reservationRuleInsightFor('fee_failed', 'declined')?.category).toBe('payment');
    expect(reservationRuleInsightFor('fee_failed', 'no_payment_method')?.category).toBe('payment');
    // Model cases.
    expect(reservationRuleInsightFor('station_rejected', 'station_rejected_other')).toBeUndefined();
    expect(reservationRuleInsightFor('station_rejected', 'station_no_response')).toBeUndefined();
    expect(reservationRuleInsightFor('station_rejected', null)).toBeUndefined();
    expect(reservationRuleInsightFor('station_cancel_failed', 'station_rejected')).toBeUndefined();
    expect(reservationRuleInsightFor('fee_failed', 'provider_error')).toBeUndefined();
    expect(reservationRuleInsightFor('station_faulted', 'station_unavailable_during_hold')).toBe(
      undefined,
    );
    // Only reservation actions read the reservation keys: a token "expired" outcome is not a no-show.
    expect(reservationRuleInsightFor('toString', null)).toBeUndefined();
    expect(reservationRuleInsightFor('expired', null)).toBeUndefined();
    expect(RULE_INSIGHTS['expired']?.category).toBe('token');
  });

  it('raises a no-show only for an expired row with reason no_show', () => {
    expect(reservationAuditRaisesInsight('expired', 'no_show')).toBe(true);
    for (const reason of ['not_on_station', 'waived', 'no_driver', null]) {
      expect(reservationAuditRaisesInsight('expired', reason), String(reason)).toBe(false);
    }
    expect(reservationAuditRaisesInsight('station_rejected', 'station_rejected_other')).toBe(true);
    expect(reservationAuditRaisesInsight('station_faulted', null)).toBe(true);
    expect(reservationAuditRaisesInsight('cancelled', 'driver_initiated')).toBe(false);
    expect(reservationAuditRaisesInsight('fee_charged', null)).toBe(false);
  });

  it('reads the reason of an audit row from after.reason', () => {
    expect(
      reservationAuditReason({ status: 'cancelled', reason: 'station_rejected_occupied' }),
    ).toBe('station_rejected_occupied');
    expect(reservationAuditReason({ status: 'expired' })).toBeNull();
    expect(reservationAuditReason({ reason: '' })).toBeNull();
    expect(reservationAuditReason({ reason: 3 })).toBeNull();
    expect(reservationAuditReason(null)).toBeNull();
    expect(reservationAuditReason(['reason'])).toBeNull();
  });

  it('names the reservation switch under the insight keys', () => {
    expect(AI_INSIGHT_SETTING_KEYS.reservationEnabled).toBe('aiInsights.reservation.enabled');
  });
});

describe('insight scope and DTO (TC-AI-IC-04)', () => {
  it('has no network field: a stored network key is dropped on parse', () => {
    expect(Object.keys(insightScopeSchema.shape)).toEqual([
      'site',
      'stationOffline',
      'concurrentSession',
    ]);
    const parsed = insightScopeSchema.parse({ site: { stations: 2 }, network: { stations: 9 } });
    expect(parsed).toEqual({ site: { stations: 2 } });
  });

  it('carries the reservation id of a reservation insight', () => {
    expect(Object.keys(aiInsightDtoSchema.shape)).toContain('reservationId');
  });
});
