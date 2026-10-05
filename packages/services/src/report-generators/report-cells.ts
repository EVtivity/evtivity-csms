// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { ReportLocale } from './report-locale.js';

/**
 * Typed values in report rows. Each output format renders them its own way:
 * CSV keeps machine-readable values (plain decimals, ISO dates) so a decimal
 * comma never collides with the delimiter; XLSX writes number cells with a
 * number format, which the spreadsheet shows in the viewer's locale; the PDF
 * formats them in the report language (report-locale.ts).
 */

/** A money amount. CSV "1234.50", XLSX a two-decimal number, PDF with the currency. */
export class MoneyCell {
  constructor(
    readonly cents: number,
    readonly currency: string,
  ) {}
}

/** A number with a fixed number of decimals. CSV "12.30", XLSX "0.00" format. */
export class FixedCell {
  constructor(
    readonly value: number,
    readonly digits: number,
  ) {}
}

/** A value in percent units (12.5 means 12.5%). CSV and XLSX the number. */
export class PercentCell {
  constructor(readonly value: number) {}
}

/** A calendar date or wall-clock date and time. CSV and XLSX the text as stored. */
export class DateCell {
  constructor(readonly value: string) {}
}

export function moneyCell(cents: number, currency: string): MoneyCell {
  return new MoneyCell(cents, currency);
}

export function fixedCell(value: number, digits: number): FixedCell {
  return new FixedCell(value, digits);
}

export function percentCell(value: number): PercentCell {
  return new PercentCell(value);
}

export function dateCell(value: string): DateCell {
  return new DateCell(value);
}

/** Cents as a plain decimal string in major units: 123450 -> "1234.50", -5 -> "-0.05". */
export function centsToDecimalString(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}${String(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
}

/** Rows for a CSV file. */
export function csvRows(rows: readonly unknown[][]): unknown[][] {
  return rows.map((row) =>
    row.map((cell) => {
      if (cell instanceof MoneyCell) return centsToDecimalString(cell.cents);
      if (cell instanceof FixedCell) return cell.value.toFixed(cell.digits);
      if (cell instanceof PercentCell) return cell.value;
      if (cell instanceof DateCell) return cell.value;
      return cell;
    }),
  );
}

/** Rows for a PDF table, formatted in the report language. */
export function pdfRows(rows: readonly unknown[][], rl: ReportLocale): unknown[][] {
  return rows.map((row) =>
    row.map((cell) => {
      if (cell instanceof MoneyCell) return rl.money(cell.cents, cell.currency);
      if (cell instanceof FixedCell) return rl.number(cell.value, cell.digits);
      if (cell instanceof PercentCell) return rl.percent(cell.value);
      if (cell instanceof DateCell) return rl.date(cell.value);
      if (typeof cell === 'number') return rl.number(cell);
      return cell;
    }),
  );
}
