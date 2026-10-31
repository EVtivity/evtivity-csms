// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  bayInGrid,
  effectiveLayoutSettings,
  energyAssetsOf,
  layoutGridCapacity,
  sameLayoutSettings,
  siteTypeOf,
} from '@evtivity/lib/site-layout';
import { siteLayoutSettingsSchema } from '@evtivity/lib/site-layout-schema';
import { LAYOUT_DEMO, LAYOUT_DEMO_PREVIOUS_SETTINGS } from '../seed-demo-layout-plan.js';

const [harbor, lakeside] = LAYOUT_DEMO.sites;
const allStations = LAYOUT_DEMO.sites.flatMap((s) => s.stations);

describe('site layout demo plan', () => {
  it('makes Harbor Point a parking lot of DC fast chargers with its transformers', () => {
    expect(siteTypeOf(harbor!.settings)).toBe('parking_lot');
    expect(new Set(harbor!.stations.map((s) => s.kind))).toEqual(new Set(['dc']));
    expect(harbor!.settings.transformers.length).toBeGreaterThan(0);
    // One battery on the grass and one solar canopy over a row of the lot.
    const assets = energyAssetsOf(harbor!.settings);
    expect(assets.map((a) => a.type).sort()).toEqual(['battery', 'solar']);
    const effective = effectiveLayoutSettings(harbor!.settings);
    expect(effective.energyAssets).toEqual(assets);
  });

  it('makes Lakeside Retail Park an office or retail site of AC chargers along the building, no transformers', () => {
    expect(siteTypeOf(lakeside!.settings)).toBe('office_retail');
    expect(new Set(lakeside!.stations.map((s) => s.kind))).toEqual(new Set(['ac']));
    expect(lakeside!.settings.transformers).toEqual([]);
    // Every charger stands in the row along the building (wall boxes).
    expect(new Set(lakeside!.stations.map((s) => s.row))).toEqual(new Set([0]));
  });

  it('has valid settings, every station on its own spot inside the lot, on a circuit of its site', () => {
    for (const site of LAYOUT_DEMO.sites) {
      expect(siteLayoutSettingsSchema.safeParse(site.settings).success).toBe(true);
      expect(site.stations.length).toBeLessThanOrEqual(layoutGridCapacity(site.settings));
      const spots = new Set(site.stations.map((s) => `${String(s.col)}:${String(s.row)}`));
      expect(spots.size).toBe(site.stations.length);
      for (const s of site.stations) {
        expect(bayInGrid({ col: s.col, row: s.row }, site.settings)).toBe(true);
      }
      const circuits = new Set(site.panels.flatMap((p) => p.circuits.map((c) => c.id)));
      for (const s of site.stations) expect(circuits.has(s.circuitId)).toBe(true);
      // A sub-panel hangs under a panel of the same site.
      const panels = new Set(site.panels.map((p) => p.id));
      for (const p of site.panels) {
        if (p.parentPanelId != null) expect(panels.has(p.parentPanelId)).toBe(true);
      }
    }
    expect(new Set(allStations.map((s) => s.id)).size).toBe(allStations.length);
  });

  it('keeps the state variety: maintenance, offline and cellular stations', () => {
    expect(harbor!.stations.some((s) => s.maintenance === true)).toBe(true);
    expect(allStations.some((s) => s.offline === true)).toBe(true);
    expect(harbor!.stations.some((s) => s.cellular === true)).toBe(true);
    expect(lakeside!.stations.some((s) => s.cellular === true)).toBe(true);
    // The faulted station runs no simulator, so its fault and insight stay.
    const faulted = allStations.filter((s) => s.faulted === true);
    expect(faulted).toHaveLength(1);
    expect(faulted[0]?.offline).toBe(true);
    expect(LAYOUT_DEMO.faultInsightId).toMatch(/^ain_[a-z0-9]{12}$/);
  });

  it('puts the card readers on DC chargers', () => {
    for (const t of LAYOUT_DEMO.terminals) {
      expect(allStations.find((s) => s.id === t.stationId)?.kind).toBe('dc');
    }
  });

  it('moves every station of the earlier plan away from the other site, and replaces only its own earlier settings', () => {
    for (const site of LAYOUT_DEMO.sites) {
      for (const s of site.stations) {
        if (s.movedFrom != null) expect(s.movedFrom.siteId).not.toBe(site.id);
      }
      const previous = LAYOUT_DEMO_PREVIOUS_SETTINGS[site.id] ?? [];
      expect(previous.length).toBeGreaterThan(0);
      for (const p of previous) expect(sameLayoutSettings(p, site.settings)).toBe(false);
    }
    // Harbor Point's plan before the battery and the solar canopy is replaced too.
    const beforeAssets = { ...harbor!.settings };
    delete beforeAssets.energyAssets;
    expect(
      (LAYOUT_DEMO_PREVIOUS_SETTINGS[harbor!.id] ?? []).some((p) =>
        sameLayoutSettings(p, beforeAssets),
      ),
    ).toBe(true);
  });
});
