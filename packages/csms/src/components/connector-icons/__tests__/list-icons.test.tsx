// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { Type1ListIcon } from '../Type1ListIcon';
import { Type2ListIcon } from '../Type2ListIcon';
import { Ccs1ListIcon } from '../Ccs1ListIcon';
import { Ccs2ListIcon } from '../Ccs2ListIcon';
import { ChademoListIcon } from '../ChademoListIcon';
import { NacsListIcon } from '../NacsListIcon';
import { SVG_COLORS } from '@/lib/chart-theme';

afterEach(() => {
  cleanup();
});

// Every stroke and fill of an icon's shapes.
function colors(svg: Element): string[] {
  return [...svg.querySelectorAll('circle, rect, path')].flatMap((el) =>
    ['stroke', 'fill']
      .map((a) => el.getAttribute(a))
      .filter((v): v is string => v != null && v !== 'none'),
  );
}

const ICONS = [
  { name: 'Type 1', Icon: Type1ListIcon, color: 'currentColor', size: [16, 16] },
  { name: 'Type 2', Icon: Type2ListIcon, color: 'currentColor', size: [16, 16] },
  { name: 'CCS1', Icon: Ccs1ListIcon, color: SVG_COLORS.connectorAmber, size: [16, 20] },
  { name: 'CCS2', Icon: Ccs2ListIcon, color: SVG_COLORS.connectorAmber, size: [16, 20] },
  { name: 'CHAdeMO', Icon: ChademoListIcon, color: SVG_COLORS.connectorAmber, size: [16, 16] },
  { name: 'NACS', Icon: NacsListIcon, color: SVG_COLORS.connectorAmber, size: [12, 16] },
];

describe('Stations list connector icons', () => {
  it('keeps their size and colors: AC the text color, DC amber, no name of their own', () => {
    for (const { name, Icon, color, size } of ICONS) {
      cleanup();
      const { container } = render(<Icon />);
      const svg = container.querySelector('svg');
      if (svg == null) throw new Error(name);
      expect(new Set(colors(svg)), name).toEqual(new Set([color]));
      expect([svg.getAttribute('width'), svg.getAttribute('height')], name).toEqual(
        size.map(String),
      );
      // A tooltip names it in the list.
      expect(svg.getAttribute('role'), name).toBeNull();
    }
  });
});
