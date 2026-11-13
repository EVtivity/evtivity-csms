// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { id?: number }) =>
      opts?.id != null ? `${key}:${String(opts.id)}` : key,
  }),
}));

import { PortCard } from '../PortCard';

afterEach(cleanup);

function lines(): HTMLElement[] {
  return screen.getAllByTestId('port-card-connector');
}

describe('PortCard', () => {
  it('shows one connector line with its face, power and current', () => {
    render(
      <PortCard
        evseId={1}
        status="available"
        available
        connectors={[
          { connectorId: 1, connectorType: 'Type2', maxPowerKw: '22.00', maxCurrentAmps: 32 },
        ]}
      />,
    );
    const [line] = lines();
    expect(lines()).toHaveLength(1);
    expect(within(line as HTMLElement).getByText('Type 2')).toBeTruthy();
    expect(within(line as HTMLElement).getByText('22 kW / 32A')).toBeTruthy();
    expect(
      within(line as HTMLElement)
        .getByTestId('connector-face-icon')
        .getAttribute('data-connector'),
    ).toBe('type2');
    expect(screen.getByText('stationDetail.connectorPort:1')).toBeTruthy();
    expect(screen.getAllByText('status.available')).toHaveLength(1);
  });

  it('shows one line per connector of two types, in connector id order, with their own power', () => {
    render(
      <PortCard
        evseId={2}
        status="charging"
        available
        connectors={[
          { connectorId: 2, connectorType: 'CHAdeMO', maxPowerKw: 50 },
          { connectorId: 1, connectorType: 'CCS1', maxPowerKw: 150, maxCurrentAmps: 200 },
        ]}
      />,
    );
    const [first, second] = lines();
    expect(within(first as HTMLElement).getByText('CCS1')).toBeTruthy();
    expect(within(first as HTMLElement).getByText('150 kW / 200A')).toBeTruthy();
    expect(within(second as HTMLElement).getByText('CHAdeMO')).toBeTruthy();
    expect(within(second as HTMLElement).getByText('50 kW')).toBeTruthy();
    expect(
      screen.getAllByTestId('connector-face-icon').map((i) => i.getAttribute('data-connector')),
    ).toEqual(['ccs1', 'chademo']);
    expect(screen.queryByText('CCS1, CHAdeMO')).toBeNull();
    // One EVSE status for the card.
    expect(screen.getAllByText('status.charging')).toHaveLength(1);
  });

  it('gives two connectors of the same type a line each', () => {
    render(
      <PortCard
        evseId={1}
        status="available"
        available
        connectors={[
          { connectorId: 1, connectorType: 'Type1', maxPowerKw: 7.2 },
          { connectorId: 2, connectorType: 'Type1', maxPowerKw: 11 },
        ]}
      />,
    );
    expect(lines()).toHaveLength(2);
    expect(screen.getAllByText('J1772')).toHaveLength(2);
    expect(screen.getByText('7.2 kW')).toBeTruthy();
    expect(screen.getByText('11 kW')).toBeTruthy();
  });

  it('draws a neutral face for an unknown connector type', () => {
    render(
      <PortCard
        evseId={1}
        status="available"
        available
        connectors={[
          { connectorId: 1, connectorType: 'VendorPlug', maxPowerKw: null },
          { connectorId: 2, connectorType: null, maxPowerKw: null },
        ]}
      />,
    );
    expect(
      screen.getAllByTestId('connector-face-icon').map((i) => i.getAttribute('data-connector')),
    ).toEqual(['neutral', 'neutral']);
    expect(screen.getByText('VendorPlug')).toBeTruthy();
    expect(screen.getByText('connectorTypeNames.other')).toBeTruthy();
  });
});
