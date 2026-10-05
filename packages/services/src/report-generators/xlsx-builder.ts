// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import ExcelJS from 'exceljs';
import { neutraliseSpreadsheetFormula } from '@evtivity/lib';
import { DateCell, FixedCell, MoneyCell, PercentCell } from './report-cells.js';

// ExcelJS's published `Column` interface omits `eachCell`, but the runtime
// objects in `sheet.columns` do expose it (see exceljs/lib/doc/column.js).
// Define a local shape that captures the actual runtime contract so the
// autosize loop type-checks without a blanket `any`.
type ColumnWithEachCell = Partial<ExcelJS.Column> & {
  width?: number;
  eachCell: (
    opt: { includeEmpty: boolean },
    cb: (cell: ExcelJS.Cell, rowNumber: number) => void,
  ) => void;
};

function neutraliseCell(value: unknown): unknown {
  // Money and fixed-decimal values are numbers; the cell gets a number format
  // below, which the spreadsheet shows in the viewer's locale.
  if (value instanceof MoneyCell) return value.cents / 100;
  if (value instanceof FixedCell) return value.value;
  if (value instanceof PercentCell) return value.value;
  if (value instanceof DateCell) return value.value;
  if (typeof value !== 'string') return value;
  return neutraliseSpreadsheetFormula(value);
}

const MONEY_NUM_FMT = '#,##0.00';

/** Column width of a text: CJK and other wide characters count as two. */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += (char.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1;
  return width;
}

/** Number format of a cell, or undefined for the default. */
function numFmt(value: unknown): string | undefined {
  if (value instanceof MoneyCell) return MONEY_NUM_FMT;
  if (value instanceof FixedCell) {
    return value.digits > 0 ? `#,##0.${'0'.repeat(value.digits)}` : '#,##0';
  }
  return undefined;
}

/**
 * Build an XLSX workbook from multiple tables (sheets).
 * Each table has a sheet name, headers, and rows.
 */
export async function buildXlsx(
  tables: Array<{ name: string; headers: string[]; rows: unknown[][] }>,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  for (const table of tables) {
    const sheet = workbook.addWorksheet(table.name);
    sheet.addRow(table.headers);

    // Style header row
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE2E8F0' },
      };
    });

    for (const row of table.rows) {
      // Preserve empty separator rows so the XLSX output mirrors the CSV
      // structure when the same generator outputs to both formats.
      if (row.length === 0) {
        sheet.addRow([]);
        continue;
      }
      const added = sheet.addRow(row.map(neutraliseCell));
      row.forEach((value, i) => {
        const fmt = numFmt(value);
        if (fmt != null) added.getCell(i + 1).numFmt = fmt;
      });
    }

    // Auto-fit column widths.
    for (const column of sheet.columns as ColumnWithEachCell[]) {
      let maxLen = 10;
      column.eachCell({ includeEmpty: false }, (cell) => {
        const val = cell.value;
        const len = displayWidth(
          typeof val === 'string' ? val : val != null ? JSON.stringify(val) : '',
        );
        if (len > maxLen) maxLen = len;
      });
      column.width = Math.min(maxLen + 2, 40);
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
