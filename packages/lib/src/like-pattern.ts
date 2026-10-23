// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Escapes the LIKE and ILIKE wildcards (`%`, `_`) and the escape character
 * itself (backslash, the PostgreSQL default), so a search text matches only
 * as typed. Wrap the result in `%...%` for a contains search.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
