// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import source from '../ContentSettings.tsx?raw';

describe('Content settings on phones', () => {
  it('stacks the language picker over the editor until md', () => {
    expect(source).toContain('className="grid grid-cols-1 gap-6 md:grid-cols-[180px_1fr]"');
    // The editor column shrinks to the card instead of growing past it.
    expect(source).toContain('<div className="min-w-0 space-y-4">');
  });

  it('picks the language with a select on phones and the list from md', () => {
    expect(source).toContain('className="md:hidden"');
    expect(source).toContain('<div className="hidden space-y-1 md:block">');
    expect(source).toContain('size="row"');
    // No hand-styled language buttons.
    expect(source).not.toContain('<button');
  });
});
