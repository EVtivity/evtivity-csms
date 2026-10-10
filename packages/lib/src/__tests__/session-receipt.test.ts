// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  receiptBilling,
  receiptCapturedCents,
  sessionReceiptVariables,
} from '../session-receipt.js';
import type { SessionReceiptInput } from '../session-receipt.js';
import {
  formatLocalizedVariables,
  MoneyValue,
  TaxLinesValue,
  TaxRateValue,
} from '../notification-values.js';
import { chargedCostBreakdown } from '../price-display.js';
import type { TaxBasis } from '../price-display.js';
import { priceSessionCost } from '../pricing-engine.js';
import type { TariffInput } from '../cost-calculator.js';

describe('sessionReceiptVariables', () => {
  it('builds the receipt variables with the duration, money value and tax flag', () => {
    const variables = sessionReceiptVariables({
      siteName: 'Main',
      stationId: 'CS-1',
      transactionId: 'tx-1',
      energyDeliveredWh: 12000,
      finalCostCents: 1190,
      netCents: 1000,
      taxCents: 190,
      costBreakdown: null,
      capturedCents: 1190,
      currency: 'EUR',
      startedAt: '2026-06-04T00:00:00Z',
      endedAt: '2026-06-04T01:30:00Z',
      notCharged: false,
      billingMode: 'card',
      billedTo: null,
    });
    expect(variables).toMatchObject({
      siteName: 'Main',
      stationId: 'CS-1',
      transactionId: 'tx-1',
      energyDeliveredWh: 12000,
      finalCostCents: 1190,
      costIncludesTax: true,
      currency: 'EUR',
      durationMinutes: 90,
      startedAt: '2026-06-04T00:00:00.000Z',
      endedAt: '2026-06-04T01:30:00.000Z',
      notCharged: false,
      billingMode: 'card',
      billedTo: '',
    });
    expect(variables['costFormatted']).toBeInstanceOf(MoneyValue);
  });

  it('maps postgres text timestamps from a raw query row to ISO', () => {
    const variables = sessionReceiptVariables({
      siteName: null,
      stationId: 'CS-1',
      transactionId: 'tx-1',
      energyDeliveredWh: 0,
      finalCostCents: null,
      netCents: null,
      taxCents: null,
      costBreakdown: null,
      capturedCents: null,
      currency: 'USD',
      startedAt: '2026-06-04 00:00:00+00',
      endedAt: '2026-06-04 00:45:00.5+00',
      notCharged: false,
      billingMode: null,
      billedTo: null,
    });
    expect(variables['startedAt']).toBe('2026-06-04T00:00:00.000Z');
    expect(variables['endedAt']).toBe('2026-06-04T00:45:00.500Z');
    expect(variables['durationMinutes']).toBe(45);
  });

  it('formats a missing cost as zero without tax and an unknown site as empty', () => {
    const variables = sessionReceiptVariables({
      siteName: null,
      stationId: 'CS-1',
      transactionId: 'tx-1',
      energyDeliveredWh: 0,
      finalCostCents: null,
      netCents: null,
      taxCents: null,
      costBreakdown: null,
      capturedCents: null,
      currency: 'USD',
      startedAt: new Date('2026-06-04T00:00:00Z'),
      endedAt: new Date('2026-06-04T00:00:00Z'),
      notCharged: true,
      billingMode: null,
      billedTo: null,
    });
    expect(variables['billingMode']).toBe('');
    expect(variables['billedTo']).toBe('');
    expect(variables['siteName']).toBe('');
    // A Date input becomes an ISO string, which formatDateVariables formats.
    expect(variables['startedAt']).toBe('2026-06-04T00:00:00.000Z');
    expect(variables['costIncludesTax']).toBe(false);
    expect(variables['durationMinutes']).toBe(0);
    expect((variables['costFormatted'] as MoneyValue).cents).toBe(0);
  });

  it('names the fleet of an account session and only of one', () => {
    const base = {
      siteName: 'Main',
      stationId: 'CS-1',
      transactionId: 'tx-1',
      energyDeliveredWh: 1000,
      finalCostCents: 500,
      netCents: 500,
      taxCents: 0,
      costBreakdown: null,
      capturedCents: null,
      currency: 'EUR',
      startedAt: '2026-06-04T00:00:00Z',
      endedAt: '2026-06-04T00:30:00Z',
      notCharged: false,
    };
    const account = sessionReceiptVariables({
      ...base,
      billingMode: 'account',
      billedTo: 'Acme Logistics',
    });
    expect(account['billingMode']).toBe('account');
    expect(account['billedTo']).toBe('Acme Logistics');
    const card = sessionReceiptVariables({ ...base, billingMode: 'card', billedTo: 'Acme' });
    expect(card['billedTo']).toBe('');
  });
});

