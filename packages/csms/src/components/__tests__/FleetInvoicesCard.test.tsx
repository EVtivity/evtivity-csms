// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toast: vi.fn(),
  permissions: new Set<string>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { get: h.get, post: h.post },
}));
vi.mock('@/lib/auth', () => ({
  useHasPermission: (permission: string) => h.permissions.has(permission),
}));
vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (value: string) => value,
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: h.toast }) }));

import { FleetInvoicesCard } from '../fleet/FleetInvoicesCard';
import type { FleetInvoiceRow, FleetUnbilledPreview } from '../fleet/FleetInvoicesCard';
import { currentMonth, previousMonth } from '@/lib/fleet-invoice';

function preview(overrides: Partial<FleetUnbilledPreview> = {}): FleetUnbilledPreview {
  return {
    fleetId: 'flt_1',
    period: '2026-09',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    currency: 'USD',
    sessionCount: 3,
    energyWh: 36000,
    netCents: 3000,
    taxCents: 300,
    totalCents: 3300,
    drivers: [
      {
        driverId: 'drv_1',
        driverName: 'Anna Berg',
        sessionCount: 2,
        energyWh: 24000,
        netCents: 2000,
        taxCents: 200,
        totalCents: 2200,
      },
      {
        driverId: 'drv_2',
        driverName: 'Zoe Ng',
        sessionCount: 1,
        energyWh: 12000,
        netCents: 1000,
        taxCents: 100,
        totalCents: 1100,
      },
    ],
    excluded: [
      {
        sessionId: 'ses_x',
        driverId: 'drv_1',
        driverName: 'Anna Berg',
        endedAt: '2026-09-02T10:00:00Z',
        reason: 'zero_cost',
        currency: 'USD',
        finalCostCents: 0,
      },
    ],
    excludedCount: 1,
    existingInvoice: null,
    ...overrides,
  };
}

const row: FleetInvoiceRow = {
  id: 'inv_9',
  invoiceNumber: 'INV-202610-0009',
  driverId: null,
  fleetId: 'flt_1',
  fleetName: 'Acme Logistics',
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  sentAt: null,
  status: 'issued',
  kind: 'invoice',
  creditedInvoiceId: null,
  issuedAt: '2026-10-02T10:00:00Z',
  dueAt: '2026-10-16T10:00:00Z',
  currency: 'USD',
  subtotalCents: 3000,
  taxCents: 300,
  totalCents: 3300,
  createdAt: '2026-10-02T10:00:00Z',
};

function mockGet(data: FleetUnbilledPreview, rows: FleetInvoiceRow[] = [row]): void {
  h.get.mockImplementation((path: string) => {
    if (path.includes('/billing/unbilled')) return Promise.resolve(data);
    if (path.includes('/invoices')) return Promise.resolve({ data: rows, total: rows.length });
    return Promise.resolve({});
  });
}

