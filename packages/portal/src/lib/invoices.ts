// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { API_BASE_URL } from './config';
import { ApiError } from './api';

export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'void' | 'credited';

/** A row of GET /v1/portal/invoices: an invoice or credit note of the signed-in driver. */
export interface PortalInvoice {
  id: string;
  invoiceNumber: string;
  kind: 'invoice' | 'credit_note';
  status: InvoiceStatus;
  /** Member invoices: the fleet whose account the sessions were charged on. */
  viaFleetName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  creditedInvoiceId: string | null;
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  currency: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  createdAt: string;
}

export interface PortalInvoiceLine {
  id: number;
  sessionId: string | null;
  description: string;
  quantity: string;
  unitPriceCents: number;
  totalCents: number;
  taxCents: number;
  taxRate: string;
  kind: string | null;
  sessionDate: string | null;
  energyWh: number | null;
  stationName: string | null;
}

export interface PortalInvoiceDetail extends PortalInvoice {
  billTo: Record<string, unknown> | null;
  creditReason: string | null;
  lineItems: PortalInvoiceLine[];
  taxBreakdown: Array<{ taxRate: number; netCents: number; taxCents: number; grossCents: number }>;
  creditedInvoice: { id: string; invoiceNumber: string } | null;
  creditNote: { id: string; invoiceNumber: string } | null;
}

/** Badge variant of an invoice status. */
export function invoiceStatusVariant(
  status: InvoiceStatus,
): 'success' | 'secondary' | 'outline' | 'info' {
  switch (status) {
    case 'paid':
      return 'success';
    case 'issued':
      return 'info';
    case 'credited':
      return 'secondary';
    default:
      return 'outline';
  }
}

/** The printable lines of a bill-to snapshot (name, street, city line, country, email). */
export function billToLines(billTo: Record<string, unknown> | null): string[] {
  if (billTo == null) return [];
  const text = (key: string): string => {
    const v = billTo[key];
    return typeof v === 'string' ? v.trim() : '';
  };
  const cityLine = [text('zip'), text('city'), text('state')].filter((s) => s !== '').join(' ');
  return [text('name'), text('street'), cityLine, text('country'), text('email')].filter(
    (s) => s !== '',
  );
}

/**
 * Downloads the invoice PDF (GET /v1/portal/invoices/:id/pdf) as a file. The
 * session cookie authenticates it; the JSON client cannot return bytes.
 */
export async function downloadInvoicePdf(invoice: {
  id: string;
  invoiceNumber: string;
}): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/v1/portal/invoices/${invoice.id}/pdf`, {
    credentials: 'include',
  });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  const blob = await res.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${invoice.invoiceNumber}.pdf`;
  link.click();
  URL.revokeObjectURL(link.href);
}