const START = new Date('2026-06-04T10:00:00Z');
const END = new Date('2026-06-04T11:00:00Z');

function tariff(overrides: Partial<TariffInput>): TariffInput {
  return {
    pricePerKwh: null,
    pricePerMinute: null,
    pricePerSession: null,
    idleFeePricePerMinute: null,
    reservationFeePerMinute: null,
    taxRate: null,
    ...overrides,
  };
}

/** A session priced by the engine, with its stored split as the session row holds it. */
function pricedReceipt(
  basis: TaxBasis,
  sessionTariff: TariffInput,
  extra: Partial<SessionReceiptInput> = {},
  segments: Parameters<typeof priceSessionCost>[0]['segments'] = [],
): SessionReceiptInput {
  const priced = priceSessionCost({
    basis,
    tariff: sessionTariff,
    startedAt: START,
    at: END,
    energyWh: 10_000,
    idleMinutes: 0,
    gracePeriodMinutes: 0,
    reservationHoldingMinutes: 0,
    segments,
  });
  return {
    siteName: 'Main',
    stationId: 'CS-1',
    transactionId: 'tx-1',
    energyDeliveredWh: 10_000,
    finalCostCents: priced.grossCents,
    netCents: priced.netCents,
    taxCents: priced.taxCents,
    // As read back from the jsonb column.
    costBreakdown: JSON.parse(JSON.stringify(priced.breakdown)) as unknown,
    capturedCents: priced.grossCents,
    currency: 'EUR',
    startedAt: START,
    endedAt: END,
    notCharged: false,
    billingMode: 'card',
    billedTo: null,
    ...extra,
  };
}

function money(value: unknown): number | null {
  return value instanceof MoneyValue ? value.cents : null;
}

