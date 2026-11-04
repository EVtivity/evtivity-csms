// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import {
  DEPARTURE_CANCEL_REASONS,
  cancelReasonLabel,
  compareDepartures,
  departureTimeLabel,
  DEPARTURE_SOURCES,
  departureSourceLabel,
  isDepartureEditable,
  targetWithMaxLabel,
} from '../departure-types';
import { departureLabel } from '../../layout/layout-departure';
import en from '../../../i18n/locales/en.json';
import de from '../../../i18n/locales/de.json';
import es from '../../../i18n/locales/es.json';
import ko from '../../../i18n/locales/ko.json';
import zh from '../../../i18n/locales/zh.json';
import zhTW from '../../../i18n/locales/zh-TW.json';

const t = ((key: string, opts?: Record<string, unknown>) =>
  opts == null
    ? key
    : `${key}:${Object.entries(opts)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(',')}`) as unknown as TFunction;

describe('departure helpers for bus depot requests', () => {
  it('labels a soc target with its maximum, and leaves the others alone', () => {
    const soc = {
      targetKind: 'soc' as const,
      targetEnergyKwh: null,
      targetSocPercent: 60,
      priority: 5,
    };
    expect(targetWithMaxLabel(t, { ...soc, targetSocMaxPercent: 90 })).toBe(
      'fleets.departures.targetUpTo:target=60%,max=90%',
    );
    expect(targetWithMaxLabel(t, { ...soc, targetSocMaxPercent: null })).toBe('60%');
    expect(
      targetWithMaxLabel(t, {
        targetKind: 'energy',
        targetEnergyKwh: 120,
        targetSocPercent: null,
        priority: 5,
      }),
    ).toBe('120.0 kWh');
  });

  it('shows an ad hoc request as soon as possible', () => {
    expect(departureTimeLabel(t, { departureAt: null }, 'UTC')).toBe(
      'fleets.departures.asSoonAsPossible',
    );
    expect(departureTimeLabel(t, { departureAt: '2026-11-03T05:30:00.000Z' }, 'UTC')).toMatch(
      /5:30/,
    );
  });

  it('sorts ad hoc requests before timed departures, then by time and id', () => {
    const rows = [
      { id: 'b', departureAt: '2026-11-03T06:00:00.000Z' },
      { id: 'c', departureAt: null },
      { id: 'a', departureAt: '2026-11-03T06:00:00.000Z' },
      { id: 'd', departureAt: '2026-11-03T05:00:00.000Z' },
    ];
    expect([...rows].sort(compareDepartures).map((r) => r.id)).toEqual(['c', 'd', 'a', 'b']);
  });

  it('lets a person edit only a scheduled departure no enabled depot system manages', () => {
    expect(isDepartureEditable({ status: 'scheduled' })).toBe(true);
    expect(isDepartureEditable({ status: 'scheduled', managedByDepotSystem: false })).toBe(true);
    expect(isDepartureEditable({ status: 'scheduled', managedByDepotSystem: true })).toBe(false);
    expect(isDepartureEditable({ status: 'cancelled' })).toBe(false);
    expect(isDepartureEditable({ status: 'completed' })).toBe(false);
  });

  it('labels every source, a bus depot system with and without its name', () => {
    expect(departureSourceLabel(t, { source: 'manual' })).toBe('fleets.departures.sources.manual');
    expect(departureSourceLabel(t, { source: 'depot_system', depotSystemName: null })).toBe(
      'fleets.departures.depotSystemBadge',
    );
    expect(departureSourceLabel(t, { source: 'depot_system', depotSystemName: 'North' })).toBe(
      'fleets.departures.depotSystemBadgeNamed:name=North',
    );
    const locales = { en, de, es, ko, zh, 'zh-TW': zhTW } as Record<string, unknown>;
    for (const [lang, locale] of Object.entries(locales)) {
      const deps = (locale as { fleets: { departures: Record<string, unknown> } }).fleets
        .departures;
      const sources = deps['sources'] as Record<string, string>;
      for (const source of DEPARTURE_SOURCES.filter((x) => x !== 'depot_system')) {
        expect(sources[source], `${lang} ${source}`).toBeTruthy();
      }
      const statuses = deps['statuses'] as Record<string, string>;
      for (const status of ['scheduled', 'cancelled', 'completed']) {
        expect(statuses[status], `${lang} ${status}`).toBeTruthy();
      }
    }
  });

  it('labels every cancel reason in every locale', () => {
    expect(cancelReasonLabel(t, null)).toBe('fleets.departures.cancelledByPerson');
    expect(cancelReasonLabel(t, 'terminated_by_depot_system')).toBe(
      'fleets.departures.cancelReasons.terminated_by_depot_system',
    );
    const locales = { en, de, es, ko, zh, 'zh-TW': zhTW } as Record<string, unknown>;
    for (const [lang, locale] of Object.entries(locales)) {
      const deps = (locale as { fleets: { departures: Record<string, unknown> } }).fleets
        .departures;
      const reasons = deps['cancelReasons'] as Record<string, string>;
      for (const reason of DEPARTURE_CANCEL_REASONS) {
        expect(reasons[reason], `${lang} ${reason}`).toBeTruthy();
      }
      for (const key of ['asSoonAsPossible', 'targetUpTo', 'upToPercent', 'depotSystemBadge']) {
        expect(deps[key], `${lang} ${key}`).toBeTruthy();
      }
    }
  });

  it('labels an ad hoc departure on the 3D depot as soon as possible', () => {
    const label = departureLabel(
      {
        id: 'vdp_1',
        departureAt: null,
        timezone: 'UTC',
        readiness: null,
        reason: null,
        targetKwh: null,
        targetSocPercent: 80,
        deliveredKwh: null,
        shortfallKwh: null,
        predictedReadyAt: null,
      },
      t,
    );
    expect(label.departs).toBe('fleets.departures.asSoonAsPossible');
    expect(label.state).toBeNull();
  });
});
