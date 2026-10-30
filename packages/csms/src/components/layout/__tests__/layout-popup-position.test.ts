// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { POPUP_MARGIN, layoutPopupPosition } from '../layout-popup-position';

const size = { width: 280, height: 300 };

describe('layoutPopupPosition', () => {
  it('stands right of the station, vertically centered on it', () => {
    const p = layoutPopupPosition(
      { left: 100, right: 260, top: 200, bottom: 300 },
      size,
      { left: 0, top: 0, width: 1000, height: 700 },
      8,
    );
    expect(p).toEqual({ left: 268, top: 100 });
  });

  it('flips left of the station near the right edge and stays inside the visible area', () => {
    const p = layoutPopupPosition(
      { left: 800, right: 960, top: 20, bottom: 120 },
      size,
      { left: 0, top: 0, width: 1000, height: 700 },
      8,
    );
    expect(p).toEqual({ left: 512, top: POPUP_MARGIN });
  });

  it('follows a scrolled board and clamps on a phone-wide container', () => {
    const p = layoutPopupPosition(
      { left: 600, right: 760, top: 900, bottom: 1000 },
      size,
      { left: 400, top: 800, width: 330, height: 700 },
      8,
    );
    expect(p.left).toBe(400 + POPUP_MARGIN);
    expect(p.top).toBe(800 + POPUP_MARGIN);
  });
});