function wrap(recipient: 'fleet' | 'member' = 'fleet'): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <FleetInvoicesCard fleetId="flt_1" recipient={recipient} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.permissions = new Set(['payments:read', 'payments:write']);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FleetInvoicesCard', () => {
  it('previews the previous month with driver totals and the excluded sessions', async () => {
    mockGet(preview());
    wrap();

    expect(await screen.findByText('Anna Berg')).toBeTruthy();
    expect(h.get).toHaveBeenCalledWith(
      `/v1/fleets/flt_1/billing/unbilled?period=${previousMonth()}`,
    );
    expect(screen.getByText('Zoe Ng')).toBeTruthy();
    expect(screen.getAllByText('$33.00').length).toBeGreaterThan(0);
    expect(screen.getByText('$22.00')).toBeTruthy();
    expect(screen.getByText('fleets.invoices.excludedTitle')).toBeTruthy();
    expect(screen.getByText(/fleets\.invoices\.excludedReasons\.zero_cost/)).toBeTruthy();
  });

  it('generates the invoice of the chosen month after the confirmation', async () => {
    mockGet(preview());
    h.post.mockResolvedValue({ emailed: true, invoice: { id: 'inv_9' } });
    wrap();
    await screen.findByText('Anna Berg');

    // The shared month picker lists the months up to the current one, newest
    // first; pick the one before the default (the previous month).
    const picker = screen.getByLabelText('fleets.invoices.period');
    if (!(picker instanceof HTMLSelectElement)) throw new Error('the period is not a select');
    const months = Array.from(picker.options).map((o) => o.value);
    expect(months[0]).toBe(currentMonth());
    expect(picker.value).toBe(previousMonth());
    const picked = months[2] ?? '';
    fireEvent.change(picker, { target: { value: picked } });
    await waitFor(() => {
      expect(h.get).toHaveBeenCalledWith(`/v1/fleets/flt_1/billing/unbilled?period=${picked}`);
    });
    // The picked month's preview loads before Generate is enabled again.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'fleets.invoices.generate' }).hasAttribute('disabled'),
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: 'fleets.invoices.generate' }));
    const buttons = await screen.findAllByRole('button', { name: 'fleets.invoices.generate' });
    fireEvent.click(buttons.at(-1) as HTMLElement);

    await waitFor(() => {
      expect(h.post).toHaveBeenCalledWith('/v1/fleets/flt_1/invoices', { period: picked });
    });
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'fleets.invoices.generated' }),
    );
  });

  it('says so when the issued invoice was not emailed', async () => {
    mockGet(preview());
    h.post.mockResolvedValue({ emailed: false, invoice: { id: 'inv_9' } });
    wrap();
    await screen.findByText('Anna Berg');
    fireEvent.click(screen.getByRole('button', { name: 'fleets.invoices.generate' }));
    const buttons = await screen.findAllByRole('button', { name: 'fleets.invoices.generate' });
    fireEvent.click(buttons.at(-1) as HTMLElement);
    await waitFor(() => {
      expect(h.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'fleets.invoices.generatedNotEmailed' }),
      );
    });
  });

  it('disables Generate while the month has an invoice and links it', async () => {
    mockGet(
      preview({
        existingInvoice: { id: 'inv_1', invoiceNumber: 'INV-202610-0001', status: 'issued' },
      }),
    );
    wrap();
    expect(await screen.findByTestId('fleet-invoice-existing')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'fleets.invoices.generate' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists the fleet invoices and sends one after the confirmation', async () => {
    mockGet(preview());
    h.post.mockResolvedValue({ success: true });
    wrap();

    expect(await screen.findByText('INV-202610-0009')).toBeTruthy();
    // The invoice row's period (the month picker also lists the month).
    expect(
      within(screen.getByText('INV-202610-0009').closest('tr') as HTMLElement).getByText(
        'September 2026',
      ),
    ).toBeTruthy();
    expect(screen.getByText('invoices.notSent')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'fleets.invoices.send' }));
    const send = await screen.findAllByRole('button', { name: 'fleets.invoices.send' });
    fireEvent.click(send.at(-1) as HTMLElement);
    await waitFor(() => {
      expect(h.post).toHaveBeenCalledWith('/v1/invoices/inv_9/send', {});
    });
  });

  it('hides every action without payments:write and the card without payments:read', async () => {
    h.permissions = new Set(['payments:read']);
    mockGet(preview());
    wrap();
    expect(await screen.findByText('INV-202610-0009')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'fleets.invoices.generate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'fleets.invoices.send' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'invoices.markPaid' })).toBeNull();
    cleanup();

    h.permissions = new Set();
    wrap();
    expect(screen.queryByTestId('fleet-billing-unbilled')).toBeNull();
    expect(h.get).toHaveBeenCalledTimes(2);
  });
});

