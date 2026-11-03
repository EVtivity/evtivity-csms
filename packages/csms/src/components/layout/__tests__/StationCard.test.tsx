// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> | string) =>
      opts == null || typeof opts === 'string'
        ? key
        : 'type' in opts
          ? `EVSE ${String(opts['n'])}, ${String(opts['type'])}, ${String(opts['state'])}`
          : 'names' in opts
            ? `${key}:${String(opts['names'])}:${String(opts['state'])}`
            : 'kw' in opts
              ? `${key}:${String(opts['kw'])}`
              : key,
    i18n: { language: 'en' },
  }),
}));

import { PlacedStationCard, type LayoutStation } from '../StationCard';
import { StationCardContext, type StationCardExtras } from '../station-card-context';
import { STATION_CARD_SIZE } from '../site-layout-2d-placement';
import { statusIconColor } from '@/lib/chart-theme';
import type { LayoutTerminal } from '../layout-terminals';

function station(overrides: Partial<LayoutStation> = {}): LayoutStation {
  return {
    id: 'sta_1',
    stationId: 'CS-1',
    model: null,
    status: 'charging',
    statusReason: null,
    isOnline: true,
    securityProfile: 2,
    positionX: 20,
    positionY: 20,
    placed: true,
    chargingKind: 'dc',
    cellular: false,
    inMaintenance: false,
    displayMessage: null,
    evses: [
      {
        evseId: 1,
        status: 'charging',
        connectors: [
          {
            connectorId: 1,
            connectorType: 'CCS1',
            maxPowerKw: 150,
            status: 'charging',
            isPluggedIn: true,
            energyDeliveredWh: 18400,
          },
          {
            connectorId: 2,
            connectorType: 'CHAdeMO',
            maxPowerKw: 50,
            status: 'available',
            isPluggedIn: false,
            energyDeliveredWh: null,
          },
        ],
      },
      {
        evseId: 2,
        status: 'faulted',
        connectors: [
          {
            connectorId: 1,
            connectorType: 'CCS1',
            maxPowerKw: 150,
            status: 'faulted',
            isPluggedIn: false,
            energyDeliveredWh: null,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function extras(terminals: LayoutTerminal[] = []): StationCardExtras {
  return {
    thumbnailModel: () => 'dc-dispenser',
    terminals: () => terminals,
    plateColors: { ac: '#2563eb', dc: '#ea7a1a' },
  };
}

const open = vi.fn();

function renderCard(
  s: LayoutStation,
  options: { terminals?: LayoutTerminal[]; draggable?: boolean; kw?: number } = {},
): ReturnType<typeof render> {
  return render(
    <StationCardContext value={extras(options.terminals)}>
      <PlacedStationCard
        station={s}
        left={0}
        top={0}
        draggable={options.draggable ?? false}
        currentDrawKw={options.kw}
        onOpenDetails={open}
      />
    </StationCardContext>,
  );
}

function terminal(online: boolean | null): LayoutTerminal {
  return {
    id: 'pt_1',
    name: 'Gate',
    stationId: 'sta_1',
    evseNumber: null,
    hasDisplay: true,
    online,
  };
}

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});

describe('standard 2D charger card', () => {
  it('is one fixed-size button that opens the station popup', () => {
    renderCard(station());
    const card = screen.getByRole('button', { name: 'sites.layoutView.stateDetailsLabel' });
    expect(card.style.width).toBe(`${String(STATION_CARD_SIZE.width)}px`);
    expect(card.style.height).toBe(`${String(STATION_CARD_SIZE.height)}px`);
    // No separate details button (a "+" reads as add).
    expect(within(card).queryAllByRole('button')).toHaveLength(0);
    fireEvent.click(card);
    expect(open).toHaveBeenCalledWith('sta_1');
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('shows the grip only on a draggable card', () => {
    renderCard(station());
    expect(screen.queryByTestId('station-card-grip')).toBeNull();
    cleanup();
    renderCard(station(), { draggable: true });
    expect(screen.getByTestId('station-card-grip')).toBeTruthy();
  });

  it('carries the state in the accent bar, and a faulted border', () => {
    renderCard(station({ status: 'faulted' }));
    const card = screen.getByTestId('site-layout-card-sta_1');
    expect(card.getAttribute('data-state')).toBe('faulted');
    expect(card.className).toContain('border-destructive/40');
    expect(screen.getByTestId('station-card-accent').style.backgroundColor).not.toBe('');
  });

  it('shows each port as only its face icon, grouped by EVSE, named with its EVSE', () => {
    renderCard(station());
    const evses = screen.getByTestId('station-card-evses');
    expect(within(evses).getAllByRole('listitem')).toHaveLength(2);
    const icons = within(evses).getAllByTestId('connector-type-icon');
    expect(icons.map((i) => i.getAttribute('data-connector'))).toEqual(['ccs1', 'chademo', 'ccs1']);
    expect(icons.map((i) => i.getAttribute('aria-label'))).toEqual([
      'EVSE 1, CCS1, status.charging',
      'EVSE 1, CHAdeMO, status.available',
      'EVSE 2, CCS1, status.faulted',
    ]);
    expect(icons[0]?.querySelector('title')?.textContent).toBe('EVSE 1, CCS1, status.charging');
    expect(icons[0]?.querySelector('path')?.getAttribute('stroke')).toBe(
      statusIconColor('charging', false),
    );
    // No "EVSE n" labels and no text status badge per EVSE.
    expect(within(evses).queryByText(/sites\.layoutView\.evse/)).toBeNull();
    expect(within(evses).queryAllByTestId('connector-status-badge')).toHaveLength(0);
  });

  it('shows one badge: the state, or Offline in its place', () => {
    renderCard(station());
    expect(screen.getByTestId('station-card-status').textContent).toBe('status.charging');
    cleanup();
    renderCard(station({ isOnline: false }));
    expect(screen.getByTestId('station-card-status').textContent).toBe('status.offline');
  });

  it('shows power and energy while charging, the fault reason when faulted, else the top power', () => {
    renderCard(station(), { kw: 96.4 });
    expect(screen.getByTestId('station-card-metrics').textContent).toBe('96.4 kW · 18.4 kWh');
    cleanup();
    renderCard(station({ status: 'faulted', statusReason: 'connector_faulted' }));
    expect(screen.getByTestId('station-card-metrics').textContent).toBe(
      'stations.statusReason.connector_faulted',
    );
    cleanup();
    const idle = station();
    for (const e of idle.evses) for (const c of e.connectors) c.isPluggedIn = false;
    renderCard(idle);
    expect(screen.getByTestId('station-card-metrics').textContent).toBe(
      'sites.layoutView.upToKw:150',
    );
  });

  it('truncates a long ID with its title, and shows the connection and terminal icons beside it', () => {
    renderCard(
      station({ stationId: 'A-VERY-LONG-STATION-IDENTIFIER-0001', connectionType: 'wifi' }),
      {
        terminals: [terminal(true)],
      },
    );
    const id = screen.getByTestId('station-card-id');
    expect(id.getAttribute('title')).toBe('A-VERY-LONG-STATION-IDENTIFIER-0001');
    expect(id.className).toContain('truncate');
    const links = screen.getByTestId('station-card-links');
    expect(within(links).getByTestId('connection-badge')).toBeTruthy();
    const online = within(links).getByTestId('payment-terminal-badge');
    expect(online.getAttribute('aria-label')).toBe(
      'sites.layoutView.terminalIconLabel:Gate:status.online',
    );
  });

  it('colors the terminal by its online state and hides it without one', () => {
    renderCard(station(), { terminals: [terminal(false)] });
    expect(screen.getByTestId('payment-terminal-badge').getAttribute('data-state')).toBe('offline');
    cleanup();
    renderCard(station());
    expect(screen.queryByTestId('payment-terminal-badge')).toBeNull();
  });

  it('dims the picture of an offline station and keeps the plain drawing without WebGL', () => {
    renderCard(station({ isOnline: false }));
    const thumb = screen.getByTestId('station-card-thumbnail');
    expect(thumb.getAttribute('data-model')).toBe('dc-dispenser');
    expect(thumb.getAttribute('data-rendered')).toBe('false');
    expect(thumb.parentElement?.className).toContain('grayscale');
  });

  it('shows no security profile (it stays on the station page)', () => {
    renderCard(station());
    expect(screen.queryByText(/Security Profile/)).toBeNull();
  });
});
