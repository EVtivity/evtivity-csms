// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { billToLines, downloadInvoicePdf, invoiceStatusVariant } from '../invoices';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('invoiceStatusVariant', () => {
  it('shows paid as success, issued as info, credited as secondary and the rest as outline', () => {
    expect(invoiceStatusVariant('paid')).toBe('success');
    expect(invoiceStatusVariant('issued')).toBe('info');
    expect(invoiceStatusVariant('credited')).toBe('secondary');
    expect(invoiceStatusVariant('draft')).toBe('outline');
    expect(invoiceStatusVariant('void')).toBe('outline');
  });
});

describe('billToLines', () => {
  it('prints the name, street, one city line, country and email, skipping blanks', () => {
    expect(
      billToLines({
        name: ' Ada Lovelace ',
        street: '1 Main St',
        zip: '10001',
        city: 'New York',
        state: 'NY',
        country: 'US',
        email: 'ada@example.com',
      }),
    ).toEqual(['Ada Lovelace', '1 Main St', '10001 New York NY', 'US', 'ada@example.com']);
    expect(billToLines({ name: 'Ada', city: 'Berlin', street: '  ', zip: 12345 })).toEqual([
      'Ada',
      'Berlin',
    ]);
  });

  it('prints nothing without a bill-to snapshot', () => {
    expect(billToLines(null)).toEqual([]);
    expect(billToLines({})).toEqual([]);
  });
});

describe('downloadInvoicePdf', () => {
  it('fetches the PDF with the session cookie and saves it under the invoice number', async () => {
    const blob = new Blob(['%PDF'], { type: 'application/pdf' });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(blob) });
    vi.stubGlobal('fetch', fetchMock);
    const created = vi.fn(() => 'blob:invoice');
    const revoked = vi.fn();
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked }),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe('INV-0001.pdf');
      expect(this.href).toBe('blob:invoice');
    });
    await downloadInvoicePdf({ id: 'inv_1', invoiceNumber: 'INV-0001' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith('/v1/portal/invoices/inv_1/pdf')).toBe(true);
    expect(init.credentials).toBe('include');
    expect(created).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoked).toHaveBeenCalledWith('blob:invoice');
  });

  it('throws the error body of a refused download, and a null body when it is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ code: 'INVOICE_NOT_FOUND' }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: () => Promise.reject(new Error('html')),
        }),
    );
    const err = await downloadInvoicePdf({ id: 'x', invoiceNumber: 'X' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).body).toEqual({ code: 'INVOICE_NOT_FOUND' });
    const bad = await downloadInvoicePdf({ id: 'x', invoiceNumber: 'X' }).catch((e: unknown) => e);
    expect((bad as ApiError).body).toBeNull();
  });
});
