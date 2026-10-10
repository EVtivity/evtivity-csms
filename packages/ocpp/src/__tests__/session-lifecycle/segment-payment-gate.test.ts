// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TariffPriceSnapshot } from '@evtivity/database';
import type { ProjectionDeps } from '../../server/projection-support/context.js';

const { mockRunPaymentGate } = vi.hoisted(() => ({ mockRunPaymentGate: vi.fn() }));

vi.mock('../../server/session-lifecycle/payment-gate.js', () => ({
  runPaymentGate: mockRunPaymentGate,
}));

const { isFreeToPaidSwitch, runDuePaymentGate, runSegmentPaymentGate, sessionStartTariff } =
  await import('../../server/session-lifecycle/segment-payment-gate.js');

const free: TariffPriceSnapshot = {
  id: 'trf_free',
  pricePerKwh: '0',
  pricePerMinute: null,
  pricePerSession: null,
  idleFeePricePerMinute: null,
  reservationFeePerMinute: null,
  taxRate: '0.19',
};
const paid: TariffPriceSnapshot = { ...free, id: 'trf_peak', pricePerKwh: '0.40' };

interface Call {
  text: string;
  values: unknown[];
}

function makeDeps(answers: Array<[string, Record<string, unknown>[]]>): {
  deps: ProjectionDeps;
  calls: Call[];
} {
  const calls: Call[] = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    calls.push({ text, values });
    return Promise.resolve(answers.find(([f]) => text.includes(f))?.[1] ?? []);
  };
  return { deps: { sql } as unknown as ProjectionDeps, calls };
}

const cardRow = {
  status: 'active',
  transaction_id: 'tx-1',
  driver_id: 'drv_1',
  station_id: 'sta_1',
  ocpp_station_id: 'CS-1',
  site_id: 'sit_1',
  is_roaming: false,
  free_vend: false,
  billing_mode: 'card',
  prepaid_balance_cents: null,
  guest_status: null,
  guest_email: null,
  guest_payment_id: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRunPaymentGate.mockResolvedValue({ kind: 'allow', why: 'hold_authorized' });
});

describe('isFreeToPaidSwitch', () => {
  it('is true only from a free start to a paid tariff', () => {
    expect(isFreeToPaidSwitch(free, paid)).toBe(true);
    expect(isFreeToPaidSwitch(null, paid)).toBe(true);
    expect(isFreeToPaidSwitch(paid, paid)).toBe(false);
    expect(isFreeToPaidSwitch(free, free)).toBe(false);
  });
});

describe('sessionStartTariff', () => {
  it('reads the tariff_* columns of a session row', () => {
    expect(sessionStartTariff({ tariff_id: null })).toBeNull();
    expect(
      sessionStartTariff({ tariff_id: 'trf_1', tariff_price_per_kwh: 0.3, tariff_tax_rate: '0.1' }),
    ).toEqual({
      id: 'trf_1',
      pricePerKwh: '0.3',
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
      reservationFeePerMinute: null,
      taxRate: '0.1',
    });
  });
});

describe('runSegmentPaymentGate (B3, TC-T3-08)', () => {
  it('gates a card session at the paid tariff with paidAhead', async () => {
    const { deps } = makeDeps([['FROM charging_sessions cs', [cardRow]]]);
    await runSegmentPaymentGate(deps, 'ses_1', paid);
    expect(mockRunPaymentGate).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({
        sessionId: 'ses_1',
        driverId: 'drv_1',
        sessionTariff: paid,
        paidAhead: true,
        guestStatus: null,
        reserved: false,
      }),
    );
  });

  it.each([
    ['roaming', { is_roaming: true }],
    ['free vend', { free_vend: true }],
    ['account', { billing_mode: 'account' }],
    ['prepaid', { prepaid_balance_cents: 500 }],
    ['ended', { status: 'completed' }],
    ['anonymous', { driver_id: null }],
  ])('leaves a %s session alone', async (_name, over) => {
    const { deps } = makeDeps([['FROM charging_sessions cs', [{ ...cardRow, ...over }]]]);
    expect(await runSegmentPaymentGate(deps, 'ses_1', paid)).toBeNull();
    expect(mockRunPaymentGate).not.toHaveBeenCalled();
  });

  it('gates a guest who started free as not authorized', async () => {
    const guest = {
      ...cardRow,
      driver_id: null,
      billing_mode: null,
      guest_status: 'payment_authorized',
      guest_email: 'g@example.com',
      guest_payment_id: null,
    };
    const { deps } = makeDeps([['FROM charging_sessions cs', [guest]]]);
    await runSegmentPaymentGate(deps, 'ses_1', paid);
    expect(mockRunPaymentGate).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({ guestStatus: 'free_start', guestEmail: 'g@example.com' }),
    );
  });

  it('keeps the status of a guest with a card hold', async () => {
    const guest = {
      ...cardRow,
      driver_id: null,
      guest_status: 'payment_authorized',
      guest_payment_id: 'pi_1',
    };
    const { deps } = makeDeps([['FROM charging_sessions cs', [guest]]]);
    await runSegmentPaymentGate(deps, 'ses_1', paid);
    expect(mockRunPaymentGate).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({ guestStatus: 'payment_authorized' }),
    );
  });
});

describe('runDuePaymentGate', () => {
  const segment = {
    tariff_id: 'trf_peak',
    price_per_kwh: '0.40',
    price_per_minute: null,
    price_per_session: null,
    idle_fee_price_per_minute: null,
    reservation_fee_per_minute: null,
    tax_rate: '0.19',
  };

  it('claims the mark and gates at the open segment prices', async () => {
    const { deps, calls } = makeDeps([
      ['SET payment_gate_due_at = NULL', [{ id: 'ses_1' }]],
      ['FROM session_tariff_segments', [segment]],
      ['FROM charging_sessions cs', [cardRow]],
    ]);
    await runDuePaymentGate(deps, 'ses_1');
    expect(calls[0]?.text).toContain('payment_gate_due_at IS NOT NULL');
    expect(mockRunPaymentGate).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({ sessionTariff: expect.objectContaining({ id: 'trf_peak' }) }),
    );
  });

  it('does nothing when another reading claimed the mark', async () => {
    const { deps, calls } = makeDeps([]);
    expect(await runDuePaymentGate(deps, 'ses_1')).toBeNull();
    expect(calls).toHaveLength(1);
    expect(mockRunPaymentGate).not.toHaveBeenCalled();
  });

  it('puts the mark back and throws when the gate fails', async () => {
    mockRunPaymentGate.mockRejectedValue(new Error('provider down'));
    const { deps, calls } = makeDeps([
      ['SET payment_gate_due_at = NULL', [{ id: 'ses_1' }]],
      ['FROM session_tariff_segments', [segment]],
      ['FROM charging_sessions cs', [cardRow]],
    ]);
    await expect(runDuePaymentGate(deps, 'ses_1')).rejects.toThrow('provider down');
    expect(calls.at(-1)?.text).toContain('SET payment_gate_due_at = now()');
  });

  it('skips a free open segment', async () => {
    const { deps } = makeDeps([
      ['SET payment_gate_due_at = NULL', [{ id: 'ses_1' }]],
      ['FROM session_tariff_segments', [{ ...segment, price_per_kwh: '0' }]],
    ]);
    expect(await runDuePaymentGate(deps, 'ses_1')).toBeNull();
    expect(mockRunPaymentGate).not.toHaveBeenCalled();
  });
});
