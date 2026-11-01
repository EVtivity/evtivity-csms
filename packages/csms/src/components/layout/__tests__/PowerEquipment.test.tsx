// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cloneElement, type ReactElement } from 'react';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { effectiveLayoutSettings, type SiteLayoutSettings } from '@evtivity/lib/site-layout';

vi.mock('react-i18next', () => ({
  // Renders the key, then each component with its name as the text.
  Trans: ({
    i18nKey,
    components,
  }: {
    i18nKey: string;
    components: Record<string, ReactElement>;
  }) => (
    <>
      {i18nKey}
      {Object.entries(components).map(([name, el]) => cloneElement(el, { key: name }, name))}
    </>
  ),
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts != null && 'n' in opts
        ? `${key}:${String(opts['n'])}`
        : opts != null && 'count' in opts
          ? `${key}:${String(opts['count'])}`
          : key,
    i18n: { language: 'en' },
  }),
}));

import {
  PowerEquipmentField,
  newTransformer,
  parseRatedKva,
  powerEquipmentCounts,
} from '../PowerEquipment';

// A parking lot with its default transformer.
const SETTINGS = effectiveLayoutSettings(null);

function renderField(settings: SiteLayoutSettings, writable = true) {
  const onChange = vi.fn();
  render(
    <MemoryRouter>
      <PowerEquipmentField
        siteId="site_1"
        settings={settings}
        {...(writable ? { onChange } : {})}
      />
    </MemoryRouter>,
  );
  return { onChange };
}

function openDialog(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: /sites.layoutSettings.powerEquipment/ }));
  return screen.getByRole('dialog');
}

afterEach(() => {
  cleanup();
});

