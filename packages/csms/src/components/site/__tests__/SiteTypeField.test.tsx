// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { effectiveLayoutSettings } from '@evtivity/lib/site-layout';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts != null && 'summary' in opts ? `${key}:${String(opts['summary'])}` : key,
    i18n: { language: 'en' },
  }),
}));

import { SiteTypeField } from '../SiteTypeField';
import { layoutSummary } from '../site-type';

afterEach(cleanup);

describe('SiteTypeField charger placement', () => {
  it('shows Charger Placement for a parking lot and sends the choice', () => {
    const onPlacementChange = vi.fn();
    render(
      <SiteTypeField
        id="t"
        value="parking_lot"
        onChange={vi.fn()}
        placement="islands"
        onPlacementChange={onPlacementChange}
      />,
    );
    const select = screen.getByLabelText('sites.layoutSettings.chargerPlacement');
    fireEvent.change(select, { target: { value: 'lot_edge' } });
    expect(onPlacementChange).toHaveBeenCalledWith('lot_edge');
  });

  it('hides Charger Placement on every other site type', () => {
    for (const type of ['office_retail', 'curbside', 'depot', 'custom'] as const) {
      render(
        <SiteTypeField
          id="t"
          value={type}
          onChange={vi.fn()}
          placement="islands"
          onPlacementChange={vi.fn()}
        />,
      );
      expect(screen.queryByLabelText('sites.layoutSettings.chargerPlacement')).toBeNull();
      cleanup();
    }
  });

  it('names Lot Edge in the layout summary of a parking lot', () => {
    const t = ((key: string, opts?: Record<string, unknown>) =>
      opts != null && 'summary' in opts ? `${key}:${String(opts['summary'])}` : key) as never;
    const islands = effectiveLayoutSettings({
      siteType: 'parking_lot',
      spotsPerRow: 6,
      rows: 3,
      facingDeg: 0,
      transformers: [],
    });
    expect(layoutSummary(t, islands)).toBe('sites.layoutSummary.parkingLot');
    expect(layoutSummary(t, { ...islands, chargerPlacement: 'lot_edge' })).toBe(
      'sites.layoutSummary.lotEdge:sites.layoutSummary.parkingLot',
    );
  });
});
