// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** The calendar month before the one of `now`, as YYYY-MM (the default period to bill). */
export function previousMonth(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-based: the previous month's 1-based number
  return month === 0
    ? `${String(year - 1)}-12`
    : `${String(year)}-${String(month).padStart(2, '0')}`;
}

/** The current calendar month as YYYY-MM (the latest period that can be billed). */
export function currentMonth(now: Date = new Date()): string {
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** A period (YYYY-MM or a YYYY-MM-DD first day) as month and year, e.g. "September 2026". */
export function formatPeriodMonth(period: string | null | undefined, locale: string): string {
  if (period == null || period === '') return '--';
  const parsed = new Date(`${period.slice(0, 7)}-01T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return period;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(parsed);
}

/** The bill-to block a fleet invoice stores (snapshot of the fleet billing profile). */
export interface InvoiceBillTo {
  name: string;
  lines: string[];
  taxId: string | null;
}

function field(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The bill-to snapshot of a fleet invoice, or null on a driver invoice. */
export function readBillTo(billTo: unknown): InvoiceBillTo | null {
  if (billTo == null || typeof billTo !== 'object') return null;
  const record = billTo as Record<string, unknown>;
  const name = field(record, 'name');
  if (name == null) return null;
  const cityLine = [field(record, 'zip'), field(record, 'city')]
    .filter((part): part is string => part != null)
    .join(' ');
  const lines = [
    field(record, 'street'),
    cityLine !== '' ? cityLine : null,
    field(record, 'state'),
    field(record, 'country'),
  ].filter((line): line is string => line != null);
  return { name, lines, taxId: field(record, 'taxId') };
}

/** A driver's lines on a fleet invoice. */
export interface DriverLineGroup<T> {
  driverId: string | null;
  driverName: string;
  items: T[];
  /** Sum of the lines' net amounts. */
  netCents: number;
}

/**
 * The lines of a fleet invoice grouped by the driver in their metadata, in the
 * order the invoice lists them (as the PDF groups them).
 */
export function groupLinesByDriver<
  T extends { totalCents: number; metadata: Record<string, unknown> | null },
>(lineItems: T[]): Array<DriverLineGroup<T>> {
  const groups: Array<DriverLineGroup<T>> = [];
  const byKey = new Map<string, DriverLineGroup<T>>();
  for (const item of lineItems) {
    const meta = item.metadata ?? {};
    const driverId = typeof meta['driverId'] === 'string' ? meta['driverId'] : null;
    const driverName = typeof meta['driverName'] === 'string' ? meta['driverName'] : '';
    const key = driverId ?? '';
    let group = byKey.get(key);
    if (group == null) {
      group = { driverId, driverName, items: [], netCents: 0 };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
    group.netCents += item.totalCents;
  }
  return groups;
}
