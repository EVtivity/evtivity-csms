// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { getQueryKeysForEvent, IMMEDIATE_EVENT_TYPES, type CsmsEvent } from '../event-query-keys';

function makeEvent(eventType: string, extra: Partial<CsmsEvent> = {}): CsmsEvent {
  return {
    eventType,
    stationId: null,
    siteId: null,
    sessionId: null,
    caseId: null,
    runId: null,
    ...extra,
  };
}

function hasKey(keys: string[][], key: string[]): boolean {
  return keys.some((k) => k.length === key.length && k.every((p, i) => p === key[i]));
}

describe('getQueryKeysForEvent', () => {
  it('invalidates the authorize-log on authorize.attempt', () => {
    const keys = getQueryKeysForEvent(makeEvent('authorize.attempt'));
    expect(hasKey(keys, ['authorize-attempts'])).toBe(true);
  });

  it('invalidates the reservations list on reservation.changed', () => {
    const keys = getQueryKeysForEvent(makeEvent('reservation.changed'));
    expect(hasKey(keys, ['reservations'])).toBe(true);
  });

  it('invalidates roaming sessions on roaming.session.changed', () => {
    const keys = getQueryKeysForEvent(makeEvent('roaming.session.changed'));
    expect(hasKey(keys, ['ocpi-sessions'])).toBe(true);
  });

  it('invalidates roaming CDRs on roaming.cdr.changed', () => {
    const keys = getQueryKeysForEvent(makeEvent('roaming.cdr.changed'));
    expect(hasKey(keys, ['ocpi-cdrs'])).toBe(true);
  });

  describe('access.log routes by category', () => {
    it('csms category -> access-logs-csms only', () => {
      const keys = getQueryKeysForEvent(makeEvent('access.log', { category: 'csms' }));
      expect(hasKey(keys, ['access-logs-csms'])).toBe(true);
      expect(hasKey(keys, ['access-logs-portal'])).toBe(false);
      expect(hasKey(keys, ['access-logs-api'])).toBe(false);
    });

    it('portal category -> access-logs-portal only', () => {
      const keys = getQueryKeysForEvent(makeEvent('access.log', { category: 'portal' }));
      expect(hasKey(keys, ['access-logs-portal'])).toBe(true);
      expect(hasKey(keys, ['access-logs-csms'])).toBe(false);
    });

    it('api category -> access-logs-api only', () => {
      const keys = getQueryKeysForEvent(makeEvent('access.log', { category: 'api' }));
      expect(hasKey(keys, ['access-logs-api'])).toBe(true);
      expect(hasKey(keys, ['access-logs-csms'])).toBe(false);
    });

    it('unknown category -> no keys', () => {
      const keys = getQueryKeysForEvent(makeEvent('access.log', { category: 'other' }));
      expect(keys).toHaveLength(0);
    });
  });

  it('invalidates support-cases list, detail (via prefix), and unread count on supportCase.newMessage', () => {
    const keys = getQueryKeysForEvent(makeEvent('supportCase.newMessage', { caseId: 'case-1' }));
    // ['support-cases'] is a prefix of the detail key ['support-cases', id].
    expect(hasKey(keys, ['support-cases'])).toBe(true);
    expect(hasKey(keys, ['support-cases-unread-count'])).toBe(true);
  });

  it('treats support-case events as immediate (bypass the invalidation throttle)', () => {
    expect(IMMEDIATE_EVENT_TYPES.has('supportCase.newMessage')).toBe(true);
    expect(IMMEDIATE_EVENT_TYPES.has('supportCase.created')).toBe(true);
    expect(IMMEDIATE_EVENT_TYPES.has('supportCase.updated')).toBe(true);
    // High-frequency station events stay throttled.
    expect(IMMEDIATE_EVENT_TYPES.has('station.status')).toBe(false);
  });

  it('returns no keys for an unknown event type', () => {
    expect(getQueryKeysForEvent(makeEvent('nope.unknown'))).toHaveLength(0);
  });

  it('still maps a pre-existing event (station.status) including station-scoped keys', () => {
    const keys = getQueryKeysForEvent(makeEvent('station.status', { stationId: 'CS-1' }));
    expect(hasKey(keys, ['stations'])).toBe(true);
    expect(hasKey(keys, ['stations', 'CS-1'])).toBe(true);
  });
});
