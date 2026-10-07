// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Parses JSON whose validity is not guaranteed (stored values, message
 * payloads, user input). Returns undefined for a missing or invalid text, so
 * the caller picks the fallback. JSON itself never parses to undefined.
 */
export function tryParseJson(text: string | null | undefined): unknown {
  if (text == null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // fail-open: invalid JSON is the expected outcome, the caller handles undefined
    return undefined;
  }
}