describe('PowerEquipmentField', () => {
  it('shows one button with a one-line summary of the equipment', () => {
    const settings: SiteLayoutSettings = {
      ...SETTINGS,
      energyAssets: [
        { id: 'bat-1', type: 'battery', name: null, capacityKwh: 500, x: 30, z: 4 },
        { id: 'pv-1', type: 'solar', name: null, capacityKwp: 100, row: 0 },
      ],
    };
    renderField(settings);
    expect(screen.getByTestId('power-equipment-summary').textContent).toBe(
      'sites.layoutSettings.powerEquipmentTransformers:1, sites.layoutSettings.powerEquipmentBatteries:1, sites.layoutSettings.powerEquipmentSolar:1',
    );
    // No equipment fields inline: only in the dialog.
    expect(screen.queryByLabelText('sites.layoutSettings.ratedKva')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(powerEquipmentCounts(settings)).toEqual({ transformers: 1, batteries: 1, solar: 1 });
  });

  it('notes under the button and in the dialog that the equipment is for the layout only', () => {
    renderField(SETTINGS);
    const note = screen.getByTestId('power-equipment-note');
    expect(note.textContent).toContain('sites.layoutSettings.powerEquipmentLayoutOnly');
    expect(within(note).getByRole('link', { name: 'loadManagement' }).getAttribute('href')).toBe(
      '/sites/site_1?tab=load-management',
    );
    const dialog = openDialog();
    const dialogNote = within(dialog).getByTestId('power-equipment-dialog-note');
    expect(
      within(dialogNote).getByRole('link', { name: 'loadManagement' }).getAttribute('href'),
    ).toBe('/sites/site_1?tab=load-management');
  });

  it('shows the note in the read-only dialog too', () => {
    renderField(SETTINGS, false);
    expect(screen.getByTestId('power-equipment-note')).toBeTruthy();
    expect(within(openDialog()).getByTestId('power-equipment-dialog-note')).toBeTruthy();
  });

  it('says none when the site has no equipment', () => {
    renderField({ ...SETTINGS, transformers: [], energyAssets: [] });
    expect(screen.getByTestId('power-equipment-summary').textContent).toBe(
      'sites.layoutSettings.powerEquipmentNone',
    );
  });

  it('shows no button on an office or retail site or a street', () => {
    renderField(effectiveLayoutSettings({ ...SETTINGS, siteType: 'office_retail' }, [], 4));
    expect(screen.queryByTestId('power-equipment')).toBeNull();
    cleanup();
    renderField(effectiveLayoutSettings({ ...SETTINGS, siteType: 'curbside' }, [], 4));
    expect(screen.queryByTestId('power-equipment')).toBeNull();
  });

  it('adds, names, rates and removes transformers in the dialog and applies them on Apply', () => {
    const { onChange } = renderField(SETTINGS);
    const dialog = openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: /addTransformer/ }));
    fireEvent.change(within(dialog).getByLabelText('sites.layoutSettings.transformerName:1'), {
      target: { value: 'Main Feed' },
    });
    const [kva] = within(dialog).getAllByLabelText('sites.layoutSettings.ratedKva');
    if (kva == null) throw new Error('no rated kVA field');
    fireEvent.change(kva, { target: { value: '2500' } });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'sites.layoutSettings.removeTransformer:2' }),
    );
    // Nothing reaches the layout before Apply.
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole('button', { name: /sites.layoutSettings.powerEquipmentApply/ }),
    );
    const applied = onChange.mock.lastCall?.[0] as SiteLayoutSettings;
    expect(applied.transformers).toHaveLength(1);
    expect(applied.transformers[0]).toMatchObject({ name: 'Main Feed', ratedKva: 2500 });
    // The other settings stay as they are.
    expect(applied.spotsPerRow).toBe(SETTINGS.spotsPerRow);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps Apply off while a value is invalid, and Cancel drops the edits', () => {
    const { onChange } = renderField(SETTINGS);
    const dialog = openDialog();
    fireEvent.change(within(dialog).getByLabelText('sites.layoutSettings.ratedKva'), {
      target: { value: '0' },
    });
    const apply = within(dialog).getByRole('button', {
      name: /sites.layoutSettings.powerEquipmentApply/,
    });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: /common.cancel/ }));
    expect(onChange).not.toHaveBeenCalled();
    // Reopened, the dialog starts from the stored equipment again.
    const again = openDialog();
    expect(within(again).getByLabelText('sites.layoutSettings.ratedKva')).toHaveProperty(
      'value',
      '',
    );
  });

  it('adds a solar canopy on a custom site, standing freely', () => {
    const custom = { ...SETTINGS, siteType: 'custom' as const, energyAssets: [] };
    const { onChange } = renderField(custom);
    const dialog = openDialog();
    expect(within(dialog).getByText('sites.layoutSettings.transformersHintCustom')).toBeDefined();
    expect(within(dialog).getByText('sites.layoutSettings.energyAssetsHintCustom')).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: /addSolar/ }));
    fireEvent.click(
      within(dialog).getByRole('button', { name: /sites.layoutSettings.powerEquipmentApply/ }),
    );
    const applied = onChange.mock.lastCall?.[0] as SiteLayoutSettings;
    expect(applied.energyAssets?.[0]).toMatchObject({ type: 'solar', x: 0, rotationDeg: 0 });
  });

  it('lists the equipment read-only without write access', () => {
    const [first] = SETTINGS.transformers;
    if (first == null) throw new Error('no default transformer');
    renderField({ ...SETTINGS, transformers: [{ ...first, ratedKva: 750 }] }, false);
    const dialog = openDialog();
    expect(within(dialog).getByText('sites.layoutSettings.powerEquipmentReadOnly')).toBeDefined();
    expect(within(dialog).getByTestId('power-equipment-list').textContent).toContain('750 kVA');
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /addTransformer/ })).toBeNull();
    expect(
      within(dialog).queryByRole('button', { name: /sites.layoutSettings.powerEquipmentApply/ }),
    ).toBeNull();
    const close = within(dialog).getAllByRole('button', { name: 'common.close' }).at(-1);
    if (close == null) throw new Error('no Close button');
    fireEvent.click(close);
  });
});

describe('power equipment helpers', () => {
  it('reads a rated kVA: empty is none, a whole number in range counts', () => {
    expect(parseRatedKva('')).toBeNull();
    expect(parseRatedKva('2500')).toBe(2500);
    expect(parseRatedKva('0')).toBeUndefined();
  });

  it('places a new transformer on the grass in front of the lot, or freely on a custom site', () => {
    const t = newTransformer(SETTINGS);
    expect(t.z).toBeLessThan(0);
    expect(t.id).toBe('tx-2');
    const custom = { ...SETTINGS, siteType: 'custom' as const };
    expect(newTransformer(custom)).toMatchObject({ x: -8, z: -8 });
  });
});
