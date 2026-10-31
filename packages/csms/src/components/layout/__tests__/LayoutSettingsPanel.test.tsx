// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { effectiveLayoutSettings } from '@evtivity/lib/site-layout';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts != null && 'n' in opts ? `${key}:${String(opts['n'])}` : key,
    i18n: { language: 'en' },
  }),
}));

import {
  LayoutSettingsPanel,
  newTransformer,
  parseLotField,
  parseRatedKva,
} from '../LayoutSettingsPanel';

const SETTINGS = effectiveLayoutSettings(null);

function renderPanel(stationCount = 4, settings = SETTINGS) {
  const onChange = vi.fn();
  const onInvalidChange = vi.fn();
  render(
    <LayoutSettingsPanel
      settings={settings}
      stationCount={stationCount}
      onChange={onChange}
      onInvalidChange={onInvalidChange}
    />,
  );
  return { onChange, onInvalidChange };
}

afterEach(() => {
  cleanup();
});

describe('LayoutSettingsPanel', () => {
  it('parses the lot fields inside their ranges and in 10 cm steps', () => {
    expect(parseLotField('spotsPerRow', '12')).toBe(12);
    expect(parseLotField('spotsPerRow', '0')).toBeNull();
    expect(parseLotField('rows', '1.5')).toBeNull();
    expect(parseLotField('spotWidthM', '3.5')).toBe(3.5);
    expect(parseLotField('spotWidthM', '3.55')).toBeNull();
    expect(parseLotField('laneWidthM', '')).toBeNull();
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

  it('picks the site type, a parking lot by default', () => {
    const { onChange } = renderPanel();
    expect(screen.getByText('sites.layoutSettings.title')).toBeTruthy();
    expect(screen.getByLabelText('sites.layoutSettings.siteType')).toBeTruthy();
    const select = document.getElementById('layout-settings-siteType');
    if (!(select instanceof HTMLSelectElement)) throw new Error('no site type select');
    expect(select.value).toBe('parking_lot');
    expect([...select.options].map((o) => o.value)).toEqual(['parking_lot', 'office_retail']);
    fireEvent.change(select, { target: { value: 'office_retail' } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ siteType: 'office_retail', transformers: SETTINGS.transformers }),
    );
  });

  it('hides the transformers of an office or retail site and keeps them in the settings', () => {
    renderPanel(4, { ...SETTINGS, siteType: 'office_retail' });
    expect(screen.getByTestId('layout-transformers-hidden')).toBeTruthy();
    expect(screen.queryByText('sites.layoutSettings.addTransformer')).toBeNull();
    expect(screen.queryByTestId('layout-transformer-tx-1')).toBeNull();
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

  it('adds, names, rates and removes transformers', () => {
    const { onChange } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /addTransformer/ }));
    const added = onChange.mock.lastCall?.[0] as typeof SETTINGS;
    expect(added.transformers).toHaveLength(2);
    expect(added.transformers[1]?.id).toBe('tx-2');
    fireEvent.change(screen.getByLabelText('sites.layoutSettings.transformerName:1'), {
      target: { value: 'Main Feed' },
    });
    expect((onChange.mock.lastCall?.[0] as typeof SETTINGS).transformers[0]?.name).toBe(
      'Main Feed',
    );
    fireEvent.change(screen.getByLabelText('sites.layoutSettings.ratedKva'), {
      target: { value: '2500' },
    });
    expect((onChange.mock.lastCall?.[0] as typeof SETTINGS).transformers[0]?.ratedKva).toBe(2500);
    fireEvent.click(
      screen.getByRole('button', { name: 'sites.layoutSettings.removeTransformer:1' }),
    );
    expect((onChange.mock.lastCall?.[0] as typeof SETTINGS).transformers).toEqual([]);
  });

  it('places a new transformer on the grass in front of the lot', () => {
    const t = newTransformer(SETTINGS);
    expect(t.z).toBeLessThan(0);
    expect(t.id).toBe('tx-2');
  });
});
