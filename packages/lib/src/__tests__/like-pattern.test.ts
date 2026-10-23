// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { escapeLikePattern } from '../like-pattern.js';

describe('escapeLikePattern', () => {
  it('escapes the wildcards and the backslash', () => {
    expect(escapeLikePattern('89_01%')).toBe('89\\_01\\%');
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
  });

  it('leaves other text as typed', () => {
    expect(escapeLikePattern('8901 Gate-A.1')).toBe('8901 Gate-A.1');
    expect(escapeLikePattern('')).toBe('');
  });
});
