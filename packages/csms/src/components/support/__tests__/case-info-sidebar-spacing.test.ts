// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import source from '../CaseInfoSidebar.tsx?raw';

describe('Case info sidebar fields', () => {
  it('spaces every label from its dropdown like the standard form field', () => {
    const labels = source.match(/<Label htmlFor="case-[a-z-]+">/g) ?? [];
    const spaced =
      source.match(/<div className="space-y-2">\s*<Label htmlFor="case-[a-z-]+">/g) ?? [];
    expect(labels.length).toBe(4);
    expect(spaced.length).toBe(labels.length);
  });
});
