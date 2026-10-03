// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { formatCurrencyAmount } from '@evtivity/lib';

/**
 * A money amount in a report row. Each output format renders it its own way:
 * CSV as a plain decimal in major units ("1234.50", no symbol, no grouping),
 * XLSX as a number cell with two decimals, PDF formatted with the currency.
 * Spreadsheets get numbers they can sum; the currency goes in the header.
 */
export class MoneyCell {
  constructor(
    readonly cents: number,
    readonly currency: string,
  ) {}
}

export function moneyCell(cents: number, currency: string): MoneyCell {
  return new MoneyCell(cents, currency);
}

/** Cents as a plain decimal string in major units: 123450 -> "1234.50", -5 -> "-0.05". */
export function centsToDecimalString(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}${String(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
}

/** Rows for a CSV file: money cells as plain decimals. */
export function csvMoneyRows(rows: readonly unknown[][]): unknown[][] {
  return rows.map((row) =>
    row.map((cell) => (cell instanceof MoneyCell ? centsToDecimalString(cell.cents) : cell)),
  );
}

/** Rows for a PDF table: money cells formatted with their currency. */
export function pdfMoneyRows(rows: readonly unknown[][]): unknown[][] {
  return rows.map((row) =>
    row.map((cell) =>
      cell instanceof MoneyCell ? formatCurrencyAmount(cell.cents, cell.currency) : cell,
    ),
  );
}

/** A money column header with the currency code: "Revenue (incl. tax, EUR)". */
export function moneyHeader(label: string, currency: string, qualifier?: string): string {
  return qualifier != null ? `${label} (${qualifier}, ${currency})` : `${label} (${currency})`;
}
