// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The standard 2D charger card of every site type's board (owner design
// 2026-11-03): one fixed size (`STATION_CARD_SIZE`), the whole card one
// button that opens the station popup, a 3 px accent bar in the station state
// color on its left. With edit rights it drags (a grip shows on hover) and,
// focused, the board moves it with the arrow keys.

import { useLayoutEffect, useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  stationDisplayState,
  stationStateColor,
  stationStateLabelKey,
} from '@/lib/station-display-state';
import type { AvatarData } from '@/components/AccountAvatar';
import type { FreePlacement } from '@evtivity/lib/site-layout';
import type { ScreenMessage } from './site-layout-screen-text';
import { STATION_CARD_SIZE } from './site-layout-2d-placement';
import { StationCardContent } from './StationCardContent';
import { layoutChargerName } from './site-layout-units';

let globalDragCounter = 0;

interface ConnectorData {
  connectorId: number;
  /** The connector is retired (out of service); absent in older replies. */
  retired?: boolean | undefined;
  connectorType: string | null;
  maxPowerKw: number | null;
  status: string;
  isPluggedIn: boolean;
  energyDeliveredWh: number | null;
}

interface EvseData {
  evseId: number;
  status: string;
  connectors: ConnectorData[];
  /** The unit the EVSE belongs to (unt_), null or absent for none. */
  unitId?: string | null | undefined;
  /** The EVSE is retired (out of service); absent in older replies. */
  retired?: boolean | undefined;
  /** This EVSE's active session (each EVSE draws its own car); null or absent without one. */
  session?: LayoutEvseSession | null | undefined;
}

/** The active session of one EVSE (only with sessions:read). */
export interface LayoutEvseSession {
  id: string;
  startedAt: string;
  energyDeliveredWh: number;
  currentCostCents: number | null;
  currency: string;
  driver: LayoutSessionDriver | null;
  vehicle?: { color: string | null; bodyType: string | null } | null | undefined;
}

/** One unit of a station (a physical charger box under one OCPP station). */
export interface LayoutUnit {
  id: string;
  name: string;
  /** OCPP EVSE IDs of the unit. */
  evseIds: number[];
  /** Where the unit card stands on the 2D board; null or absent shows its computed default slot. */
  boardPosition?: { x: number; y: number } | null | undefined;
}

/** The driver of an active session (only with drivers:read). */
export interface LayoutSessionDriver {
  id: string;
  name: string | null;
  avatar: AvatarData | null;
}

/**
 * The departure a session charges for (route-aware charging, only with
 * fleets:read). The readiness fields are null while the depot plan does not run.
 */
export interface LayoutSessionDeparture {
  id: string;
  /** Null for an ad hoc request of a bus depot system (charge as soon as possible). */
  departureAt: string | null;
  /** IANA time zone of the depot. */
  timezone: string;
  readiness: 'ready' | 'on_track' | 'at_risk' | 'cannot_meet' | 'waiting_for_vehicle' | null;
  reason: string | null;
  targetKwh: number | null;
  targetSocPercent: number | null;
  deliveredKwh: number | null;
  shortfallKwh: number | null;
  predictedReadyAt: string | null;
}

/** The newest active session of a station (only with sessions:read). */
export interface LayoutSession {
  id: string;
  startedAt: string;
  energyDeliveredWh: number;
  currentCostCents: number | null;
  currency: string;
  /** The OCPP EVSE id the session runs on; null or absent when the station has not named it. */
  evseId?: number | null | undefined;
  driver: LayoutSessionDriver | null;
  /** The car the layout draws (color and body type); null or absent draws a grey sedan. */
  vehicle?: { color: string | null; bodyType: string | null } | null | undefined;
  /** Absent without fleets:read, null when the session charges for no departure. */
  departure?: LayoutSessionDeparture | null | undefined;
}

