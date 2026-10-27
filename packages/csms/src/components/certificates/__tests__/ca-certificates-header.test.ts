// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import source from '../CaCertificatesTab.tsx?raw';

describe('CA certificates header on phones', () => {
  it('stacks the title over the actions until sm and lets both buttons share the row', () => {
    expect(source).toContain(
      'className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"',
    );
    expect(source).toContain('<div className="flex flex-wrap items-center gap-2">');
    // The old column stretched every control, the filter icon included, to full width.
    expect(source).not.toContain('*:w-full');
    expect((source.match(/className="grow sm:grow-0"/g) ?? []).length).toBe(2);
  });
});
