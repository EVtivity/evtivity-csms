// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * A LIKE / ILIKE pattern that matches the text anywhere in a value, with the
 * text taken literally: `%`, `_` and the escape character `\` (PostgreSQL's
 * default LIKE escape) are escaped, so a search for `50%` or `a_b` matches
 * those characters instead of acting as wildcards.
 */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
