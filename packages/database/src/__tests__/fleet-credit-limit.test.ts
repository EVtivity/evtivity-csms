// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const { getCompanyCurrency, getSystemTimezone } = vi.hoisted(() => ({
  getCompanyCurrency: vi.fn(),
  getSystemTimezone: vi.fn(),
}));
vi.mock('../lib/system-settings.js', () => ({ getCompanyCurrency, getSystemTimezone }));
const { resolveAccountBilling } = vi.hoisted(() => ({ resolveAccountBilling: vi.fn() }));
vi.mock('../lib/fleet-billing.js', () => ({ resolveAccountBilling }));
// A slice above every credit these tests use: the reservation is the credit left.
vi.mock('../lib/fleet-credit-settings.js', () => ({
  getFleetCreditReservationCents: vi.fn(() => Promise.resolve(1_000_000)),
}));

const {
  fleetCreditLevel,
  loadFleetCreditExposure,
  checkFleetCreditLimit,
  readFleetCreditLimit,
  fleetCreditRemaining,
  loadDriverAccountCredit,
  claimFleetCreditLimitNotice,
  loadFleetBillingContacts,
} = await import('../lib/fleet-credit-limit.js');

interface Call {
  text: string;
  values: unknown[];
}

/** A tagged-template sql mock answering by the first matching query fragment, with begin(). */
function makeSql(answers: Array<[string, Record<string, unknown>[]]> = []): {
  sql: postgres.Sql;
  calls: Call[];
  begins: number;
} {
  const calls: Call[] = [];
  const state = { begins: 0 };
  const fn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    calls.push({ text, values });
    const match = answers.find(([fragment]) => text.includes(fragment));
    return Promise.resolve(match?.[1] ?? []);
  };
  (fn as unknown as { begin: unknown }).begin = async (
    work: (tx: unknown) => Promise<unknown>,
  ): Promise<unknown> => {
    state.begins += 1;
    return work(fn);
  };
  return {
    sql: fn as unknown as postgres.Sql,
    calls,
    get begins() {
      return state.begins;
    },
  };
}

beforeEach(() => {
  getCompanyCurrency.mockReset();
  getCompanyCurrency.mockResolvedValue('EUR');
  getSystemTimezone.mockReset();
  getSystemTimezone.mockResolvedValue('Europe/Berlin');
  resolveAccountBilling.mockReset();
});

describe('fleetCreditLevel', () => {
  it('is reached at or above the limit', () => {
    expect(fleetCreditLevel(10_000, 10_000, 80)).toBe('reached');
    expect(fleetCreditLevel(10_001, 10_000, 80)).toBe('reached');
  });

  it('warns at or above the warning percent of the limit', () => {
    expect(fleetCreditLevel(8_000, 10_000, 80)).toBe('warning');
    expect(fleetCreditLevel(7_999, 10_000, 80)).toBe('ok');
  });

  it('compares the warning percent without rounding', () => {
    // 80 % of 1001 cents is 800.8 cents: 800 is below, 801 reaches it.
    expect(fleetCreditLevel(800, 1001, 80)).toBe('ok');
    expect(fleetCreditLevel(801, 1001, 80)).toBe('warning');
  });
});

describe('loadFleetCreditExposure', () => {
  it('sums unbilled, invoiced and running account sessions in the company currency', async () => {
    const { sql, calls } = makeSql([
      ['FROM charging_sessions', [{ unbilled: '1200', invoiced: '3000', running: '450' }]],
    ]);
    const exposure = await loadFleetCreditExposure(sql, 'flt_1', { excludeSessionId: 'ses_1' });
    expect(exposure).toEqual({
      unbilledCents: 1200,
      invoicedCents: 3000,
      runningCents: 450,
      totalCents: 4650,
      currency: 'EUR',
    });
    const text = calls[0]?.text ?? '';
    expect(text).toContain("cs.billing_mode = 'account'");
    expect(text).toContain('NOT EXISTS (SELECT 1 FROM payment_records');
    // A draft invoice is not paid either: counted with the issued ones.
    expect(text).toContain("i.status IN ('draft', 'issued')");
    expect(calls[0]?.values).toEqual(['flt_1', 'EUR', 'ses_1', 'ses_1']);
  });

  it('is zero for a fleet without account sessions', async () => {
    const { sql } = makeSql([
      ['FROM charging_sessions', [{ unbilled: null, invoiced: null, running: null }]],
    ]);
    expect((await loadFleetCreditExposure(sql, 'flt_1')).totalCents).toBe(0);
  });
});

