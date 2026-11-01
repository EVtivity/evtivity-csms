// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { createRef } from 'react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts != null && 'id' in opts ? `${key}:${String(opts['id'])}` : key,
    i18n: { language: 'en' },
  }),
}));

import { CustomLayoutBoard } from '../CustomLayoutBoard';
import type { LayoutStation } from '../StationCard';
import type { FreeStationPlace } from '../site-layout-free';

function station(id: string): LayoutStation {
  return {
    id,
    stationId: `CS-${id}`,
    model: null,
    status: 'available',
    isOnline: true,
    securityProfile: 1,
    positionX: 20,
    positionY: 20,
    placed: true,
    chargingKind: 'ac',
    cellular: id === 'b',
    connectionType: id === 'b' ? 'cellular' : null,
    inMaintenance: false,
    displayMessage: null,
    evses: [],
  };
}

function renderBoard(
  places = new Map<string, FreeStationPlace>([
    ['a', { placement: { x: 0, z: 0, rotationDeg: 0 }, spots: 2 }],
    ['b', { placement: { x: 4, z: 0, rotationDeg: 0 }, spots: 1 }],
  ]),
) {
  const onMove = vi.fn();
  const onOpenDetails = vi.fn();
  render(
    <CustomLayoutBoard
      stations={[station('a'), station('b')]}
      places={places}
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

describe('CustomLayoutBoard', () => {
  it('draws each station with its spots, a line between two spots, and the connection badge of a station whose connection is known', () => {
    renderBoard();
    const two = screen.getByTestId('site-layout-2d-spots-a');
    expect(two.querySelector('polygon')).not.toBeNull();
    expect(two.querySelectorAll('line')).toHaveLength(1);
    expect(screen.getByTestId('site-layout-2d-spots-b').querySelectorAll('line')).toHaveLength(0);
    expect(screen.getAllByTestId('connection-badge')).toHaveLength(1);
  });

  it('moves and turns a focused station with the keys and opens it with Enter', () => {
    const { onMove, onOpenDetails } = renderBoard();
    const card = screen.getByTestId('site-layout-card-b');
    fireEvent.keyDown(card, { key: 'ArrowDown' });
    expect(onMove).toHaveBeenLastCalledWith('b', { x: 4, z: 0.5, rotationDeg: 0 });
    fireEvent.keyDown(card, { key: 'r', shiftKey: true });
    expect(onMove).toHaveBeenLastCalledWith('b', { x: 4, z: 0, rotationDeg: 1 });
    // The card's details button opens the shared popup, as on every site type.
    fireEvent.click(screen.getByTestId('site-layout-card-details-b'));
    expect(onOpenDetails).toHaveBeenCalledWith('b');
  });

  it('refuses a move onto the spots of another station', () => {
    const { onMove } = renderBoard();
    const card = screen.getByTestId('site-layout-card-b');
    fireEvent.keyDown(card, { key: 'ArrowLeft' });
    // At 3.5 m its spot (2.2 to 4.8 m) would overlap the two spots of a (to 2.6 m).
    expect(onMove).not.toHaveBeenCalled();
    expect(screen.getByTestId('site-layout-2d-notice').textContent).toBe(
      'sites.layoutView.spotsOverlap:CS-b',
    );
  });

  it('shows every station as the standard 2D charger card, never a chip, and no card over another', () => {
    renderBoard();
    for (const id of ['a', 'b']) {
      const card = screen.getByTestId(`site-layout-card-${id}`);
      expect(card.textContent).toContain(`CS-${id}`);
      expect(screen.getByTestId(`site-layout-card-details-${id}`)).toBeDefined();
    }
    expect(screen.queryByTestId(/^site-layout-2d-station-/)).toBeNull();
    const a = screen.getByTestId('site-layout-card-a');
    const b = screen.getByTestId('site-layout-card-b');
    const apart =
      Math.abs(parseFloat(a.style.left) - parseFloat(b.style.left)) >= 160 ||
      Math.abs(parseFloat(a.style.top) - parseFloat(b.style.top)) >= 120;
    expect(apart).toBe(true);
  });
});
