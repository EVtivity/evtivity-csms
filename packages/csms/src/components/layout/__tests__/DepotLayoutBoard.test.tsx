// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { effectiveLayoutSettings, type SiteLayoutSettings } from '@evtivity/lib/site-layout';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts != null && 'id' in opts ? `${key}:${String(opts['id'])}` : key,
    i18n: { language: 'en' },
  }),
}));

import { DepotLayoutBoard } from '../DepotLayoutBoard';
import type { LayoutStation } from '../StationCard';

const DEPOT: SiteLayoutSettings = {
  ...effectiveLayoutSettings(null),
  siteType: 'depot',
  busBays: 3,
  truckLanes: 2,
};

function station(id: string, x: number, y: number): LayoutStation {
  return {
    id,
    stationId: `CS-${id}`,
    model: null,
    status: 'available',
    isOnline: true,
    securityProfile: 1,
    positionX: x,
    positionY: y,
    placed: true,
    chargingKind: 'dc',
    cellular: false,
    inMaintenance: false,
    displayMessage: null,
    evses: [],
  };
}

function renderBoard(editable = true) {
  const onMove = vi.fn();
  const onOpenDetails = vi.fn();
  render(
    <DepotLayoutBoard
      // Bus bay 0 (slot 0, 0) and truck lane 0 (slot 0, 1).
      stations={[station('bus', 20, 20), station('truck', 20, 160)]}
      settings={DEPOT}
      editable={editable}
      onMove={onMove}
      onOpenDetails={onOpenDetails}
      boardRef={createRef<HTMLDivElement>()}
    />,
  );
  return { onMove, onOpenDetails };
}

afterEach(() => {
  cleanup();
});

describe('DepotLayoutBoard', () => {
  it('outlines and names every bus bay and truck lane slot', () => {
    renderBoard();
    const bays = screen.getAllByTestId(/^site-layout-2d-bus-bay-/);
    expect(bays).toHaveLength(3);
    expect(bays[0]?.textContent).toBe('sites.layoutView.busBay 1');
    const lanes = screen.getAllByTestId(/^site-layout-2d-truck-lane-/);
    expect(lanes).toHaveLength(2);
    expect(lanes[1]?.textContent).toBe('sites.layoutView.truckLane 2');
    // Lanes in the second row, below the bays.
    expect(lanes[0]?.style.top).toBe('160px');
  });

  it('shows every station as the standard 2D charger card in its slot, never a chip', () => {
    renderBoard();
    const bus = screen.getByTestId('site-layout-card-bus');
    expect(bus.style.left).toBe('20px');
    expect(bus.style.top).toBe('20px');
    const truck = screen.getByTestId('site-layout-card-truck');
    expect(truck.style.top).toBe('160px');
    // The card content of every site type: the station ID and the details button.
    expect(bus.textContent).toContain('CS-bus');
    expect(screen.getByTestId('site-layout-card-details-bus')).toBeDefined();
    expect(screen.queryByTestId(/^site-layout-2d-station-/)).toBeNull();
  });

  it('moves a focused station to the next free bay or lane with the keys', () => {
    const { onMove, onOpenDetails } = renderBoard();
    const card = screen.getByTestId('site-layout-card-bus');
    fireEvent.keyDown(card, { key: 'ArrowRight' });
    expect(onMove).toHaveBeenLastCalledWith('bus', 220, 20);
    // Down is the truck lanes: lane 0 is taken, lane 1 is the nearest free one.
    fireEvent.keyDown(card, { key: 'ArrowDown' });
    expect(onMove).toHaveBeenLastCalledWith('bus', 220, 160);
    // Up from the bus bays stays in the bus bays: nothing to move to.
    onMove.mockClear();
    fireEvent.keyDown(card, { key: 'ArrowUp' });
    expect(onMove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('site-layout-card-details-bus'));
    expect(onOpenDetails).toHaveBeenCalledWith('bus');
  });

  it('opens a station but moves nothing on a board that does not drag', () => {
    const { onMove, onOpenDetails } = renderBoard(false);
    const card = screen.getByTestId('site-layout-card-truck');
    fireEvent.keyDown(card, { key: 'ArrowRight' });
    expect(onMove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('site-layout-card-details-truck'));
    expect(onOpenDetails).toHaveBeenCalledWith('truck');
  });
});
