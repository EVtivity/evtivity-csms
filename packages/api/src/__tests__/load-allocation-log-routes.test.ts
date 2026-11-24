// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  ALLOCATION_NO_REPLY_AFTER_MS,
  buildAllocationSeries,
  buildSessionTimeline,
  decodeCursor,
  encodeCursor,
  replyStateOf,
} from '../routes/load-allocation-log.js';

const T0 = new Date('2026-11-24T10:00:00.000Z');

describe('replyStateOf', () => {
  it('keeps a stored reply and derives pending and no reply from the age', () => {
    expect(replyStateOf('accepted', T0)).toBe('accepted');
    expect(replyStateOf('rejected', T0)).toBe('rejected');
    expect(replyStateOf('not_sent', T0)).toBe('not_sent');
    expect(replyStateOf(null, T0, T0.getTime() + ALLOCATION_NO_REPLY_AFTER_MS)).toBe('pending');
    expect(replyStateOf(null, T0, T0.getTime() + ALLOCATION_NO_REPLY_AFTER_MS + 1)).toBe(
      'no_reply',
    );
  });
});

describe('cursor', () => {
  it('round trips and refuses anything else', () => {
    expect(decodeCursor(encodeCursor(T0, 42))).toEqual({ createdAt: T0, id: 42 });
    expect(decodeCursor('bm9wZQ')).toBeNull();
    expect(decodeCursor(Buffer.from('not a date|5').toString('base64url'))).toBeNull();
    expect(
      decodeCursor(Buffer.from(`${T0.toISOString()}|5;drop`).toString('base64url')),
    ).toBeNull();
  });
});

describe('buildAllocationSeries', () => {
  const row = (over: Record<string, unknown>) => ({
    createdAt: T0,
    stationId: 'sta_1',
    stationOcppId: 'CS-1',
    unitName: null,
    evseNumber: null,
    scope: 'station',
    limitKw: '22.000',
    reason: 'circuit_limit',
    reply: 'accepted',
    ...over,
  });

  it('gives each station limit and each EVSE limit its own step series', () => {
    const series = buildAllocationSeries([
      row({}),
      row({
        scope: 'evse',
        evseNumber: 2,
        unitName: 'Box 1',
        limitKw: '4.140',
        reason: 'tariff_limit',
      }),
      row({ createdAt: new Date(T0.getTime() + 60_000), limitKw: '11.000' }),
      row({ stationId: null, stationOcppId: 'GONE', limitKw: '3.000' }),
    ]);
    expect(series.map((s) => [s.key, s.scope, s.unitName, s.points.map((p) => p.limitKw)])).toEqual(
      [
        ['station:sta_1', 'station', null, [22, 11]],
        ['evse:sta_1:2', 'evse', 'Box 1', [4.14]],
        ['station:ocpp:GONE', 'station', null, [3]],
      ],
    );
    expect(series[1]?.points[0]).toMatchObject({ reason: 'tariff_limit', reply: 'accepted' });
  });
});

describe('buildSessionTimeline', () => {
  const session = {
    id: 'ses_1',
    stationId: 'sta_1',
    stationOcppId: 'CS-1',
    evseNumber: 1,
    unitName: null,
    startedAt: T0,
    endedAt: null,
    tariffName: 'Standard',
    maxCurrentA: null,
  };

  it('splits a session at its tariff segments and masks the tariff name', () => {
    const switchAt = new Date(T0.getTime() + 30 * 60_000);
    const segments = [
      {
        sessionId: 'ses_1',
        startedAt: switchAt,
        endedAt: null,
        tariffName: 'Night',
        maxCurrentA: 10,
      },
      { sessionId: 'ses_1', startedAt: T0, endedAt: switchAt, tariffName: 'Day', maxCurrentA: 6 },
    ];
    expect(
      buildSessionTimeline([session], segments, true).map((p) => [
        p.from,
        p.to,
        p.tariffName,
        p.maxCurrentA,
      ]),
    ).toEqual([
      [T0.toISOString(), switchAt.toISOString(), 'Day', 6],
      [switchAt.toISOString(), null, 'Night', 10],
    ]);
    expect(
      buildSessionTimeline([session], segments, false).every((p) => p.tariffName == null),
    ).toBe(true);
  });

  it('keeps a session without segments as one part and skips one that never started', () => {
    const parts = buildSessionTimeline(
      [session, { ...session, id: 'ses_2', startedAt: null }],
      [],
      true,
    );
    expect(parts).toEqual([
      expect.objectContaining({ sessionId: 'ses_1', tariffName: 'Standard' }),
    ]);
  });
});
