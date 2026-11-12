// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The station picture of the 2D charger card: a small render of the
// station's 3D model in its charger plate color. Each model, color and theme
// is rendered once per page by one shared offscreen WebGL renderer, loaded
// on demand (three.js stays out of the 2D view's bundle), and the renderer
// is disposed when no render waits. Without WebGL the card keeps its plain
// drawing (the cache answers null).

import {
  SPLIT_SYSTEM,
  chargerMountingOf,
  freeSpotTypeOf,
  siteTypeOf,
  splitDispenserCount,
  type ChargerMounting,
  type LayoutShape,
} from '@evtivity/lib/site-layout';
import type { LayoutStation } from './StationCard';
import { freeChargerModel, stationConnectorTypes, stationLayoutKindOf } from './site-layout-free';

/** The 3D charger models a card can show. */
export type ThumbnailModel =
  | 'dc-dispenser'
  | 'ac-pedestal'
  | 'ac-pedestal-dual'
  | 'curb-post'
  | 'wall-box'
  | 'wall-box-dual'
  | 'split-satellite'
  | 'bus-dispenser'
  | 'pantograph'
  | 'mcs-dispenser';

export const THUMBNAIL_MODELS: readonly ThumbnailModel[] = [
  'dc-dispenser',
  'ac-pedestal',
  'ac-pedestal-dual',
  'curb-post',
  'wall-box',
  'wall-box-dual',
  'split-satellite',
  'bus-dispenser',
  'pantograph',
  'mcs-dispenser',
];

/** The card picture size in CSS px; rendered at 2x for sharp screens. */
export const THUMBNAIL_SIZE = { width: 44, height: 60 } as const;
export const THUMBNAIL_PIXEL_RATIO = 2;

export interface ThumbnailRequest {
  model: ThumbnailModel;
  /** The charger plate color (`#rrggbb`). */
  plateColor: string;
  dark: boolean;
}

export function thumbnailKey(r: ThumbnailRequest): string {
  return `${r.model}:${r.plateColor.toLowerCase()}:${r.dark ? 'dark' : 'light'}`;
}

/** The layout settings the model choice reads. */
export type ThumbnailSiteShape = LayoutShape & { mounting?: ChargerMounting | undefined };

/**
 * The model the 3D view draws for a station, by the same rules: a depot's
 * bus bay or truck lane charger, a custom site's charger for its spot type,
 * a DC split system's satellite, an office or retail wall box (two ports
 * side by side for two EVSEs), a street's
 * curb post, else the DC dispenser or the AC pedestal (dual port for two EVSEs).
 */
export function stationThumbnailModel(
  station: Pick<LayoutStation, 'evses' | 'freePosition' | 'units' | 'unitCharger'>,
  settings: ThumbnailSiteShape,
): ThumbnailModel {
  const kind = stationLayoutKindOf(station);
  const type = siteTypeOf(settings);
  const types = stationConnectorTypes(station as LayoutStation);
  const ports = kind.ports ?? 1;
  const large = (spot: Parameters<typeof freeChargerModel>[0]): ThumbnailModel | null => {
    const m = freeChargerModel(spot, kind.charging, types);
    if (m === 'truck_mcs') return 'mcs-dispenser';
    if (m === 'bus_dispenser') return 'bus-dispenser';
    if (m === 'pantograph_down' || m === 'pantograph_up') return 'pantograph';
    return null;
  };
  if (type === 'depot' && kind.depot != null) {
    const m = large(kind.depot === 'truck' ? 'truck_pull_through' : 'bus_bay');
    if (m != null) return m;
  }
  if (type === 'custom' && station.freePosition != null) {
    const spot = freeSpotTypeOf(station.freePosition);
    const m = large(spot);
    if (m != null) return m;
    if (
      spot === 'car' &&
      kind.charging === 'dc' &&
      ports >= SPLIT_SYSTEM.minDispensers &&
      station.unitCharger == null
    ) {
      return 'split-satellite';
    }
  }
  if (kind.charging === 'dc') {
    // A unit charger is never a split system: one dispenser (`unitChargerSpotCount`).
    if (station.unitCharger != null) return 'dc-dispenser';
    return splitDispenserCount(kind, settings) > 1 ? 'split-satellite' : 'dc-dispenser';
  }
  if (type === 'office_retail' && chargerMountingOf(settings) === 'wall') {
    return ports >= 2 ? 'wall-box-dual' : 'wall-box';
  }
  if (type === 'curbside' && ports < 2) return 'curb-post';
  return ports >= 2 ? 'ac-pedestal-dual' : 'ac-pedestal';
}

/** Renders a model to an image URL; the WebGL one, or a fake in tests. */
export interface ThumbnailRenderer {
  render: (request: ThumbnailRequest) => string;
  dispose: () => void;
}

export type ThumbnailRendererFactory = () => Promise<ThumbnailRenderer | null>;

/**
 * The page's thumbnails: each key rendered once and kept for the page. The
 * renderer is made on the first request and disposed `idleMs` after the last
 * render; a factory that answers null (no WebGL) makes every answer null.
 */
export class StationThumbnailCache {
  private readonly images = new Map<string, string | null>();
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly listeners = new Set<() => void>();
  private renderer: Promise<ThumbnailRenderer | null> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private unavailable = false;

  constructor(
    private readonly factory: ThumbnailRendererFactory,
    private readonly idleMs = 2000,
  ) {}

  /** The image of a request when rendered (null: none can be made), else undefined. */
  peek(request: ThumbnailRequest): string | null | undefined {
    if (this.unavailable) return null;
    return this.images.get(thumbnailKey(request));
  }

  /** Calls `listener` whenever an image lands; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get(request: ThumbnailRequest): Promise<string | null> {
    const key = thumbnailKey(request);
    const known = this.peek(request);
    if (known !== undefined) return Promise.resolve(known);
    const running = this.pending.get(key);
    if (running != null) return running;
    const job = this.renderOne(key, request);
    this.pending.set(key, job);
    return job;
  }

  private async renderOne(key: string, request: ThumbnailRequest): Promise<string | null> {
    if (this.idleTimer != null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.renderer ??= this.factory().catch((err: unknown) => {
      console.warn('Station thumbnail renderer failed to start, using the plain drawing', err);
      return null;
    });
    const renderer = await this.renderer;
    let image: string | null = null;
    if (renderer == null) {
      this.unavailable = true;
    } else {
      try {
        image = renderer.render(request);
      } catch (err: unknown) {
        console.warn('Station thumbnail render failed, using the plain drawing', err);
      }
    }
    this.images.set(key, image);
    this.pending.delete(key);
    for (const l of this.listeners) l();
    if (this.pending.size === 0 && renderer != null) this.scheduleDispose(renderer);
    return this.unavailable ? null : image;
  }

  private scheduleDispose(renderer: ThumbnailRenderer): void {
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size > 0) return;
      renderer.dispose();
      this.renderer = null;
    }, this.idleMs);
  }
}

/** The WebGL renderer, loaded with three.js only when a card first asks for a picture. */
async function loadWebGlRenderer(): Promise<ThumbnailRenderer | null> {
  const { createWebGlThumbnailRenderer } = await import('./site-layout-station-thumbnail-webgl');
  return createWebGlThumbnailRenderer();
}

/** The page-wide cache the 2D cards share. */
export const stationThumbnails = new StationThumbnailCache(loadWebGlRenderer);
