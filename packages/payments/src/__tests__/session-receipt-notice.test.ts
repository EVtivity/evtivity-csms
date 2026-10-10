// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const results: unknown[][] = [];
  const statements: string[] = [];
  const client = vi.fn((strings: TemplateStringsArray) => {
    statements.push(strings.join('?'));
    return Promise.resolve(results.shift() ?? []);
  });
  return { results, statements, client, dispatchDriverNotification: vi.fn() };
});

vi.mock('@evtivity/database', () => ({ client: h.client }));
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dispatchDriverNotification: h.dispatchDriverNotification,
}));

import { dispatchSessionReceiptIfDue } from '../session-receipt-notice.js';

const deps = { templatesDirs: ['/t'], pubsub: null };

function sessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    driver_id: 'd1',
    transaction_id: 'tx-1',
    energy_delivered_wh: '12000',
    final_cost_cents: 1650,
    started_at: new Date('2026-10-03T10:00:00Z'),
    ended_at: new Date('2026-10-03T10:30:00Z'),
    net_cents: 1500,
    tax_cents: 150,
    cost_breakdown: null,
    currency: 'USD',
    billing_mode: 'card',
    billing_fleet_name: null,
    station_ocpp_id: 'CS-1',
    site_name: 'Depot',
    record_status: 'captured',
    failure_reason: null,
    captured_amount_cents: 1650,
    ...overrides,
  };
}

beforeEach(() => {
  h.results.length = 0;
  h.statements.length = 0;
  h.dispatchDriverNotification.mockResolvedValue(undefined);
});

describe('dispatchSessionReceiptIfDue (finding JB-3)', () => {
  it('TC-T3-31: says what was charged when the top-up above the hold was declined', async () => {
    h.results.push(
      [{ id: 's1' }],
      [
        sessionRow({
          captured_amount_cents: '1200',
          failure_reason: 'Top-up declined: card declined; shortfall 450c',
        }),
      ],
    );

    expect(await dispatchSessionReceiptIfDue('s1', deps)).toBe(true);

    expect(h.dispatchDriverNotification).toHaveBeenCalledWith(
      h.client,
      'session.Receipt',
      'd1',
      expect.objectContaining({
        finalCostCents: 1650,
        partiallyPaid: true,
        chargedCents: 1200,
        unpaidCents: 450,
      }),
      ['/t'],
      undefined,
    );
  });

  it('claims the receipt and sends it once the payment is final', async () => {
    h.results.push([{ id: 's1' }], [sessionRow()]);

    expect(await dispatchSessionReceiptIfDue('s1', deps)).toBe(true);

    const claim = h.statements[0] ?? '';
    expect(claim).toContain('SET receipt_notified_at = now()');
    expect(claim).toContain('receipt_notified_at IS NULL');
    expect(claim).toContain("first_record.status = 'failed'");
    expect(claim).toContain("first_record.pending_operation IN ('capture', 'adjust')");
    expect(claim).toContain("cs.status NOT IN ('active', 'faulted', 'failed')");
    expect(h.dispatchDriverNotification).toHaveBeenCalledWith(
      h.client,
      'session.Receipt',
      'd1',
      expect.objectContaining({
        siteName: 'Depot',
        stationId: 'CS-1',
        transactionId: 'tx-1',
        finalCostCents: 1650,
        energyDeliveredWh: 12000,
        currency: 'USD',
        durationMinutes: 30,
        notCharged: false,
        billingMode: 'card',
        billedTo: '',
        costIncludesTax: true,
        taxCents: 150,
        partiallyPaid: false,
      }),
      ['/t'],
      undefined,
    );
  });

  it('sends nothing when the claim is taken or the payment is not final', async () => {
    h.results.push([]);

    expect(await dispatchSessionReceiptIfDue('s1', deps)).toBe(false);

    expect(h.statements).toHaveLength(1);
    expect(h.dispatchDriverNotification).not.toHaveBeenCalled();
  });

  it('marks a hold released below the provider minimum as not charged', async () => {
    h.results.push(
      [{ id: 's1' }],
      [
        sessionRow({
          record_status: 'cancelled',
          failure_reason: 'Capture below the provider minimum charge (50c USD)',
        }),
      ],
    );

    await dispatchSessionReceiptIfDue('s1', deps);

    expect(h.dispatchDriverNotification).toHaveBeenCalledWith(
      h.client,
      'session.Receipt',
      'd1',
      expect.objectContaining({ notCharged: true }),
      ['/t'],
      undefined,
    );
  });
});