describe('TC-T3-30 receipt tax label from the stored tax', () => {
  it('labels a net basis session with its stored tax and rate', () => {
    // 10 kWh at 0.30 net plus a 1.00 session fee, 19% added: net 4.00, tax 0.76.
    const v = sessionReceiptVariables(
      pricedReceipt(
        'net',
        tariff({ pricePerKwh: '0.30', pricePerSession: '1.00', taxRate: '0.19' }),
      ),
    );
    expect(v['costIncludesTax']).toBe(true);
    expect(v['finalCostCents']).toBe(476);
    expect(v['taxCents']).toBe(76);
    expect(money(v['taxFormatted'])).toBe(76);
    expect(money(v['netFormatted'])).toBe(400);
    expect(v['taxRatePercent']).toBeInstanceOf(TaxRateValue);
    expect((v['taxRatePercent'] as TaxRateValue).taxRate).toBe(0.19);
    expect(v['taxLinesFormatted']).toBe('');
    expect(formatLocalizedVariables(v, 'de')['taxRatePercent']).toBe('19');
  });

  it('labels a gross basis session with the tax contained in its prices', () => {
    // 10 kWh at 0.357 gross: 3.57 charged, 0.57 of it tax at 19%.
    const v = sessionReceiptVariables(
      pricedReceipt('gross', tariff({ pricePerKwh: '0.357', taxRate: '0.19' })),
    );
    expect(v['costIncludesTax']).toBe(true);
    expect(v['finalCostCents']).toBe(357);
    expect(money(v['taxFormatted'])).toBe(57);
    expect(money(v['netFormatted'])).toBe(300);
    expect((v['taxRatePercent'] as TaxRateValue).taxRate).toBe(0.19);
  });

  it('never says tax is included for a session whose stored tax is 0, whatever the tariff rate', () => {
    const v = sessionReceiptVariables(
      pricedReceipt('net', tariff({ pricePerKwh: '0.30', taxRate: '0' }), {
        // The first tariff's rate no longer decides the label.
        costBreakdown: chargedCostBreakdown(300, 0, 'net'),
      }),
    );
    expect(v['costIncludesTax']).toBe(false);
    expect(v['taxCents']).toBe(0);
    expect(v['taxFormatted']).toBe('');
    expect(v['netFormatted']).toBe('');
    expect(v['taxRatePercent']).toBe('');
    expect(v['taxLinesFormatted']).toBe('');
  });

  it('lists the tax per rate of a session billed at two rates', () => {
    const start = START;
    const mid = new Date('2026-06-04T10:30:00Z');
    const input = pricedReceipt('net', tariff({ pricePerKwh: '0.30', taxRate: '0.19' }), {}, [
      {
        tariff: tariff({ pricePerKwh: '0.30', taxRate: '0.07' }),
        startedAt: start,
        endedAt: mid,
        energyWhStart: 0,
        energyWhEnd: 5_000,
        idleMinutes: 0,
      },
      {
        tariff: tariff({ pricePerKwh: '0.30', taxRate: '0.19' }),
        startedAt: mid,
        endedAt: null,
        energyWhStart: 5_000,
        energyWhEnd: null,
        idleMinutes: 0,
      },
    ]);
    const v = sessionReceiptVariables(input);
    // 1.50 net at 7% (0.11 tax) and 1.50 net at 19% (0.29 tax).
    expect(v['costIncludesTax']).toBe(true);
    expect(money(v['taxFormatted'])).toBe(40);
    expect(v['taxRatePercent']).toBe('');
    const lines = v['taxLinesFormatted'] as TaxLinesValue;
    expect(lines).toBeInstanceOf(TaxLinesValue);
    expect(lines.lines.map((l) => [l.taxRate, l.taxCents])).toEqual([
      [0.07, 11],
      [0.19, 29],
    ]);
    expect(lines.format('en-US')).toBe('7%: €0.11; 19%: €0.29');
    expect(lines.format('de').replace(/\s/g, ' ')).toBe('7 %: 0,11 €; 19 %: 0,29 €');
    expect(money(v['energyCostFormatted'])).toBe(340);
  });
});

