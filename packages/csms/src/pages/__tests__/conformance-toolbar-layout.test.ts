// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import source from '../Conformance.tsx?raw';

describe('Conformance run toolbar on phones', () => {
  it('puts the two selects side by side and Run Tests on its own row until sm', () => {
    expect(source).toContain(
      'className="grid grid-cols-2 gap-2 sm:ml-auto sm:flex sm:items-center"',
    );
    expect(source).toContain('className="sm:w-[220px]"');
    expect(source).toContain('className="sm:w-[140px]"');
    expect(source).toContain('className="relative col-span-2 sm:col-span-1"');
    // Fixed widths on phones pushed Run Tests 140 px past a 390 px screen.
    expect(source).not.toContain('className="w-[220px]"');
    expect(source).not.toContain('className="w-[140px]"');
  });
});
