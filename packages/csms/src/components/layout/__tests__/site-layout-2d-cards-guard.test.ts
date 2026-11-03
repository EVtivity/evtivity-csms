// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Owner decision 2026-11-01: the 2D view uses only the standard 2D charger
// card (`StationCard`, `PlacedStationCard`) for every station of every site
// type, never a chip. This fails when a 2D board renders a station any other
// way.

import { describe, it, expect } from 'vitest';
import siteLayout from '../SiteLayout.tsx?raw';
import cardBoard from '../StationCardBoard.tsx?raw';
import stationCard from '../StationCard.tsx?raw';
import cardContent from '../StationCardContent.tsx?raw';
import layoutPopup from '../StationLayoutPopup.tsx?raw';
import connectorViews from '../../charts/ConnectorStatus.tsx?raw';

const SOURCES: Record<string, string> = {
  'SiteLayout.tsx': siteLayout,
  'StationCardBoard.tsx': cardBoard,
  'StationCard.tsx': stationCard,
};
const read = (file: string): string => SOURCES[file] ?? '';

/** The 2D boards and what each must render its stations with. */
const BOARDS: Array<{ file: string; card: RegExp }> = [
  { file: 'SiteLayout.tsx', card: /<StationCardBoard\b/ },
  { file: 'StationCardBoard.tsx', card: /<PlacedStationCard\b/ },
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
    // Every board renders the one placed card with the one card content.
    expect(card.match(/<StationCardContent\b/g)).toHaveLength(1);
    expect(card).not.toMatch(/export function StationCard\b/);
  });

  // Owner rule 2026-11-02: the charger card and the popup show the station
  // status with the shared badge, never their own copies; on the card each
  // port shows only its connector face icon in its status color (no text
  // connector badge), the popup keeps the connector views' badge.
  it('shows the station and connector status with the shared badges', () => {
    for (const [name, source] of [
      ['StationCardContent.tsx', cardContent],
      ['StationLayoutPopup.tsx', layoutPopup],
    ] as const) {
      expect(source, name).toMatch(/<StationStatusBadge\b/);
      expect(source, name).not.toMatch(/connectorStatusClassName\(|stationStatusClassName\(/);
      expect(source, name).not.toMatch(/<ConnectorStatusIcon\b/);
    }
    expect(cardContent).toMatch(/<ConnectorTypeIcon\b/);
    expect(cardContent).not.toMatch(/<ConnectorStatusBadge\b/);
    expect(layoutPopup).toMatch(/<ConnectorStatusBadge\b/);
    // The connector views use the same badge.
    expect(connectorViews).toMatch(/<ConnectorStatusBadge\b/);
    expect(connectorViews).not.toMatch(/connectorStatusClassName\(/);
  });
});
