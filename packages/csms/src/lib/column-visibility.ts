// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export interface ColumnMeta {
  key: string;
  label: string;
  defaultVisible: boolean;
  defaultVisibleMobile: boolean;
  alwaysVisible?: boolean;
}

export type ColumnVisibility = Record<string, boolean>;

export function buildDefaultVisibility(columns: ColumnMeta[], isMobile: boolean): ColumnVisibility {
  const result: ColumnVisibility = {};
  for (const col of columns) {
    if (col.alwaysVisible === true) {
      result[col.key] = true;
    } else {
      result[col.key] = isMobile ? col.defaultVisibleMobile : col.defaultVisible;
    }
  }
  return result;
}

export function applyAlwaysVisible(
  columns: ColumnMeta[],
  visibility: ColumnVisibility,
): ColumnVisibility {
  // Only known columns are kept: a stored preference naming a column a later
  // release removed is dropped instead of carried forward.
  const result: ColumnVisibility = {};
  for (const col of columns) {
    const stored = visibility[col.key];
    if (col.alwaysVisible === true) {
      result[col.key] = true;
    } else if (stored == null) {
      result[col.key] = col.defaultVisible;
    } else {
      result[col.key] = stored;
    }
  }
  return result;
}

export function storageKey(tableKey: string): string {
  return `columns:${tableKey}`;
}
