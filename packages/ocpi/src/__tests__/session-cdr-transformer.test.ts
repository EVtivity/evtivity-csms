// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import type { TaxLine } from '@evtivity/lib/price-display';
import { transformSession } from '../transformers/session.transformer.js';
import { transformCdr } from '../transformers/cdr.transformer.js';

// 10 kWh x 0.30 + 1.00 session fee = 4.00 net, 19% tax 0.76, charged 4.76.
const total: TaxLine[] = [{ taxRate: 0.19, netCents: 400, taxCents: 76 }];
const energy: TaxLine[] = [{ taxRate: 0.19, netCents: 300, taxCents: 57 }];
const fixed: TaxLine[] = [{ taxRate: 0.19, netCents: 100, taxCents: 19 }];

const startedAt = new Date('2026-09-01T10:00:00Z');
const endedAt = new Date('2026-09-01T11:00:00Z');

function sessionInput(cost: TaxLine[] | null): Parameters<typeof transformSession>[0] {
  return {
    session: {
      id: 'ses_1',
      transactionId: 'tx-1',
      status: 'completed',
      startedAt,
      endedAt,
      updatedAt: endedAt,
      energyDeliveredWh: '10000',
      currency: 'EUR',
    },
    cost,
    idleMinutes: 0,
    now: endedAt,
    countryCode: 'DE',
    partyId: 'EVT',
    locationId: 'LOC-1',
    evseUid: 'evs_1',
    connectorId: '1',
    token: { uid: 'TOKEN-1', countryCode: 'NL', partyId: 'MSP' },
  };
}

function cdrInput(): Parameters<typeof transformCdr>[0] {
  return {
    session: {
      sessionId: 'ses_1',
      transactionId: 'tx-1',
      startedAt,
      endedAt,
      energyDeliveredWh: '10000',
      currency: 'EUR',
      idleMinutes: 0,
    },
    cost: { total, energy, fixed },
    location: {
      locationId: 'sit_1',
      siteName: 'Main',
      address: '1 Main St',
      city: 'Berlin',
      postalCode: null,
      state: null,
      country: 'DEU',
      latitude: '52.5',
      longitude: '13.4',
      evseUid: 'evs_1',
      evseId: 'CS-1-EVSE-1',
      connectorId: '1',
      connectorType: 'Type2',
    },
    countryCode: 'DE',
    partyId: 'EVT',
    cdrId: 'cdr-1',
    token: { uid: 'TOKEN-1', countryCode: 'NL', partyId: 'MSP' },
  };
}

describe('transformSession total_cost', () => {
  it('sends the net as excl_vat and the amount charged as incl_vat in 2.2.1', () => {
    expect(transformSession(sessionInput(total), '2.2.1').total_cost).toEqual({
      excl_vat: 4,
      incl_vat: 4.76,
    });
  });

  it('sends before_taxes and the VAT amount with its percentage in 2.3.0', () => {
    expect(transformSession(sessionInput(total), '2.3.0').total_cost).toEqual({
      before_taxes: 4,
      taxes: [{ name: 'VAT', percentage: 19, amount: 0.76 }],
    });
  });

  it('omits total_cost when the cost is not known', () => {
    expect(transformSession(sessionInput(null), '2.2.1')).not.toHaveProperty('total_cost');
  });
});

describe('transformCdr costs', () => {
  it('sends the total and each priced dimension as 2.2.1 Prices', () => {
    const cdr = transformCdr(cdrInput(), '2.2.1');
    expect(cdr.total_cost).toEqual({ excl_vat: 4, incl_vat: 4.76 });
    expect(cdr.total_energy_cost).toEqual({ excl_vat: 3, incl_vat: 3.57 });
    expect(cdr.total_fixed_cost).toEqual({ excl_vat: 1, incl_vat: 1.19 });
    expect(cdr).not.toHaveProperty('total_time_cost');
    expect(cdr).not.toHaveProperty('total_parking_cost');
    expect(cdr).not.toHaveProperty('total_reservation_cost');
  });

  it('sends 2.3.0 Prices with before_taxes and taxes', () => {
    const cdr = transformCdr(cdrInput(), '2.3.0');
    expect(cdr.total_cost).toEqual({
      before_taxes: 4,
      taxes: [{ name: 'VAT', percentage: 19, amount: 0.76 }],
    });
    expect(cdr.total_energy_cost).toEqual({
      before_taxes: 3,
      taxes: [{ name: 'VAT', percentage: 19, amount: 0.57 }],
    });
  });

  it('sends only the total when the dimensions are not known', () => {
    const cdr = transformCdr({ ...cdrInput(), cost: { total } }, '2.2.1');
    expect(cdr.total_cost).toEqual({ excl_vat: 4, incl_vat: 4.76 });
    expect(cdr).not.toHaveProperty('total_energy_cost');
    expect(cdr).not.toHaveProperty('total_fixed_cost');
  });
});

describe('charging periods and parking time', () => {
  it('splits a session into charging TIME and PARKING_TIME periods', () => {
    const session = transformSession({ ...sessionInput(total), idleMinutes: 15 }, '2.2.1');
    expect(session.charging_periods).toEqual([
      {
        start_date_time: '2026-09-01T10:00:00.000Z',
        dimensions: [
          { type: 'ENERGY', volume: 10 },
          { type: 'TIME', volume: 0.75 },
        ],
      },
      {
        start_date_time: '2026-09-01T10:45:00.000Z',
        dimensions: [{ type: 'PARKING_TIME', volume: 0.25 }],
      },
    ]);
  });

  it('reports total_time, total_parking_time, and the charging periods on a CDR', () => {
    const input = cdrInput();
    const cdr = transformCdr({ ...input, session: { ...input.session, idleMinutes: 15 } }, '2.2.1');
    expect(cdr.total_time).toBe(1);
    expect(cdr.total_parking_time).toBe(0.25);
    expect(cdr.charging_periods.map((p) => p.dimensions.map((d) => d.type))).toEqual([
      ['ENERGY', 'TIME'],
      ['PARKING_TIME'],
    ]);
  });

  it('sends one charging period and no total_parking_time without idle time', () => {
    const cdr = transformCdr(cdrInput(), '2.2.1');
    expect(cdr.charging_periods).toHaveLength(1);
    expect(cdr).not.toHaveProperty('total_parking_time');
  });
});

describe('cdr_token', () => {
  it('sends the partner token type and contract id when known', () => {
    const session = transformSession(
      {
        ...sessionInput(total),
        token: {
          uid: 'TOKEN-1',
          countryCode: 'NL',
          partyId: 'MSP',
          tokenType: 'APP_USER',
          contractId: 'NL-MSP-C12345678-X',
        },
      },
      '2.2.1',
    );
    expect(session.cdr_token).toEqual({
      country_code: 'NL',
      party_id: 'MSP',
      uid: 'TOKEN-1',
      type: 'APP_USER',
      contract_id: 'NL-MSP-C12345678-X',
    });
  });

  it('falls back to RFID and the uid as contract id', () => {
    expect(transformSession(sessionInput(total), '2.2.1').cdr_token).toMatchObject({
      type: 'RFID',
      contract_id: 'TOKEN-1',
    });
  });

  it('reports last_updated from the session update time', () => {
    expect(transformSession(sessionInput(total), '2.2.1').last_updated).toBe(
      '2026-09-01T11:00:00.000Z',
    );
  });
});
