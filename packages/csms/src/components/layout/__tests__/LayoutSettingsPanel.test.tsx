// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { effectiveLayoutSettings } from '@evtivity/lib/site-layout';

vi.mock('react-i18next', () => ({
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts != null && 'n' in opts ? `${key}:${String(opts['n'])}` : key,
    i18n: { language: 'en' },
  }),
}));

import { LayoutSettingsPanel, parseCountField } from '../LayoutSettingsPanel';
import { parseRatedKva } from '../PowerEquipment';

const SETTINGS = effectiveLayoutSettings(null);

function renderPanel(stationCount = 4, settings = SETTINGS) {
  const onChange = vi.fn();
  const onInvalidChange = vi.fn();
  render(
    <MemoryRouter>
      <LayoutSettingsPanel
        siteId="site-1"
        settings={settings}
        stationCount={stationCount}
        onChange={onChange}
        onInvalidChange={onInvalidChange}
      />
    </MemoryRouter>,
  );
  return { onChange, onInvalidChange };
}

afterEach(() => {
  cleanup();
});

describe('LayoutSettingsPanel', () => {
  it('parses the count fields as whole numbers inside their ranges', () => {
    expect(parseCountField('spotsPerRow', '12')).toBe(12);
    expect(parseCountField('spotsPerRow', '0')).toBeNull();
    expect(parseCountField('rows', '1.5')).toBeNull();
    expect(parseCountField('chargers', '0')).toBeNull();
    expect(parseCountField('chargers', '100')).toBe(100);
    expect(parseCountField('chargersLeft', '0')).toBe(0);
    expect(parseCountField('chargersRight', '101')).toBeNull();
    expect(parseCountField('rows', '')).toBeNull();
    expect(parseRatedKva('')).toBeNull();
    expect(parseRatedKva('2500')).toBe(2500);
    expect(parseRatedKva('0')).toBeUndefined();
  });

  it('sends a valid lot change at once and holds Save while a value is invalid', () => {
    const { onChange, onInvalidChange } = renderPanel();
    fireEvent.change(screen.getByLabelText('sites.layoutSettings.spotsPerRow'), {
      target: { value: '6' },
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ spotsPerRow: 6 }));
    expect(onInvalidChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByLabelText('sites.layoutSettings.rows'), {
      target: { value: '0' },
    });
    expect(onInvalidChange).toHaveBeenLastCalledWith(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('shows the site type read-only with a link to the Details tab', () => {
    renderPanel();
    const type = screen.getByTestId('layout-settings-site-type');
    expect(type.textContent).toContain('sites.layoutSettings.siteTypeParkingLot');
    expect(document.getElementById('layout-settings-siteType')).toBeNull();
    const link = screen.getByRole('link', { name: 'sites.layoutSettings.siteTypeOnDetails' });
    expect(link.getAttribute('href')).toBe('/sites/site-1');
  });

  it('shows only the parking lot settings on a parking lot', () => {
    renderPanel();
    expect(screen.getByLabelText('sites.layoutSettings.spotsPerRow')).toBeTruthy();
    expect(screen.getByLabelText('sites.layoutSettings.facingDeg')).toBeTruthy();
    // The power equipment sits behind its button, not inline.
    expect(screen.getByTestId('power-equipment')).toBeTruthy();
    expect(screen.queryByTestId('layout-energy-assets')).toBeNull();
    expect(screen.queryByLabelText('sites.layoutSettings.chargers')).toBeNull();
    expect(screen.queryByLabelText('sites.layoutSettings.mounting')).toBeNull();
    expect(screen.queryByLabelText('sites.layoutSettings.chargersLeft')).toBeNull();
  });

  it('sets the chargers and their mounting of an office or retail site, keeping the lot fields', () => {
    const office = effectiveLayoutSettings({ ...SETTINGS, siteType: 'office_retail' }, [], 6);
    const { onChange, onInvalidChange } = renderPanel(4, office);
    expect(screen.queryByLabelText('sites.layoutSettings.spotsPerRow')).toBeNull();
    expect(screen.queryByLabelText('sites.layoutSettings.facingDeg')).toBeNull();
    expect(screen.queryByTestId('power-equipment')).toBeNull();
    const chargers = screen.getByLabelText('sites.layoutSettings.chargers');
    expect((chargers as HTMLInputElement).value).toBe('6');
    fireEvent.change(chargers, { target: { value: '12' } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        chargers: 12,
        spotsPerRow: SETTINGS.spotsPerRow,
        transformers: SETTINGS.transformers,
      }),
    );
    fireEvent.change(chargers, { target: { value: '0' } });
    expect(onInvalidChange).toHaveBeenLastCalledWith(true);
    const mounting = screen.getByLabelText('sites.layoutSettings.mounting');
    expect((mounting as HTMLSelectElement).value).toBe('wall');
    expect(screen.getByText('sites.layoutSettings.mountingWallHint')).toBeTruthy();
    fireEvent.change(mounting, { target: { value: 'stall' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mounting: 'stall' }));
  });

  it('sets the chargers on each side of a curbside site, at least one in all', () => {
    const curb = effectiveLayoutSettings({ ...SETTINGS, siteType: 'curbside' }, [], 5);
    const { onChange, onInvalidChange } = renderPanel(1, curb);
    const left = screen.getByLabelText('sites.layoutSettings.chargersLeft');
    const right = screen.getByLabelText('sites.layoutSettings.chargersRight');
    expect((left as HTMLInputElement).value).toBe('3');
    expect((right as HTMLInputElement).value).toBe('2');
    fireEvent.change(left, { target: { value: '0' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ chargersLeft: 0 }));
    expect(onInvalidChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(right, { target: { value: '0' } });
    expect(onInvalidChange).toHaveBeenLastCalledWith(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('sites.layoutSettings.mounting')).toBeNull();
  });

  it('warns when an office or retail site has fewer charger positions than stations', () => {
    renderPanel(
      8,
      effectiveLayoutSettings({ ...SETTINGS, siteType: 'office_retail', chargers: 4 }),
    );
    expect(screen.getByRole('alert').textContent).toBe('sites.layoutSettings.tooFewChargers');
  });

  it('turns the lot with the facing', () => {
    const { onChange } = renderPanel();
    fireEvent.change(screen.getByLabelText('sites.layoutSettings.facingDeg'), {
      target: { value: '180' },
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ facingDeg: 180 }));
  });

  it('warns when the lot has fewer spots than the site has stations', () => {
    renderPanel(25);
    expect(screen.getByRole('alert').textContent).toBe('sites.layoutSettings.tooSmall');
  });

  it('shows a custom site with no counts and its power equipment button', () => {
    const custom = { ...SETTINGS, siteType: 'custom' as const, energyAssets: [] };
    renderPanel(4, custom);
    expect(screen.getByTestId('layout-settings-custom-hint').textContent).toBe(
      'sites.layoutSettings.customHint',
    );
    expect(screen.queryByLabelText('sites.layoutSettings.spotsPerRow')).toBeNull();
    expect(screen.queryByLabelText('sites.layoutSettings.facingDeg')).toBeNull();
    expect(screen.getByTestId('power-equipment')).toBeTruthy();
    // A custom site has no spot limit.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sets the bus bays, the truck lanes and the facing of a depot, at least one bay or lane in all', () => {
    const depot = effectiveLayoutSettings({ ...SETTINGS, siteType: 'depot' }, [], {
      total: 5,
      bus: 3,
      truck: 2,
    });
    const { onChange, onInvalidChange } = renderPanel(5, depot);
    const bus = screen.getByLabelText('sites.layoutSettings.busBays');
    const truck = screen.getByLabelText('sites.layoutSettings.truckLanes');
    expect((bus as HTMLInputElement).value).toBe('3');
    expect((truck as HTMLInputElement).value).toBe('2');
    expect(screen.getByLabelText('sites.layoutSettings.facingDeg')).not.toBeNull();
    expect(screen.queryByLabelText('sites.layoutSettings.spotsPerRow')).toBeNull();
    expect(screen.getByTestId('layout-settings-depot-hint')).not.toBeNull();
    fireEvent.change(bus, { target: { value: '6' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ busBays: 6 }));
    fireEvent.change(bus, { target: { value: '0' } });
    fireEvent.change(truck, { target: { value: '0' } });
    expect(onInvalidChange).toHaveBeenLastCalledWith(true);
    // Transformers, batteries and solar beside the yard: behind the Power Equipment button.
    expect(screen.getByTestId('power-equipment')).not.toBeNull();
  });

  it('warns when a depot has fewer bus bays and truck lanes than stations', () => {
    renderPanel(
      4,
      effectiveLayoutSettings({ ...SETTINGS, siteType: 'depot', busBays: 1, truckLanes: 1 }),
    );
    expect(screen.getByRole('alert').textContent).toBe('sites.layoutSettings.tooFewDepotSpots');
  });
});
