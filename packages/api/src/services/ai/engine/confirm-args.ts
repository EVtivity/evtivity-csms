// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { redactToolValue } from '@evtivity/ai/redact';
import type { RedactionSurface } from '@evtivity/ai/redact';

/**
 * The arguments the confirmation card shows, and how many values the
 * redactor hid from it. The stored arguments run unchanged, so the card says
 * when what it shows differs from what runs.
 */
export function confirmationArguments(
  args: Record<string, unknown>,
  surface: RedactionSurface,
): { displayArgs: Record<string, unknown>; maskedCount: number } {
  const { value, counts } = redactToolValue(args, surface);
  return {
    displayArgs: value as Record<string, unknown>,
    maskedCount: counts.keys + counts.values + counts.pii,
  };
}
