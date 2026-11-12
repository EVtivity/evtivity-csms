// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Control characters (`\p{Cc}`: C0 and C1, line breaks and tabs included) and
 * invisible format characters (`\p{Cf}`: the bidirectional controls ALM, LRM,
 * RLM, the embeddings, overrides and isolates, and the zero-width space,
 * joiners, word joiner and byte order mark). A display label is one line of
 * plain text: a bidi override makes it read differently on screen than it is
 * stored, and a zero-width character makes two labels look equal while they
 * differ. The one exception is the zero-width joiner between two emoji (a
 * family or a profession emoji is one such sequence).
 */
const EMOJI_PART = '[\\p{Extended_Pictographic}\\p{Emoji_Modifier}]';

/** Matches a string free of the forbidden characters (also used in route JSON schemas). */
export const DISPLAY_LABEL_PATTERN = new RegExp(
  `^(?:[^\\p{Cc}\\p{Cf}]|(?<=${EMOJI_PART}\\uFE0F?)\\u200D(?=\\p{Extended_Pictographic}))*$`,
  'u',
);

export type DisplayLabelProblem = 'empty' | 'too_long' | 'invalid_characters';

/**
 * Why a required display label cannot be stored, or null. Trims first, then
 * checks the length, then the characters.
 */
export function displayLabelProblem(value: string, max: number): DisplayLabelProblem | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'empty';
  if (trimmed.length > max) return 'too_long';
  if (!DISPLAY_LABEL_PATTERN.test(value)) return 'invalid_characters';
  return null;
}
