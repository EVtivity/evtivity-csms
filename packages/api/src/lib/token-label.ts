// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import { DISPLAY_LABEL_PATTERN } from '@evtivity/lib/display-label';

/** The most characters a label holds after trimming (`driver_tokens.label` varchar(100)). */
export const TOKEN_LABEL_MAX_LENGTH = 100;

/**
 * The most characters a request may send: the 100-character limit applies
 * after trimming, so surrounding spaces never refuse a label that fits.
 */
export const TOKEN_LABEL_INPUT_MAX_LENGTH = 1000;

/**
 * Matches a string free of control and invisible format characters (a zero-width
 * joiner only inside an emoji), the shared display label rule. Also in the
 * route JSON schema.
 */
export const TOKEN_LABEL_PATTERN = DISPLAY_LABEL_PATTERN;

export type TokenLabelProblem = 'control_characters' | 'too_long';

/** Why a label cannot be stored, or null. Reads the label as sent (trimmed for the length). */
export function tokenLabelProblem(label: string): TokenLabelProblem | null {
  if (!TOKEN_LABEL_PATTERN.test(label)) return 'control_characters';
  if (label.trim().length > TOKEN_LABEL_MAX_LENGTH) return 'too_long';
  return null;
}

/** Request body schema of a label (create and update, operator and portal). */
export function tokenLabelSchema(description: string): z.ZodString {
  return z
    .string()
    .max(TOKEN_LABEL_INPUT_MAX_LENGTH)
    .regex(TOKEN_LABEL_PATTERN, 'Must not contain control or invisible format characters')
    .describe(
      `${description}. At most ${String(TOKEN_LABEL_MAX_LENGTH)} characters after trimming; control and invisible format characters (bidirectional controls, zero-width characters; a zero-width joiner only inside an emoji) answer 400 VALIDATION_ERROR; empty means no label`,
    );
}
