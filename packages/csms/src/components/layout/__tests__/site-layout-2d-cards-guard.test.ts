// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Owner decision 2026-11-01: the 2D view uses only the standard 2D charger
// card (`StationCard`, `PlacedStationCard`) for every station of every site
// type, never a chip. This fails when a 2D board renders a station any other
// way.

import { describe, it, expect } from 'vitest';
import siteLayout from '../SiteLayout.tsx?raw';
import depotBoard from '../DepotLayoutBoard.tsx?raw';
import customBoard from '../CustomLayoutBoard.tsx?raw';
import stationCard from '../StationCard.tsx?raw';

const SOURCES: Record<string, string> = {
  'SiteLayout.tsx': siteLayout,
  'DepotLayoutBoard.tsx': depotBoard,
  'CustomLayoutBoard.tsx': customBoard,
  'StationCard.tsx': stationCard,
};
const read = (file: string): string => SOURCES[file] ?? '';

/** The 2D boards and what each must render its stations with. */
const BOARDS: Array<{ file: string; card: RegExp }> = [
  { file: 'SiteLayout.tsx', card: /<StationCard\b/ },
  { file: 'DepotLayoutBoard.tsx', card: /<PlacedStationCard\b/ },
  { file: 'CustomLayoutBoard.tsx', card: /<PlacedStationCard\b/ },
];

describe('2D boards use only the standard charger card', () => {
  for (const { file, card } of BOARDS) {
    it(`${file} renders its stations as the standard card`, () => {
      const source = read(file);
      expect(source).toMatch(card);
      // No station chip: no chip test id and no chip markup of a state icon with the station ID.
      expect(source).not.toMatch(/site-layout-2d-station-/);
      expect(source).not.toMatch(/<StationStateIcon state=\{state\} \/>\s*\{station\.stationId\}/);
    });
  }

  it('keeps one card component for every board', () => {
    const card = read('StationCard.tsx');
    // Both the grid card and the placed card render the one card content.
    expect(card.match(/<StationCardContent\b/g)).toHaveLength(2);
  });
});