describe('checkFleetCreditLimit', () => {
  it('locks the fleet row and reads the exposure in one transaction', async () => {
    const mock = makeSql([
      [
        'FROM fleets',
        [{ name: 'Acme', credit_limit_cents: 10_000, credit_limit_warning_percent: 80 }],
      ],
      ['FROM charging_sessions', [{ unbilled: '6000', invoiced: '2500', running: '0' }]],
    ]);
    const check = await checkFleetCreditLimit(mock.sql, 'flt_1', { excludeSessionId: 'ses_9' });
    expect(mock.begins).toBe(1);
    expect(mock.calls[0]?.text).toContain('FOR UPDATE');
    expect(check).toMatchObject({
      fleetId: 'flt_1',
      fleetName: 'Acme',
      limitCents: 10_000,
      warningPercent: 80,
      level: 'warning',
    });
    expect(check?.exposure.totalCents).toBe(8500);
  });

  it('is reached at the limit', async () => {
    const { sql } = makeSql([
      [
        'FROM fleets',
        [{ name: 'Acme', credit_limit_cents: 5000, credit_limit_warning_percent: 80 }],
      ],
      ['FROM charging_sessions', [{ unbilled: '5000', invoiced: '0', running: '0' }]],
    ]);
    expect((await checkFleetCreditLimit(sql, 'flt_1'))?.level).toBe('reached');
  });

  it('returns null for a fleet without a limit and reads no exposure', async () => {
    const { sql, calls } = makeSql([
      [
        'FROM fleets',
        [{ name: 'Acme', credit_limit_cents: null, credit_limit_warning_percent: 80 }],
      ],
    ]);
    expect(await checkFleetCreditLimit(sql, 'flt_1')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('returns null for a fleet that no longer exists', async () => {
    const { sql } = makeSql();
    expect(await checkFleetCreditLimit(sql, 'flt_gone')).toBeNull();
  });

  it('counts active sessions at their ceiling in the remaining credit', async () => {
    const { sql } = makeSql([
      [
        'FROM fleets',
        [{ name: 'Acme', credit_limit_cents: 10_000, credit_limit_warning_percent: 80 }],
      ],
      [
        'FROM charging_sessions',
        [{ unbilled: '2000', invoiced: '1000', running: '500', reserved: '4000' }],
      ],
    ]);
    const check = await checkFleetCreditLimit(sql, 'flt_1');
    // Level from the running cost (3500 of 10000), credit from the reservations.
    expect(check).toMatchObject({ level: 'ok', remainingCents: 3000, ceilingCents: null });
  });

  it('reserves the remaining credit as the session ceiling under the lock when it is below the slice', async () => {
    const mock = makeSql([
      [
        'FROM fleets',
        [{ name: 'Acme', credit_limit_cents: 10_000, credit_limit_warning_percent: 80 }],
      ],
      [
        'FROM charging_sessions',
        [{ unbilled: '2000', invoiced: '0', running: '100', reserved: '3000' }],
      ],
      ['UPDATE charging_sessions', [{ cost_ceiling_cents: 5000 }]],
    ]);
    const check = await checkFleetCreditLimit(mock.sql, 'flt_1', {
      reserveForSessionId: 'ses_7',
    });
    expect(mock.begins).toBe(1);
    expect(check).toMatchObject({ remainingCents: 5000, ceilingCents: 5000 });
    const exposureCall = mock.calls.find((c) => c.text.includes('FROM charging_sessions'));
    expect(exposureCall?.values).toEqual(['flt_1', 'EUR', 'ses_7', 'ses_7']);
    const update = mock.calls.find((c) => c.text.includes('UPDATE charging_sessions'));
    expect(update?.text).toContain('COALESCE(cost_ceiling_cents');
    expect(update?.text).toContain("billing_mode = 'account'");
    expect(update?.values).toEqual([5000, 'ses_7', 'flt_1']);
  });

  it('returns the stored ceiling of an earlier run', async () => {
    const { sql } = makeSql([
      [
        'FROM fleets',
        [{ name: 'Acme', credit_limit_cents: 10_000, credit_limit_warning_percent: 80 }],
      ],
      ['FROM charging_sessions', [{ unbilled: '0', invoiced: '0', running: '0', reserved: '0' }]],
      ['UPDATE charging_sessions', [{ cost_ceiling_cents: '2500' }]],
    ]);
    const check = await checkFleetCreditLimit(sql, 'flt_1', { reserveForSessionId: 'ses_7' });
    expect(check?.ceilingCents).toBe(2500);
  });

  it('reserves nothing for a fleet without a limit', async () => {
    const { sql, calls } = makeSql([
      [
        'FROM fleets',
        [{ name: 'Acme', credit_limit_cents: null, credit_limit_warning_percent: 80 }],
      ],
    ]);
    expect(await checkFleetCreditLimit(sql, 'flt_1', { reserveForSessionId: 'ses_7' })).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe('fleetCreditRemaining', () => {
  it('is the limit minus ended sessions and reservations, never below 0', () => {
    expect(fleetCreditRemaining(10_000, { unbilledCents: 1000, invoicedCents: 2000 }, 3000)).toBe(
      4000,
    );
    expect(fleetCreditRemaining(10_000, { unbilledCents: 6000, invoicedCents: 0 }, 6000)).toBe(0);
  });
});

describe('readFleetCreditLimit', () => {
  it('reads the limit without the row lock and reserves nothing', async () => {
    const mock = makeSql([
      [
        'FROM fleets',
        [{ name: 'Acme', credit_limit_cents: 5000, credit_limit_warning_percent: 80 }],
      ],
      [
        'FROM charging_sessions',
        [{ unbilled: '0', invoiced: '0', running: '4500', reserved: '5000' }],
      ],
    ]);
    const check = await readFleetCreditLimit(mock.sql, 'flt_1');
    expect(mock.begins).toBe(0);
    expect(mock.calls[0]?.text).not.toContain('FOR UPDATE');
    expect(check).toMatchObject({ level: 'warning', remainingCents: 0, ceilingCents: null });
  });
});

describe('loadDriverAccountCredit', () => {
  it('returns the credit left in the billing fleet', async () => {
    resolveAccountBilling.mockResolvedValue({ fleetId: 'flt_1', fleetName: 'Acme' });
    const { sql } = makeSql([
      [
        'FROM fleets',
        [{ name: 'Acme', credit_limit_cents: 5000, credit_limit_warning_percent: 80 }],
      ],
      [
        'FROM charging_sessions',
        [{ unbilled: '1000', invoiced: '0', running: '0', reserved: '0' }],
      ],
    ]);
    expect(await loadDriverAccountCredit(sql, 'drv_1')).toEqual({
      fleetId: 'flt_1',
      remainingCents: 4000,
    });
  });

  it('is null for a card driver and reads no fleet', async () => {
    resolveAccountBilling.mockResolvedValue(null);
    const { sql, calls } = makeSql();
    expect(await loadDriverAccountCredit(sql, 'drv_1')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('is null for a fleet without a limit', async () => {
    resolveAccountBilling.mockResolvedValue({ fleetId: 'flt_1', fleetName: 'Acme' });
    const { sql } = makeSql([
      [
        'FROM fleets',
        [{ name: 'Acme', credit_limit_cents: null, credit_limit_warning_percent: 80 }],
      ],
    ]);
    expect(await loadDriverAccountCredit(sql, 'drv_1')).toBeNull();
  });
});

describe('claimFleetCreditLimitNotice', () => {
  const check = {
    fleetId: 'flt_1',
    limitCents: 10_000,
    exposure: {
      unbilledCents: 8000,
      invoicedCents: 0,
      runningCents: 0,
      totalCents: 8000,
      currency: 'EUR',
    },
  };

  it('claims the notice of the month in the system timezone once', async () => {
    const { sql, calls } = makeSql([
      ['INSERT INTO fleet_credit_limit_notices', [{ fleet_id: 'flt_1' }]],
    ]);
    expect(await claimFleetCreditLimitNotice(sql, check, 'warning')).toBe(true);
    expect(calls[0]?.text).toContain('ON CONFLICT (fleet_id, period_start, kind) DO NOTHING');
    expect(calls[0]?.values).toEqual(['flt_1', 'Europe/Berlin', 'warning', 8000, 10_000]);
  });

  it('returns false when the notice went out this month already', async () => {
    const { sql } = makeSql();
    expect(await claimFleetCreditLimitNotice(sql, check, 'reached')).toBe(false);
  });
});

describe('loadFleetBillingContacts', () => {
  it("reads the fleet's billing contacts and invoice language", async () => {
    const { sql, calls } = makeSql([
      [
        'billing_contact_emails',
        [
          {
            billing_contact_emails: ['ap@acme.example', 'cfo@acme.example'],
            invoice_language: 'de',
          },
        ],
      ],
    ]);
    expect(await loadFleetBillingContacts(sql, 'flt_1')).toEqual({
      emails: ['ap@acme.example', 'cfo@acme.example'],
      language: 'de',
    });
    expect(calls[0]?.text).toContain('FROM fleets');
    expect(calls[0]?.values).toEqual(['flt_1']);
  });

  it('returns no contacts for a fleet without any', async () => {
    const { sql } = makeSql([
      ['billing_contact_emails', [{ billing_contact_emails: [], invoice_language: 'en' }]],
    ]);
    expect(await loadFleetBillingContacts(sql, 'flt_1')).toEqual({ emails: [], language: 'en' });
  });

  it('returns no contacts and no language for an unknown fleet', async () => {
    const { sql } = makeSql();
    expect(await loadFleetBillingContacts(sql, 'flt_x')).toEqual({ emails: [], language: null });
  });
});