export interface LayoutStation {
  id: string;
  stationId: string;
  model: string | null;
  status: string;
  statusReason?: string | null | undefined;
  isOnline: boolean;
  securityProfile: number;
  positionX: number;
  positionY: number;
  /** False while the position is a free slot the server picked, not saved yet. */
  placed: boolean;
  chargingKind: 'ac' | 'dc';
  cellular: boolean;
  /** How the station connects: cellular (data plan or confirmed SIM), wifi or wired (the reported active network interface), else wifi_or_wired; absent in older replies. */
  connectionType?: 'cellular' | 'wifi' | 'wired' | 'wifi_or_wired' | null | undefined;
  /** OCPP version (1.6, 2.0.1, 2.1); null when unknown or without stations:read. */
  ocppVersion?: string | null | undefined;
  /** The radio access technology the SIM provider reported, as reported; null when not known. */
  networkType?: string | null | undefined;
  /** The reported cellular signal (bars 0 to 4 and dBm); null when not known. */
  signal?: { bars: number; dbm: number } | null | undefined;
  inMaintenance: boolean;
  /** A simulator station (the popup offers its simulator actions); absent in older replies. */
  isSimulator?: boolean | undefined;
  displayMessage: string | null;
  /** What the charger screen shows, in the viewer's language, and its source (absent in older replies and the day replay). */
  screenMessage?: ScreenMessage | null | undefined;
  evses: EvseData[];
  /** The reservation holding the station now (null: none or no reservations:read; absent in older replies). */
  reservation?: { startsAt: string | null; endsAt: string } | null | undefined;
  /** The active maintenance window covering it (null: none; absent in older replies). */
  maintenanceWindow?: { startsAt: string | null; endsAt: string } | null | undefined;
  /** The active session: null without one or without sessions:read (absent in older replies). */
  session?: LayoutSession | null | undefined;
  /** Custom site: where the station stands (meters and turn); null or absent on the other site types. */
  freePosition?: FreePlacement | null | undefined;
  /** Where its card stands on the 2D board (board px); null or absent shows the computed default slot. */
  boardPosition?: { x: number; y: number } | null | undefined;
  /** The station's units in order, each drawn as its own charger; empty or absent for none (one charger). */
  units?: LayoutUnit[] | undefined;
  /**
   * Set on the view of one unit charger of a station with units
   * (`expandUnitStations`, site-layout-units.ts): the station it belongs to
   * and the unit it draws. Absent on a station without units.
   */
  unitCharger?: LayoutUnitCharger | undefined;
}

/** The unit charger a layout view station draws (`expandUnitStations`). */
export interface LayoutUnitCharger {
  /** The station (internal id) the charger belongs to. */
  stationUuid: string;
  /** The unit id; null for the charger of the EVSEs without a unit. */
  unitId: string | null;
  /** The unit name; null for the EVSEs without a unit. */
  name: string | null;
  /** The charger's place in the station's order, from 0. */
  index: number;
  /** Grid sites: the column offset of its first spot from the station's slot. */
  offset: number;
  /** Grid sites: the spots it holds (2: on the line between its two spots); a custom site: its car spots. */
  spots: number;
  /** A custom site: how far across the station's frame it stands from the station's point, in meters. */
  freeOffsetX: number;
  /** The station's own charging kind, which places its run (DC when any unit is DC). */
  stationKind: 'ac' | 'dc';
  /**
   * The box number on its plate: the unit's 1-based place in the station's
   * unit order (sort order), never read from the name; null for the EVSEs
   * without a unit.
   */
  number: number | null;
}

/** The connector an EVSE shows the status of: the one plugged in, else the first. */
export function evseShownConnector(evse: Pick<EvseData, 'connectors' | 'status'>): {
  status: string;
} {
  return (
    evse.connectors.find((c) => c.isPluggedIn) ?? evse.connectors[0] ?? { status: evse.status }
  );
}

/** The next stacking order for a card brought to the front (a drag or its popup). */
export function nextCardZ(): number {
  globalDragCounter += 1;
  return globalDragCounter;
}

/** The card frame (its size comes from `STATION_CARD_SIZE`). */
export const STATION_CARD_CLASS =
  'group absolute overflow-hidden rounded-xl border bg-card p-3 text-card-foreground select-none transition-shadow hover:shadow-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/** How long a dropped card eases into a clear place when the drop overlapped another card. */
export const CARD_SETTLE_MS = 150;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function onNextFrame(run: () => void): number | null {
  if (typeof requestAnimationFrame === 'undefined') {
    run();
    return null;
  }
  return requestAnimationFrame(run);
}

/** A drop this close to where the pointer left it lands without easing (rounding only). */
const SETTLE_MIN_PX = 1;

/**
 * The 2D charger card at a corner a board computes. A click, Enter or Space
 * opens the station popup; with `draggable` a pointer drag moves it 1:1 under
 * the pointer (a CSS transform painted once a frame, no re-render per move),
 * the board decides where the drop lands, and other keys go to `onKeyDown`.
 * A drop that lands elsewhere than the pointer left it eases there.
 */
