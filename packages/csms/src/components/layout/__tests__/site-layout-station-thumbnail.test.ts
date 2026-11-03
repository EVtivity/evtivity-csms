// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { DEFAULT_LAYOUT_GRID } from '@evtivity/lib/site-layout';
import {
  StationThumbnailCache,
  stationThumbnailModel,
  thumbnailKey,
  type ThumbnailRenderer,
  type ThumbnailRequest,
} from '../site-layout-station-thumbnail';
import type { LayoutStation } from '../StationCard';

type Conn = { type: string; kw: number };

function station(
  evses: Conn[][],
  free?: LayoutStation['freePosition'],
): Pick<LayoutStation, 'evses' | 'freePosition'> {
  return {
    evses: evses.map((conns, i) => ({
      evseId: i + 1,
      status: 'available',
      connectors: conns.map((c, k) => ({
        connectorId: k + 1,
        connectorType: c.type,
        maxPowerKw: c.kw,
        status: 'available',
        isPluggedIn: false,
        energyDeliveredWh: null,
      })),
    })),
    freePosition: free,
  };
}

const CCS = { type: 'CCS1', kw: 150 };
const T1 = { type: 'Type1', kw: 7.2 };
const MCS = { type: 'MCS', kw: 1200 };

describe('stationThumbnailModel', () => {
  const lot = { ...DEFAULT_LAYOUT_GRID, siteType: 'parking_lot' as const };

  it('picks the DC dispenser, the AC pedestal and the dual-port pedestal on a parking lot', () => {
    expect(stationThumbnailModel(station([[CCS], [CCS]]), lot)).toBe('dc-dispenser');
    expect(stationThumbnailModel(station([[T1]]), lot)).toBe('ac-pedestal');
    expect(stationThumbnailModel(station([[T1], [T1]]), lot)).toBe('ac-pedestal-dual');
  });

  it('picks the split satellite for a DC station of three or more EVSEs on a lot', () => {
    expect(stationThumbnailModel(station([[CCS], [CCS], [CCS]]), lot)).toBe('split-satellite');
  });

  it('picks the wall box on a wall-mounted office or retail site, the curb post on a street', () => {
    const office = {
      ...DEFAULT_LAYOUT_GRID,
      siteType: 'office_retail' as const,
      mounting: 'wall' as const,
    };
    expect(stationThumbnailModel(station([[T1]]), office)).toBe('wall-box');
    expect(stationThumbnailModel(station([[T1]]), { ...office, mounting: 'stall' as const })).toBe(
      'ac-pedestal',
    );
    const street = { ...DEFAULT_LAYOUT_GRID, siteType: 'curbside' as const };
    expect(stationThumbnailModel(station([[T1]]), street)).toBe('curb-post');
    expect(stationThumbnailModel(station([[T1], [T1]]), street)).toBe('ac-pedestal-dual');
  });

  it('picks the depot charger of the bay or lane: bus dispenser, pantograph, MCS dispenser', () => {
    const depot = { ...DEFAULT_LAYOUT_GRID, siteType: 'depot' as const };
    expect(stationThumbnailModel(station([[CCS]]), depot)).toBe('bus-dispenser');
    expect(stationThumbnailModel(station([[MCS]]), depot)).toBe('mcs-dispenser');
    expect(stationThumbnailModel(station([[{ type: 'OppCharge', kw: 450 }]]), depot)).toBe(
      'pantograph',
    );
  });

  it('picks the custom site charger by the spot type', () => {
    const custom = { ...DEFAULT_LAYOUT_GRID, siteType: 'custom' as const };
    expect(
      stationThumbnailModel(
        station([[MCS]], { x: 0, z: 0, rotationDeg: 0, spotType: 'truck_pull_through' }),
        custom,
      ),
    ).toBe('mcs-dispenser');
    expect(stationThumbnailModel(station([[CCS]], { x: 0, z: 0, rotationDeg: 0 }), custom)).toBe(
      'dc-dispenser',
    );
  });
});

describe('StationThumbnailCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const req: ThumbnailRequest = { model: 'dc-dispenser', plateColor: '#EA7A1A', dark: false };

  function fakeRenderer() {
    return {
      render: vi.fn<ThumbnailRenderer['render']>(
        (r: ThumbnailRequest) => `data:image/png;base64,${thumbnailKey(r)}`,
      ),
      dispose: vi.fn<ThumbnailRenderer['dispose']>(),
    };
  }

  it('renders each model, color and theme once, shares the renderer and notifies listeners', async () => {
    const renderer = fakeRenderer();
    const factory = vi.fn(() => Promise.resolve(renderer));
    const cache = new StationThumbnailCache(factory);
    const listener = vi.fn();
    cache.subscribe(listener);
    expect(cache.peek(req)).toBeUndefined();
    const [a, b] = await Promise.all([cache.get(req), cache.get(req)]);
    expect(a).toBe(b);
    expect(a).toContain('dc-dispenser:#ea7a1a:light');
    expect(await cache.get(req)).toBe(a);
    await cache.get({ ...req, dark: true });
    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(cache.peek(req)).toBe(a);
  });

  it('disposes the renderer after the last render and makes a new one for a later request', async () => {
    vi.useFakeTimers();
    const first = fakeRenderer();
    const second = fakeRenderer();
    const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const cache = new StationThumbnailCache(factory, 100);
    await cache.get(req);
    expect(first.dispose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    await cache.get({ ...req, model: 'ac-pedestal' });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(second.render).toHaveBeenCalledTimes(1);
  });

  it('answers null for every request without WebGL (the plain drawing stays)', async () => {
    const cache = new StationThumbnailCache(() => Promise.resolve(null));
    expect(await cache.get(req)).toBeNull();
    expect(cache.peek({ ...req, model: 'wall-box' })).toBeNull();
  });

  it('answers null for a render that throws, and keeps the cache working', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const renderer = fakeRenderer();
    renderer.render.mockImplementationOnce(() => {
      throw new Error('lost context');
    });
    const cache = new StationThumbnailCache(() => Promise.resolve(renderer));
    expect(await cache.get(req)).toBeNull();
    expect(await cache.get({ ...req, model: 'curb-post' })).toContain('curb-post');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
