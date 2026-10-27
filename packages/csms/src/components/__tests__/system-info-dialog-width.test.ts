// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import source from '../SystemInfoDialog.tsx?raw';

describe('System Information dialog on phones', () => {
  it('keeps its grid to one shrinkable column so long values cannot widen it', () => {
    expect(source).toMatch(/<DialogContent className="[^"]*\bgrid-cols-1\b[^"]*">/);
  });

  it('wraps the setting names and values inside their cells', () => {
    // The shared TableCell is nowrap; without whitespace-normal break-all never applies.
    const cells = source.match(/<TableCell className="[^"]*break-all[^"]*">/g) ?? [];
    expect(cells.length).toBe(2);
    for (const cell of cells) expect(cell).toContain('whitespace-normal');
  });
});