export function PlacedStationCard({
  station,
  left,
  top,
  height = STATION_CARD_SIZE.height,
  draggable,
  zoom,
  currentDrawKw,
  onOpenDetails,
  onDragEnd,
  onDragActive,
  onKeyDown,
}: {
  station: LayoutStation;
  /** The card's top left corner, in board px. */
  left: number;
  top: number;
  /** The card height of its board (`CardLayout.cardHeight`). */
  height?: number;
  draggable: boolean;
  /** The board zoom, read when a drag starts (pointer px to board px). */
  zoom?: (() => number) | undefined;
  currentDrawKw?: number | undefined;
  onOpenDetails: (stationId: string) => void;
  /**
   * A drag moved the card by (dx, dy) board px and ended: the board answers
   * where it lands (null: back where it was).
   */
  onDragEnd?: (dx: number, dy: number) => { x: number; y: number } | null;
  /** A card drag started (true) or ended (false); the board pans nothing meanwhile. */
  onDragActive?: ((active: boolean) => void) | undefined;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [zIndex, setZIndex] = useState(0);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const start = useRef<{ x: number; y: number; moved: boolean; zoom: number } | null>(null);
  const delta = useRef({ x: 0, y: 0 });
  const frame = useRef<number | null>(null);
  const settleFrom = useRef<{ x: number; y: number } | null>(null);
  const justDragged = useRef(false);

  function paintDelta(): void {
    frame.current = null;
    const el = ref.current;
    if (el == null || start.current == null) return;
    el.style.transform = `translate(${String(delta.current.x)}px, ${String(delta.current.y)}px)`;
  }
  // Shows the card at `from` (board px from where it now stands) and eases it home.
  function settle(from: { x: number; y: number }): void {
    const el = ref.current;
    if (el == null) return;
    el.style.transition = 'none';
    if (Math.hypot(from.x, from.y) < SETTLE_MIN_PX || prefersReducedMotion()) {
      el.style.transform = '';
      return;
    }
    el.style.transform = `translate(${String(from.x)}px, ${String(from.y)}px)`;
    onNextFrame(() => {
      el.style.transition = `transform ${String(CARD_SETTLE_MS)}ms ease-out`;
      el.style.transform = '';
    });
  }
  // Ends a drag: pointerup, pointercancel, lost capture, or a move with no button
  // held (a missed pointerup). Stops the frame loop first, so nothing moves after.
  function endDrag(drop: boolean): void {
    const s = start.current;
    start.current = null;
    if (frame.current != null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(frame.current);
    }
    frame.current = null;
    if (s == null) return;
    justDragged.current = s.moved;
    if (!s.moved) return;
    setDragging(false);
    onDragActive?.(false);
    const moved = delta.current;
    const el = ref.current;
    if (el != null) el.style.transform = `translate(${String(moved.x)}px, ${String(moved.y)}px)`;
    if (!drop) {
      settle(moved);
      return;
    }
    const landed = onDragEnd?.(moved.x, moved.y) ?? null;
    const from =
      landed == null ? moved : { x: left + moved.x - landed.x, y: top + moved.y - landed.y };
    if (landed == null || (landed.x === left && landed.y === top)) settle(from);
    else settleFrom.current = from;
  }
  // The board moved the card: keep it where the pointer left it, then ease to the landing place.
  useLayoutEffect(() => {
    const from = settleFrom.current;
    if (from == null) return;
    settleFrom.current = null;
    settle(from);
  }, [left, top]);
  const state = stationDisplayState(station);
  function open(): void {
    setZIndex(nextCardZ());
    onOpenDetails(station.id);
  }
  return (
    <div
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-label={t('sites.layoutView.stateDetailsLabel', {
        id: layoutChargerName(station, t),
        state: t(stationStateLabelKey(state)),
      })}
      data-testid={`site-layout-card-${station.id}`}
      data-state={state}
      ref={ref}
      onTransitionEnd={(e) => {
        e.currentTarget.style.transition = '';
      }}
      className={cn(
        STATION_CARD_CLASS,
        'touch-none',
        state === 'faulted' && 'border-destructive/40',
        draggable ? 'cursor-grab' : 'cursor-pointer',
        dragging && 'cursor-grabbing shadow-lg ring-2 ring-primary',
      )}
      style={{
        left,
        top,
        width: STATION_CARD_SIZE.width,
        height,
        zIndex: dragging ? 1_000_000 : zIndex,
      }}
      onClick={() => {
        if (justDragged.current) {
          justDragged.current = false;
          return;
        }
        open();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
          return;
        }
        onKeyDown?.(e);
      }}
      onPointerDown={(e) => {
        if (!draggable || e.button !== 0) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, y: e.clientY, moved: false, zoom: zoom?.() ?? 1 };
        delta.current = { x: 0, y: 0 };
        justDragged.current = false;
        e.currentTarget.style.transition = 'none';
        setZIndex(nextCardZ());
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (s == null) return;
        if (e.buttons === 0) {
          endDrag(true);
          return;
        }
        const dx = e.clientX - s.x;
        const dy = e.clientY - s.y;
        if (!s.moved && Math.hypot(dx, dy) <= 4) return;
        if (!s.moved) {
          setDragging(true);
          onDragActive?.(true);
        }
        s.moved = true;
        delta.current = { x: dx / s.zoom, y: dy / s.zoom };
        if (frame.current == null) frame.current = onNextFrame(paintDelta);
      }}
      onPointerUp={() => {
        endDrag(true);
      }}
      onPointerCancel={() => {
        endDrag(false);
      }}
      onLostPointerCapture={() => {
        endDrag(true);
      }}
    >
      {/* The accent bar in the station state color. */}
      <span
        aria-hidden="true"
        data-testid="station-card-accent"
        className="absolute inset-y-0 left-0 w-0.75"
        style={{ backgroundColor: stationStateColor(state) }}
      />
      {draggable && (
        <GripVertical
          aria-hidden="true"
          data-testid="station-card-grip"
          className="absolute right-1 top-1 h-3.5 w-3.5 rounded-sm bg-card text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
        />
      )}
      <StationCardContent station={station} currentDrawKw={currentDrawKw} />
    </div>
  );
}
