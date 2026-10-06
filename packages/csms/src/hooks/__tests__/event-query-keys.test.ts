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

  describe('station.status', () => {
    it('adds site-scoped keys when a site is given', () => {
      const keys = getQueryKeysForEvent(makeEvent('station.status', { siteId: 'S-1' }));
      expect(hasKey(keys, ['dashboard', 'station-status'])).toBe(true);
      expect(hasKey(keys, ['sites', 'S-1', 'stations'])).toBe(true);
      expect(hasKey(keys, ['sites', 'S-1', 'layout'])).toBe(true);
      expect(keys.some((k) => k[0] === 'stations' && k.length > 1)).toBe(false);
    });
  });

  describe.each(['session.started', 'session.ended'])('%s', (type) => {
    it('refreshes dashboard, list, station and site keys', () => {
      const keys = getQueryKeysForEvent(makeEvent(type, { stationId: 'CS-1', siteId: 'S-1' }));
      expect(hasKey(keys, ['dashboard', 'session-history'])).toBe(true);
      expect(hasKey(keys, ['dashboard', 'revenue-history'])).toBe(true);
      expect(hasKey(keys, ['sessions'])).toBe(true);
      expect(hasKey(keys, ['transactions'])).toBe(true);
      expect(hasKey(keys, ['stations', 'CS-1', 'sessions'])).toBe(true);
      expect(hasKey(keys, ['sites', 'S-1', 'revenue-history'])).toBe(true);
    });

    it('omits entity keys without a station or site', () => {
      const keys = getQueryKeysForEvent(makeEvent(type));
      expect(keys.some((k) => k[0] === 'stations' || k[0] === 'sites')).toBe(false);
      expect(hasKey(keys, ['dashboard', 'stats'])).toBe(true);
    });
  });

  it('session.updated refreshes lists and entity sessions without touching the dashboard', () => {
    const keys = getQueryKeysForEvent(
      makeEvent('session.updated', { stationId: 'CS-1', siteId: 'S-1' }),
    );
    expect(hasKey(keys, ['sessions'])).toBe(true);
    expect(hasKey(keys, ['stations', 'CS-1', 'metrics'])).toBe(true);
    expect(hasKey(keys, ['sites', 'S-1', 'sessions'])).toBe(true);
    expect(keys.some((k) => k[0] === 'dashboard')).toBe(false);
    expect(getQueryKeysForEvent(makeEvent('session.updated'))).toEqual([
      ['sessions'],
      ['transactions'],
    ]);
  });

  it('meter.values refreshes station and site energy keys', () => {
    const keys = getQueryKeysForEvent(
      makeEvent('meter.values', { stationId: 'CS-1', siteId: 'S-1' }),
    );
    expect(hasKey(keys, ['stations', 'CS-1', 'meter-values'])).toBe(true);
    expect(hasKey(keys, ['station-meter-values'])).toBe(true);
    expect(hasKey(keys, ['sites', 'S-1', 'load-management'])).toBe(true);
    expect(hasKey(keys, ['sites', 'S-1', 'energy-history'])).toBe(true);
    expect(getQueryKeysForEvent(makeEvent('meter.values'))).toEqual([
      ['dashboard', 'financial-stats'],
      ['dashboard', 'revenue-history'],
    ]);
  });

  it('payment.settled refreshes financial keys and reservation fee payments', () => {
    const keys = getQueryKeysForEvent(makeEvent('payment.settled'));
    expect(hasKey(keys, ['dashboard', 'payment-breakdown'])).toBe(true);
    expect(hasKey(keys, ['transactions'])).toBe(true);
    expect(hasKey(keys, ['reservation-fee-payments'])).toBe(true);
  });

  it('load.updated needs a site', () => {
    expect(getQueryKeysForEvent(makeEvent('load.updated', { siteId: 'S-1' }))).toEqual([
      ['sites', 'S-1', 'load-management'],
    ]);
    expect(getQueryKeysForEvent(makeEvent('load.updated'))).toEqual([]);
  });

  it('ocpp.message needs a station', () => {
    expect(getQueryKeysForEvent(makeEvent('ocpp.message', { stationId: 'CS-1' }))).toEqual([
      ['stations', 'CS-1', 'ocpp-logs'],
    ]);
    expect(getQueryKeysForEvent(makeEvent('ocpp.message'))).toEqual([]);
  });

  it('station.securityEvent refreshes security logs and the station detail', () => {
    const keys = getQueryKeysForEvent(makeEvent('station.securityEvent', { stationId: 'CS-1' }));
    expect(hasKey(keys, ['stations', 'CS-1', 'security-logs'])).toBe(true);
    expect(hasKey(keys, ['stations', 'CS-1', 'security-events'])).toBe(true);
    expect(hasKey(keys, ['stations', 'CS-1'])).toBe(true);
    expect(getQueryKeysForEvent(makeEvent('station.securityEvent'))).toEqual([]);
  });

  it('ocpp.health refreshes the OCPP health card', () => {
    expect(getQueryKeysForEvent(makeEvent('ocpp.health'))).toEqual([['dashboard', 'ocpp-health']]);
  });

  it.each(['certificate.signed', 'certificate.expiring', 'certificate.expired'])(
    '%s refreshes certificate lists and the station certificates tab',
    (type) => {
      const keys = getQueryKeysForEvent(makeEvent(type, { stationId: 'CS-1' }));
      expect(hasKey(keys, ['pnc-ca-certificates'])).toBe(true);
      expect(hasKey(keys, ['pnc-station-certificates'])).toBe(true);
      expect(hasKey(keys, ['pnc-csr-requests'])).toBe(true);
      expect(hasKey(keys, ['stations', 'CS-1', 'certificates'])).toBe(true);
      expect(getQueryKeysForEvent(makeEvent(type))).toHaveLength(3);
    },
  );

  it('octt.progress refreshes the run list and the run detail as strings', () => {
    const keys = getQueryKeysForEvent(makeEvent('octt.progress', { runId: 7 }));
    expect(keys).toEqual([['octt-runs'], ['octt-runs', '7'], ['octt-runs', '7', 'summary']]);
    expect(getQueryKeysForEvent(makeEvent('octt.progress'))).toEqual([['octt-runs']]);
  });

  it.each(['firmwareCampaign.stationUpdated', 'firmwareCampaign.completed'])(
    '%s refreshes firmware campaigns',
    (type) => {
      expect(getQueryKeysForEvent(makeEvent(type))).toEqual([['firmware-campaigns']]);
    },
  );

  it('localAuthList.changed targets the station local auth list prefix', () => {
    expect(getQueryKeysForEvent(makeEvent('localAuthList.changed', { stationId: 'CS-1' }))).toEqual(
      [['local-auth-list', 'CS-1']],
    );
    expect(getQueryKeysForEvent(makeEvent('localAuthList.changed'))).toEqual([]);
  });

  it('maintenance.changed refreshes lists and the site', () => {
    const keys = getQueryKeysForEvent(makeEvent('maintenance.changed', { siteId: 'S-1' }));
    expect(keys).toEqual([['maintenance'], ['sites'], ['stations'], ['site', 'S-1']]);
    expect(getQueryKeysForEvent(makeEvent('maintenance.changed'))).toHaveLength(3);
  });

  it('token.changed refreshes tokens and the authorize log', () => {
    expect(getQueryKeysForEvent(makeEvent('token.changed'))).toEqual([
      ['tokens'],
      ['authorize-attempts'],
    ]);
  });

  it('pricing.changed refreshes pricing lists and each affected entity', () => {
    const keys = getQueryKeysForEvent(
      makeEvent('pricing.changed', {
        siteId: 'S-1',
        stationId: 'CS-1',
        driverId: 'D-1',
        fleetId: 'F-1',
      }),
    );
    expect(hasKey(keys, ['pricing-groups'])).toBe(true);
    expect(hasKey(keys, ['active-tariff'])).toBe(true);
    expect(hasKey(keys, ['sites', 'S-1'])).toBe(true);
    expect(hasKey(keys, ['stations', 'CS-1'])).toBe(true);
    expect(hasKey(keys, ['drivers', 'D-1'])).toBe(true);
    expect(hasKey(keys, ['fleets', 'F-1'])).toBe(true);
    expect(getQueryKeysForEvent(makeEvent('pricing.changed'))).toEqual([
      ['pricing-groups'],
      ['pricing-holidays'],
      ['active-tariff'],
      ['pricing-audit'],
    ]);
  });
});
