// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  permissions: new Set<string>(),
  toast: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { get: h.get, post: h.post, patch: h.patch },
}));
vi.mock('@/lib/auth', () => ({
  useHasPermission: (permission: string) => h.permissions.has(permission),
}));
vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (value: string) => value,
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock('@/components/EntityHistoryTab', () => ({ EntityHistoryTab: () => null }));
vi.mock('@/components/entity-nav-buttons', () => ({ EntityNavButtons: () => null }));

import { InvoiceDetail } from '../InvoiceDetail';

function invoice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'inv_1',
    invoiceNumber: 'INV-202606-0042',
    driverId: 'drv_1',
    status: 'issued',
    kind: 'invoice',
    creditedInvoiceId: null,
    creditReason: null,
    issuedAt: '2026-06-01T10:00:00.000Z',
    dueAt: '2026-07-01T10:00:00.000Z',
    paidAt: null,
    paymentReference: null,
    currency: 'EUR',
    subtotalCents: 1000,
    taxCents: 190,
    totalCents: 1190,
    metadata: null,
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

function detail(
  overrides: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    invoice: invoice(overrides),
    lineItems: [],
    driver: null,
    taxBreakdown: [],
    creditedInvoice: null,
    creditNote: null,
    ...extra,
  };
}

function renderPage(id = 'inv_1'): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/invoices/${id}`]}>
        <Routes>
          <Route path="/invoices/:id" element={<InvoiceDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockInvoice(data: Record<string, unknown>): void {
  h.get.mockImplementation((path: string) =>
    path.startsWith('/v1/invoices/') ? Promise.resolve(data) : Promise.resolve({}),
  );
}

beforeEach(() => {
  h.permissions = new Set(['payments:read', 'payments:write']);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InvoiceDetail', () => {
  it('offers mark paid and credit note on an issued invoice, and no void', async () => {
    mockInvoice(detail());
    renderPage();

    expect(await screen.findByText('invoices.markPaid')).toBeDefined();
    expect(screen.getByText('invoices.issueCreditNote')).toBeDefined();
    expect(screen.queryByText('invoices.voidInvoice')).toBeNull();
  });

  it('offers a credit note but not mark paid on a paid invoice', async () => {
    mockInvoice(detail({ status: 'paid', paidAt: '2026-06-05T10:00:00.000Z' }));
    renderPage();

    expect(await screen.findByText('invoices.issueCreditNote')).toBeDefined();
    expect(screen.queryByText('invoices.markPaid')).toBeNull();
  });

  it('hides every write action without payments:write', async () => {
    h.permissions = new Set(['payments:read']);
    mockInvoice(detail());
    renderPage();

    expect(await screen.findAllByText('INV-202606-0042')).not.toHaveLength(0);
    expect(screen.queryByText('invoices.markPaid')).toBeNull();
    expect(screen.queryByText('invoices.issueCreditNote')).toBeNull();
    expect(screen.queryByText('invoices.voidInvoice')).toBeNull();
  });

  it('offers void only on a draft', async () => {
    mockInvoice(detail({ status: 'draft' }));
    renderPage();

    expect(await screen.findByText('invoices.voidInvoice')).toBeDefined();
    expect(screen.queryByText('invoices.issueCreditNote')).toBeNull();
  });

  it('requires a reason and issues the credit note with it', async () => {
    mockInvoice(detail());
    h.post.mockResolvedValue({ invoice: { id: 'inv_2' } });
    renderPage();

    fireEvent.click(await screen.findByText('invoices.issueCreditNote'));
    const confirm = await screen.findAllByText('invoices.issueCreditNote');
    // The dialog's confirm button is the last one with the label.
    fireEvent.click(confirm[confirm.length - 1] as HTMLElement);
    expect(await screen.findByText('invoices.creditReasonRequired')).toBeDefined();
    expect(h.post).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('invoices.creditReason'), {
      target: { value: '  Wrong tariff  ' },
    });
    fireEvent.click(confirm[confirm.length - 1] as HTMLElement);

    await waitFor(() => {
      expect(h.post).toHaveBeenCalledWith('/v1/invoices/inv_1/credit-note', {
        reason: 'Wrong tariff',
      });
    });
  });

  it('marks the invoice paid with the payment date and reference', async () => {
    mockInvoice(detail());
    h.patch.mockResolvedValue(invoice({ status: 'paid' }));
    renderPage();

    fireEvent.click(await screen.findByText('invoices.markPaid'));
    fireEvent.change(await screen.findByLabelText('invoices.paymentDate'), {
      target: { value: '2026-06-05T09:30' },
    });
    fireEvent.change(screen.getByLabelText('invoices.paymentReference'), {
      target: { value: 'TX-1' },
    });
    const confirm = screen.getAllByText('invoices.markPaid');
    fireEvent.click(confirm[confirm.length - 1] as HTMLElement);

    await waitFor(() => {
      expect(h.patch).toHaveBeenCalledWith('/v1/invoices/inv_1/paid', {
        paidAt: new Date('2026-06-05T09:30').toISOString(),
        reference: 'TX-1',
      });
    });
  });

  it('renders a credit note with the credited invoice and the reason, and no actions', async () => {
    mockInvoice(
      detail(
        {
          id: 'inv_2',
          invoiceNumber: 'CN-202606-0001',
          kind: 'credit_note',
          creditedInvoiceId: 'inv_1',
          creditReason: 'Wrong tariff',
          dueAt: null,
          totalCents: -1190,
        },
        {
          creditedInvoice: {
            id: 'inv_1',
            invoiceNumber: 'INV-202606-0042',
            issuedAt: '2026-06-01T10:00:00.000Z',
            paidAt: '2026-06-05T10:00:00.000Z',
          },
        },
      ),
    );
    renderPage('inv_2');

    expect(await screen.findByText('invoices.creditsInvoice')).toBeDefined();
    const link = screen.getByText('INV-202606-0042').closest('a');
    expect(link?.getAttribute('href')).toBe('/invoices/inv_1');
    expect(screen.getByText('Wrong tariff')).toBeDefined();
    expect(screen.getByText('invoices.creditNotePaidNote')).toBeDefined();
    expect(screen.queryByText('invoices.dueAt')).toBeNull();
    expect(screen.queryByText('invoices.markPaid')).toBeNull();
    expect(screen.queryByText('invoices.issueCreditNote')).toBeNull();
  });

  it('links a credited invoice to its credit note', async () => {
    mockInvoice(
      detail(
        { status: 'credited' },
        {
          creditNote: {
            id: 'inv_2',
            invoiceNumber: 'CN-202606-0001',
            issuedAt: '2026-06-06T10:00:00.000Z',
            paidAt: null,
          },
        },
      ),
    );
    renderPage();

    expect(await screen.findByText('invoices.creditedBy')).toBeDefined();
    const link = screen.getByText('CN-202606-0001').closest('a');
    expect(link?.getAttribute('href')).toBe('/invoices/inv_2');
    expect(screen.getByText('invoices.status.credited')).toBeDefined();
    expect(screen.queryByText('invoices.issueCreditNote')).toBeNull();
  });

  function fleetLine(id: number, driverId: string, driverName: string, totalCents: number) {
    return {
      id,
      invoiceId: 'inv_1',
      sessionId: `ses_${String(id)}`,
      description: 'Charging session',
      quantity: '1',
      unitPriceCents: totalCents,
      totalCents,
      taxCents: 0,
      taxRate: '0',
      metadata: {
        kind: 'session',
        sessionDate: '2026-09-10',
        energyWh: 12000,
        driverId,
        driverName,
        stationName: 'Depot CS-01',
      },
      createdAt: '2026-10-02T10:00:00.000Z',
    };
  }

  function fleetDetail(): Record<string, unknown> {
    return detail(
      {
        driverId: null,
        fleetId: 'flt_1',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        billTo: {
          name: 'Acme Logistics GmbH',
          street: 'Hafenstr. 1',
          city: 'Hamburg',
          zip: '20457',
          country: 'Germany',
          taxId: 'DE123',
        },
        sentAt: null,
      },
      {
        fleet: { id: 'flt_1', name: 'Acme Logistics' },
        lineItems: [
          fleetLine(1, 'drv_a', 'Anna Berg', 1000),
          fleetLine(2, 'drv_a', 'Anna Berg', 500),
          fleetLine(3, 'drv_z', 'Zoe Ng', 2000),
        ],
      },
    );
  }

  it('shows the bill-to block, fleet and period of a fleet invoice and groups lines by driver', async () => {
    mockInvoice(fleetDetail());
    renderPage();

    const billTo = await screen.findByTestId('invoice-bill-to');
    expect(billTo.textContent).toContain('Acme Logistics GmbH');
    expect(billTo.textContent).toContain('20457 Hamburg');
    expect(billTo.textContent).toContain('invoices.taxId');
    expect(screen.getByText('Acme Logistics').closest('a')?.getAttribute('href')).toBe(
      '/fleets/flt_1?tab=billing',
    );
    expect(screen.getByText('September 2026')).toBeDefined();
    const groups = screen.getAllByTestId('invoice-driver-group');
    expect(groups.map((g) => g.textContent)).toEqual(['Anna Berg', 'Zoe Ng']);
    expect(screen.getAllByText('invoices.driverSubtotal')).toHaveLength(2);
    expect(screen.getByText('€15.00')).toBeDefined();
  });

  it('emails a fleet invoice to the fleet billing contacts', async () => {
    mockInvoice(fleetDetail());
    h.post.mockResolvedValue({ success: true });
    renderPage();

    fireEvent.click(await screen.findByText('invoices.resend'));
    expect(await screen.findByText('invoices.confirmResendFleet')).toBeDefined();
    const buttons = screen.getAllByRole('button', { name: 'invoices.resend' });
    fireEvent.click(buttons.at(-1) as HTMLElement);
    await waitFor(() => {
      expect(h.post).toHaveBeenCalledWith('/v1/invoices/inv_1/send', {});
    });
  });

  it('opens the mark paid dialog requested from the fleet invoice list', async () => {
    mockInvoice(fleetDetail());
    renderPage('inv_1?action=markPaid');

    expect(await screen.findByText('invoices.markPaidDescription')).toBeDefined();
  });
});