describe('FleetInvoicesCard member invoices', () => {
  const members: NonNullable<FleetUnbilledPreview['members']> = [
    {
      driverId: 'drv_3',
      driverName: 'Mia Meyer',
      sessionCount: 2,
      energyWh: 20000,
      netCents: 1000,
      taxCents: 190,
      totalCents: 1190,
      existingInvoice: null,
      hasEmail: false,
      hasAddress: false,
    },
    {
      driverId: 'drv_4',
      driverName: 'Jo Kim',
      sessionCount: 1,
      energyWh: 8000,
      netCents: 500,
      taxCents: 95,
      totalCents: 595,
      existingInvoice: { id: 'inv_m', invoiceNumber: 'INV-202610-0010', status: 'issued' },
      hasEmail: true,
      hasAddress: true,
    },
  ];

  it('lists each driver with missing email and address badges and the live invoice', async () => {
    mockGet(preview({ members }));
    wrap('member');
    const mia = await screen.findByTestId('member-row-drv_3');
    expect(within(mia).getByText('fleets.invoices.noEmail')).toBeTruthy();
    expect(within(mia).getByText('fleets.invoices.noAddress')).toBeTruthy();
    const jo = screen.getByTestId('member-row-drv_4');
    expect(within(jo).getByRole('link', { name: 'INV-202610-0010' })).toBeTruthy();
    // A driver with a live invoice of the month cannot be invoiced again.
    const joGenerate = within(jo).getByRole('button', { name: 'fleets.invoices.generateMember' });
    expect((joGenerate as HTMLButtonElement).disabled).toBe(true);
  });

  it("generates one driver's invoice after the confirmation", async () => {
    mockGet(preview({ members }));
    h.post.mockResolvedValue({ emailed: false });
    wrap('member');
    const mia = await screen.findByTestId('member-row-drv_3');
    fireEvent.click(within(mia).getByRole('button', { name: 'fleets.invoices.generateMember' }));
    expect(screen.getByText('fleets.invoices.generateMemberConfirm')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'fleets.invoices.generateMember' });
    fireEvent.click(buttons.at(-1) as HTMLElement);
    await waitFor(() => {
      expect(h.post).toHaveBeenCalledWith('/v1/fleets/flt_1/member-invoices', {
        period: previousMonth(),
        driverId: 'drv_3',
      });
    });
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'fleets.invoices.memberGeneratedNotSent' }),
    );
  });

  it('invoices all members in the background after the confirmation', async () => {
    mockGet(preview({ members }));
    h.post.mockResolvedValue({ batchId: 'b1', memberCount: 1 });
    wrap('member');
    await screen.findByTestId('member-row-drv_3');
    fireEvent.click(screen.getByRole('button', { name: 'fleets.invoices.invoiceAll' }));
    const buttons = screen.getAllByRole('button', { name: 'fleets.invoices.invoiceAll' });
    fireEvent.click(buttons.at(-1) as HTMLElement);
    await waitFor(() => {
      expect(h.post).toHaveBeenCalledWith('/v1/fleets/flt_1/member-invoices/batch', {
        period: previousMonth(),
      });
    });
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'fleets.invoices.invoiceAllStarted' }),
    );
  });

  it('shows the member section only for a fleet that invoices members or has member rows', async () => {
    mockGet(preview());
    wrap('fleet');
    await screen.findByText('Anna Berg');
    expect(screen.queryByTestId('fleet-member-invoices')).toBeNull();
    cleanup();
    mockGet(preview({ members: [] }));
    wrap('member');
    expect(await screen.findByText('fleets.invoices.noMembers')).toBeTruthy();
    const invoiceAll = screen.getByRole('button', { name: 'fleets.invoices.invoiceAll' });
    expect((invoiceAll as HTMLButtonElement).disabled).toBe(true);
  });

  it('names the driver of a member invoice in the list and filters by recipient', async () => {
    const memberRow: FleetInvoiceRow = {
      ...row,
      id: 'inv_m',
      invoiceNumber: 'INV-202610-0010',
      driverId: 'drv_4',
      memberBilled: true,
      driverName: 'Jo Kim',
    };
    mockGet(preview(), [row, memberRow]);
    wrap('member');
    const line = (await screen.findByText('INV-202610-0010')).closest('tr') as HTMLElement;
    expect(within(line).getByRole('link', { name: 'Jo Kim' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('fleets.invoices.recipient'), {
      target: { value: 'member' },
    });
    await waitFor(() => {
      expect(h.get).toHaveBeenCalledWith(
        '/v1/fleets/flt_1/invoices?page=1&limit=10&recipient=member',
      );
    });
  });
});
