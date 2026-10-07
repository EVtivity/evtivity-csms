// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export function getString(obj: Record<string, unknown>, key: string): string | null {
  const val = obj[key];
  return typeof val === 'string' ? val : null;
}
