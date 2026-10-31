// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import {
  effectiveLayoutSettings,
  type LayoutEnergyAsset,
  type SiteLayoutSettings,
} from '@evtivity/lib/site-layout';
import {
  EnergyAssetsSettings,
  newBattery,
  newSolarCanopy,
  parseCapacity,
} from '../EnergyAssetsSettings';

const BASE = effectiveLayoutSettings(null);

function renderPanel(settings: SiteLayoutSettings) {
  const onChange = vi.fn();
  const onInvalidChange = vi.fn();
  render(
    <EnergyAssetsSettings
      settings={settings}
      onChange={onChange}
      onInvalidChange={onInvalidChange}
    />,
  );
  return { onChange, onInvalidChange };
}

afterEach(() => {
  cleanup();
});

describe('EnergyAssetsSettings', () => {
  it('reads a capacity: empty is none, a whole number in range counts, anything else is invalid', () => {
    expect(parseCapacity('')).toBeNull();
    expect(parseCapacity('500')).toBe(500);
    expect(parseCapacity('0')).toBeUndefined();
    expect(parseCapacity('12.5')).toBeUndefined();
    expect(parseCapacity('100001')).toBeUndefined();
  });

  it('puts a new battery on the grass and a new canopy over the first free row', () => {
    const battery = newBattery(BASE);
    expect(battery).toMatchObject({ id: 'bat-1', type: 'battery' });
    if (battery.type === 'battery') expect(battery.z).toBeLessThan(0);
    const withRow0: SiteLayoutSettings = {
      ...BASE,
      energyAssets: [{ id: 'pv-1', type: 'solar', name: null, capacityKwp: null, row: 0 }],
    };
    expect(newSolarCanopy(withRow0)).toMatchObject({ id: 'pv-2', type: 'solar', row: 1 });
  });

  it('adds a battery and a canopy on a parking lot', () => {
    const { onChange } = renderPanel(BASE);
    fireEvent.click(screen.getByRole('button', { name: /sites.layoutSettings.addBattery/ }));
    const added = (onChange.mock.calls[0]?.[0] as SiteLayoutSettings).energyAssets ?? [];
    expect(added.map((a: LayoutEnergyAsset) => a.type)).toEqual(['battery']);
    fireEvent.click(screen.getByRole('button', { name: /sites.layoutSettings.addSolar/ }));
    const second = (onChange.mock.calls[1]?.[0] as SiteLayoutSettings).energyAssets ?? [];
    expect(second.map((a: LayoutEnergyAsset) => a.type)).toEqual(['solar']);
  });

  it('offers no solar canopy on an office or retail site and says the stored ones stay hidden', () => {
    renderPanel({
      ...BASE,
      siteType: 'office_retail',
      energyAssets: [{ id: 'pv-1', type: 'solar', name: null, capacityKwp: 50, row: 0 }],
    });
    expect(screen.queryByRole('button', { name: /sites.layoutSettings.addSolar/ })).toBeNull();
    expect(screen.getByTestId('layout-solar-hidden')).toBeDefined();
  });

  it('holds Save for an invalid capacity and saves a valid one', () => {
    const settings: SiteLayoutSettings = {
      ...BASE,
      energyAssets: [{ id: 'bat-1', type: 'battery', name: null, capacityKwh: null, x: 4, z: -6 }],
    };
    const { onChange, onInvalidChange } = renderPanel(settings);
    const input = screen.getByLabelText('sites.layoutSettings.capacityKwh');
    fireEvent.change(input, { target: { value: '0' } });
    expect(onInvalidChange).toHaveBeenLastCalledWith(true);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '750' } });
    expect(onInvalidChange).toHaveBeenLastCalledWith(false);
    const saved = (onChange.mock.calls[0]?.[0] as SiteLayoutSettings).energyAssets?.[0];
    expect(saved).toMatchObject({ capacityKwh: 750 });
  });
});
