// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const { getMock, downloadMock, toastMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  downloadMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: { get: getMock },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  },
}));

vi.mock('@/lib/invoices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices')>()),
  downloadInvoicePdf: downloadMock,
}));

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: { fleet?: string; number?: string; rate?: string }) =>
      options?.fleet != null
        ? `${key}:${options.fleet}`
        : options?.number != null
          ? `${key}:${options.number}`
          : key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

import { ApiError } from '@/lib/api';
import { Invoices } from '../Invoices';
import { InvoiceDetail } from '../InvoiceDetail';

function row(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    invoiceNumber: `INV-${id}`,
    kind: 'invoice',
    status: 'issued',
    viaFleetName: null,
    periodStart: null,
    periodEnd: null,
    creditedInvoiceId: null,
    issuedAt: '2026-11-01T00:15:00Z',
    dueAt: '2026-11-15T00:00:00Z',
    paidAt: null,
    currency: 'EUR',
    subtotalCents: 1000,
    taxCents: 190,
    totalCents: 1190,
    createdAt: '2026-11-01T00:15:00Z',
    ...overrides,
  };
}

function renderAt(path: string): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/account/invoices" element={<Invoices />} />
          <Route path="/account/invoices/:id" element={<InvoiceDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  downloadMock.mockReset();
  toastMock.mockReset();
});

describe('Invoices', () => {
  it('lists ordinary and member invoices and credit notes', async () => {
    getMock.mockResolvedValue({
      data: [
        row('1', { viaFleetName: 'Acme GmbH' }),
        row('2', { kind: 'credit_note', status: 'issued', totalCents: -1190 }),
        row('3', { status: 'paid' }),
      ],
      total: 3,
    });
    renderAt('/account/invoices');
    expect(await screen.findByTestId('invoice-row-1')).toBeDefined();
    expect(screen.getByText('invoices.viaFleet:Acme GmbH')).toBeDefined();
    expect(screen.getAllByText(/invoices\.viaFleet/)).toHaveLength(1);
    expect(screen.getByText('invoices.status.paid')).toBeDefined();
    expect(screen.getAllByText(/invoices\.creditNote/)).toHaveLength(1);
    expect(getMock).toHaveBeenCalledWith('/v1/portal/invoices?page=1&limit=20');
  });

  it('says when there are no invoices', async () => {
    getMock.mockResolvedValue({ data: [], total: 0 });
    renderAt('/account/invoices');
    expect(await screen.findByText('invoices.empty')).toBeDefined();
  });
});

describe('InvoiceDetail', () => {
  const detail = {
    ...row('1', {
      viaFleetName: 'Acme GmbH',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
    }),
    billTo: {
      name: 'Erika Muster',
      street: 'Hauptstr. 1',
      zip: '10115',
      city: 'Berlin',
      email: 'erika@example.com',
    },
    creditReason: null,
    lineItems: [
      {
        id: 7,
        sessionId: 'ses_1',
        description: 'Charging session',
        quantity: '1',
        unitPriceCents: 1000,
        totalCents: 1000,
        taxCents: 190,
        taxRate: '0.19',
        kind: 'session',
        sessionDate: '2026-10-05',
        energyWh: 12000,
        stationName: 'Hof 1',
      },
    ],
    taxBreakdown: [{ taxRate: 0.19, netCents: 1000, taxCents: 190, grossCents: 1190 }],
    creditedInvoice: null,
    creditNote: { id: 'inv_2', invoiceNumber: 'CN-1' },
  };

  it('shows the member invoice with its bill-to, lines and credit note, and downloads the PDF', async () => {
    getMock.mockResolvedValue(detail);
    downloadMock.mockResolvedValue(undefined);
    renderAt('/account/invoices/1');
    expect(await screen.findByText('invoices.viaFleet:Acme GmbH')).toBeDefined();
    expect(screen.getByTestId('invoice-bill-to').textContent).toContain('10115 Berlin');
    expect(screen.getByTestId('invoice-bill-to').textContent).toContain('erika@example.com');
    expect(screen.getByTestId('invoice-line-7').textContent).toContain('Hof 1');
    expect(screen.getByText('invoices.creditedBy:CN-1')).toBeDefined();
    fireEvent.click(screen.getByTestId('invoice-download-pdf'));
    expect(downloadMock).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }));
    expect(getMock).toHaveBeenCalledWith('/v1/portal/invoices/1');
  });

  it('shows not found for an invoice the driver may not read', async () => {
    getMock.mockRejectedValue(new ApiError(404, { code: 'INVOICE_NOT_FOUND' }));
    renderAt('/account/invoices/inv_other');
    expect(await screen.findByText('invoices.notFound')).toBeDefined();
  });

  it('toasts when the PDF download fails', async () => {
    getMock.mockResolvedValue(detail);
    downloadMock.mockRejectedValue(new ApiError(500, null));
    renderAt('/account/invoices/1');
    fireEvent.click(await screen.findByTestId('invoice-download-pdf'));
    await vi.waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'destructive', title: 'invoices.downloadFailed' }),
      );
    });
  });
});
