// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { displayLabelProblem, DISPLAY_LABEL_PATTERN } from '../display-label.js';

describe('displayLabelProblem', () => {
  it('accepts a plain name and an emoji sequence', () => {
    expect(displayLabelProblem('Box 1', 50)).toBeNull();
    expect(displayLabelProblem('Bay \u{1F468}‍\u{1F527}', 50)).toBeNull();
  });

  it('refuses controls, bidi and zero-width characters', () => {
    for (const v of ['a\nb', 'a‮b', 'a​b', 'a\u0085b', 'a⁦b', 'a‍b']) {
      expect(displayLabelProblem(v, 50)).toBe('invalid_characters');
    }
  });

  it('refuses empty and too long after trimming', () => {
    expect(displayLabelProblem('   ', 50)).toBe('empty');
    expect(displayLabelProblem('x'.repeat(51), 50)).toBe('too_long');
    expect(displayLabelProblem(`  ${'x'.repeat(50)}  `, 50)).toBeNull();
  });

  it('exposes the pattern for route schemas', () => {
    expect(DISPLAY_LABEL_PATTERN.test('Box 8')).toBe(true);
    expect(DISPLAY_LABEL_PATTERN.test('Box\u00008')).toBe(false);
  });
});