describe('TC-T3-31 receipt of a declined top-up', () => {
  it('shows what was charged and what is unpaid when the capture stopped at the hold', () => {
    const v = sessionReceiptVariables(
      pricedReceipt('net', tariff({ pricePerKwh: '0.30', taxRate: '0.19' }), {
        capturedCents: 300,
      }),
    );
    expect(v['finalCostCents']).toBe(357);
    expect(v['partiallyPaid']).toBe(true);
    expect(v['chargedCents']).toBe(300);
    expect(money(v['chargedFormatted'])).toBe(300);
    expect(v['unpaidCents']).toBe(57);
    expect(money(v['unpaidFormatted'])).toBe(57);
  });

  it('is fully paid when the capture covered the cost, and charges nothing when not charged', () => {
    const paid = sessionReceiptVariables(
      pricedReceipt('net', tariff({ pricePerKwh: '0.30', taxRate: '0.19' })),
    );
    expect(paid).toMatchObject({
      partiallyPaid: false,
      chargedCents: 357,
      chargedFormatted: '',
      unpaidCents: 0,
      unpaidFormatted: '',
    });
    const released = sessionReceiptVariables(
      pricedReceipt('net', tariff({ pricePerKwh: '0.01', taxRate: '0.19' }), {
        notCharged: true,
        capturedCents: 0,
      }),
    );
    expect(released).toMatchObject({ partiallyPaid: false, chargedCents: 0, unpaidCents: 0 });
  });

  it('reads the collected amount only from a captured record', () => {
    expect(receiptCapturedCents('captured', '300')).toBe(300);
    expect(receiptCapturedCents('partially_refunded', 1000)).toBe(1000);
    expect(receiptCapturedCents('refunded', 1000)).toBe(1000);
    expect(receiptCapturedCents('pre_authorized', null)).toBeNull();
    expect(receiptCapturedCents('cancelled', 0)).toBeNull();
    expect(receiptCapturedCents('failed', 0)).toBeNull();
    expect(receiptCapturedCents('captured', null)).toBeNull();
    expect(receiptCapturedCents(undefined, 300)).toBeNull();
  });
});

describe('TC-T3-32 receipt tariff and tax lines', () => {
  it('gives one line per billed dimension, tax included, adding up to the total', () => {
    const v = sessionReceiptVariables(
      pricedReceipt(
        'net',
        tariff({
          pricePerKwh: '0.30',
          pricePerMinute: '0.05',
          pricePerSession: '1.00',
          taxRate: '0.19',
        }),
      ),
    );
    // Net 3.00 energy, 3.00 time, 1.00 session fee; 19% tax per line.
    expect(money(v['energyCostFormatted'])).toBe(357);
    expect(money(v['timeCostFormatted'])).toBe(357);
    expect(money(v['sessionFeeFormatted'])).toBe(119);
    expect(v['idleCostFormatted']).toBe('');
    expect(v['reservationFeeFormatted']).toBe('');
    expect(v['finalCostCents']).toBe(833);
  });

  it('shows the total only without a breakdown for the final cost', () => {
    const v = sessionReceiptVariables(
      pricedReceipt('net', tariff({ pricePerKwh: '0.30', taxRate: '0.19' }), {
        costBreakdown: chargedCostBreakdown(999, 0.19, 'net'),
      }),
    );
    expect(v['energyCostFormatted']).toBe('');
    expect(v['taxRatePercent']).toBe('');
    // The label and the tax amount still come from the stored split.
    expect(v['costIncludesTax']).toBe(true);
    expect(money(v['taxFormatted'])).toBe(57);
  });

  it('keeps the tax rate of a charged-only breakdown (a capped or reconciled cost)', () => {
    const v = sessionReceiptVariables(
      pricedReceipt('net', tariff({ pricePerKwh: '0.30', taxRate: '0.19' }), {
        costBreakdown: chargedCostBreakdown(357, 0.19, 'net'),
      }),
    );
    expect(v['energyCostFormatted']).toBe('');
    expect((v['taxRatePercent'] as TaxRateValue).taxRate).toBe(0.19);
  });
});

describe('receiptBilling', () => {
  it('bills an account session without a payment record to its fleet', () => {
    expect(receiptBilling('account', 'Fleet A', false)).toEqual({
      billingMode: 'account',
      billedTo: 'Fleet A',
    });
  });

  it('treats an account session with a payment record (an operator hold) as paid by card', () => {
    expect(receiptBilling('account', 'Fleet A', true)).toEqual({
      billingMode: 'card',
      billedTo: null,
    });
  });

  it('keeps card and gives no mode for a missing or unknown stamp', () => {
    expect(receiptBilling('card', null, true)).toEqual({ billingMode: 'card', billedTo: null });
    expect(receiptBilling(null, null, false)).toEqual({ billingMode: null, billedTo: null });
    expect(receiptBilling('other', null, false)).toEqual({ billingMode: null, billedTo: null });
  });
});
