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
    tariff_tax_rate: '0.10',
    currency: 'USD',
    billing_mode: 'card',
    billing_fleet_name: null,
    station_ocpp_id: 'CS-1',
    site_name: 'Depot',
    record_status: 'captured',
    failure_reason: null,
    ...overrides,
  };
}

beforeEach(() => {
  h.results.length = 0;
  h.statements.length = 0;
  h.dispatchDriverNotification.mockResolvedValue(undefined);
});

describe('dispatchSessionReceiptIfDue (finding JB-3)', () => {
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
