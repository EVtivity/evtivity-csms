// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null ? key : `${key}:${JSON.stringify(opts)}`,
  }),
}));

import {
  STATION_UNITS_CARD_ID,
  StationUnassignedEvsesNotice,
} from '../station/StationUnassignedEvsesNotice';

afterEach(() => {
  cleanup();
});

describe('StationUnassignedEvsesNotice', () => {
  it('shows nothing for a station without units', () => {
    render(<StationUnassignedEvsesNotice unitCount={0} evses={[{ evseId: 1, unitId: null }]} />);
    expect(screen.queryByTestId('station-unassigned-evses')).toBeNull();
  });

  it('shows nothing when every EVSE in service has a unit', () => {
    render(
      <StationUnassignedEvsesNotice
        unitCount={1}
        evses={[
          { evseId: 1, unitId: 'unt_box1' },
          { evseId: 2, unitId: null, retiredAt: '2026-11-01T00:00:00.000Z' },
        ]}
      />,
    );
    expect(screen.queryByTestId('station-unassigned-evses')).toBeNull();
  });

  it('counts the EVSEs without a unit and opens the units card', () => {
    const card = document.createElement('div');
    card.id = STATION_UNITS_CARD_ID;
    const scroll = vi.fn();
    card.scrollIntoView = scroll;
    document.body.appendChild(card);
    render(
      <StationUnassignedEvsesNotice
        unitCount={8}
        evses={[
          { evseId: 1, unitId: 'unt_box1' },
          { evseId: 17, unitId: null },
          { evseId: 18, unitId: null },
        ]}
      />,
    );
    expect(screen.getByText('stationUnits.unassignedNotice:{"count":2}')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'stationUnits.manageUnits' }));
    expect(scroll).toHaveBeenCalled();
    card.remove();
  });
});
