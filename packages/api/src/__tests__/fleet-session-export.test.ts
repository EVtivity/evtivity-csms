// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  FLEET_SESSION_EXPORT_MAX_DAYS,
  fleetSessionExportRange,
  fleetSessionsCsv,
  type FleetSessionExportRow,
} from '../lib/fleet-session-export.js';

const ROW: FleetSessionExportRow = {
  id: 'ses_1',
  status: 'completed',
  startedAt: new Date('2026-11-02T10:00:00Z'),
  endedAt: '2026-11-02 11:00:00+00',
  energyDeliveredWh: '12345',
  siteName: 'Depot',
  stationName: 'CS-1',
  unitName: 'Box 1',
  evseId: 1,
  connectorId: 2,
  connectorType: 'CCS2',
  driverName: 'Ana Lopez',
  driverErased: false,
  cardLabel: '=HYPERLINK("http://x")',
  idToken: 'AB12CD',
  transactionId: 'TX-9',
  currentCostCents: 120,
  finalCostCents: 1234,
  currency: 'EUR',
};

function lines(csv: string): string[] {
  return csv
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/);
}

describe('fleetSessionsCsv', () => {
  it('writes the session fields and leaves the cost and the card value out by default', () => {
    const [header, row] = lines(fleetSessionsCsv([ROW], { cost: false, operator: false }));
    expect(header).toBe(
      'sessionId,startedAt,endedAt,status,site,station,unit,evse,connector,connectorType,driver,cardLabel,energyKwh',
    );
    expect(row).toContain('ses_1,2026-11-02T10:00:00.000Z,2026-11-02T11:00:00.000Z,completed');
    expect(row).toContain('12.345');
    expect(row).not.toContain('AB12CD');
    expect(row).not.toContain('TX-9');
    expect(row).not.toContain(',EUR');
  });

  it('adds the final cost with payments:read and the card value for operators', () => {
    const [header, row] = lines(fleetSessionsCsv([ROW], { cost: true, operator: true }));
    expect(header?.endsWith('energyKwh,cost,currency,rfidCard,transactionId')).toBe(true);
    expect(row?.endsWith('12.34,EUR,AB12CD,TX-9')).toBe(true);
  });

  it('shows an erased driver as Erased driver and never a name', () => {
    const [, row] = lines(
      fleetSessionsCsv([{ ...ROW, driverName: 'Ana Lopez', driverErased: true }], {
        cost: false,
        operator: false,
      }),
    );
    expect(row).toContain(',Erased driver,');
    expect(row).not.toContain('Ana Lopez');
  });

  it.each([
    ['de', 'Gelöschter Fahrer'],
    ['es', 'Conductor borrado'],
    ['ko', '삭제된 운전자'],
    ['zh', '已清除的驾驶员'],
    ['zh-TW', '已清除的駕駛員'],
    ['en', 'Erased driver'],
    ['fr', 'Erased driver'],
    [null, 'Erased driver'],
  ])('writes the erased driver label in the exporting user language %s', (language, label) => {
    const [, row] = lines(
      fleetSessionsCsv([{ ...ROW, driverName: 'Ana Lopez', driverErased: true }], {
        cost: false,
        operator: false,
        language,
      }),
    );
    expect(row).toContain(`,${label},`);
    expect(row).not.toContain('Ana Lopez');
  });

  it('neutralizes a formula in a text cell', () => {
    const [, row] = lines(fleetSessionsCsv([ROW], { cost: false, operator: false }));
    expect(row).not.toMatch(/,=HYPERLINK/);
    expect(row).toContain("'=HYPERLINK");
  });
});

describe('fleetSessionExportRange', () => {
  const now = new Date('2026-11-17T12:00:00Z');

  it(`defaults to the ${String(FLEET_SESSION_EXPORT_MAX_DAYS)} days up to now`, () => {
    const range = fleetSessionExportRange({ from: null, to: null }, now);
    expect(range.to).toEqual(now);
    expect(now.getTime() - range.from.getTime()).toBe(FLEET_SESSION_EXPORT_MAX_DAYS * 86_400_000);
  });

  it('refuses a range that is too long or ends before it starts', () => {
    expect(() =>
      fleetSessionExportRange({ from: new Date('2025-01-01T00:00:00Z'), to: now }, now),
    ).toThrow(/at most/);
    expect(() =>
      fleetSessionExportRange({ from: now, to: new Date('2026-11-01T00:00:00Z') }, now),
    ).toThrow(/before/);
  });

  it('keeps a range within the cap', () => {
    const from = new Date('2026-11-01T00:00:00Z');
    expect(fleetSessionExportRange({ from, to: now }, now)).toEqual({ from, to: now });
  });
});
