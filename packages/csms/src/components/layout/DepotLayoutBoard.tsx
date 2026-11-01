// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The 2D view of a depot: the standard 2D charger card of every site type
// (`PlacedStationCard`, owner decision 2026-11-01: one 2D charger card for
// every site type, never chips), arranged in the depot's slots: the bus bays
// in the first row, the truck pull-through lanes in the second, one slot per
// grid position as the parking lot board places its cards. Each slot is
// outlined and named (Bus Bay 1, Truck Lane 1); a card drags (or, focused,
// moves with the arrow keys) to another free slot. The 3D view draws the
// yard to scale (`depotLayout`).

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  assignBays,
  bayToPosition,
  gridBoardExtent,
  LAYOUT_CARD_HEIGHT,
  LAYOUT_CARD_WIDTH,
  layoutRowLengths,
  nearestFreeBay,
  positionToBay,
  DEPOT_ROWS,
  type LayoutBay,
  type LayoutPoint,
  type SiteLayoutSettings,
} from '@evtivity/lib/site-layout';
import { cn } from '@/lib/utils';
import { PlacedStationCard, type LayoutStation } from './StationCard';

/** The bay or lane each station shows in: its own slot, else the nearest one no earlier station holds. */
export function depotStationBays(
  stations: ReadonlyArray<Pick<LayoutStation, 'id' | 'positionX' | 'positionY'>>,
  settings: SiteLayoutSettings,
): Map<string, LayoutBay> {
  const cols = Math.max(
    ...layoutRowLengths(settings),
    ...stations.map((s) => positionToBay({ x: s.positionX, y: s.positionY }).col + 1),
  );
  const assigned = assignBays(
    stations.map((s) => ({ x: s.positionX, y: s.positionY })),
    cols,
  );
  const bays = new Map<string, LayoutBay>();
  stations.forEach((s, i) => {
    const bay = assigned[i];
    if (bay != null) bays.set(s.id, bay);
  });
  return bays;
}

interface DepotLayoutBoardProps {
  stations: readonly LayoutStation[];
  settings: SiteLayoutSettings;
  /** The board element (the popup places itself inside it). */
  boardRef: React.RefObject<HTMLDivElement | null>;
  /** Stations drag to other bays and lanes (sites:write, not while replaying). */
  editable: boolean;
  /** A station moved to another slot: its new grid position. */
  onMove: (stationId: string, x: number, y: number) => void;
  onOpenDetails: (stationId: string) => void;
  /** The live draw and allocated limit of a station (the card shows them). */
  power?: ReadonlyMap<string, { currentDrawKw: number; allocatedLimitKw: number | null }>;
  children?: React.ReactNode;
}

export function DepotLayoutBoard({
  stations,
  settings,
  boardRef,
  editable,
  onMove,
  onOpenDetails,
  power,
  children,
}: DepotLayoutBoardProps): React.JSX.Element {
  const { t } = useTranslation();
  const lengths = layoutRowLengths(settings);
  const bays = depotStationBays(stations, settings);
  const extent = gridBoardExtent(settings);
  const [drag, setDrag] = useState<{ id: string; at: LayoutPoint } | null>(null);

  // The free bay or lane a station lands in (null: none, or its own); `rowOnly`
  // keeps it in the target's row (the bus bays or the truck lanes).
  function dropTarget(id: string, target: LayoutBay | null, rowOnly = false): LayoutBay | null {
    if (target == null) return null;
    const others = [...bays].filter(([other]) => other !== id).map(([, b]) => b);
    const rows = lengths.map((n, row) => (rowOnly && row !== target.row ? 0 : n));
    const free = nearestFreeBay(target, others, rows);
    const own = bays.get(id);
    if (free == null || (own != null && own.col === free.col && own.row === free.row)) return null;
    return free;
  }

  function commit(id: string, target: LayoutBay | null, rowOnly = false): void {
    const free = dropTarget(id, target, rowOnly);
    if (free == null) return;
    const p = bayToPosition(free);
    onMove(id, p.x, p.y);
  }

  function onKeyDown(e: React.KeyboardEvent, id: string): void {
    if (!editable) return;
    const own = bays.get(id);
    if (own == null) return;
    const step: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const delta = step[e.key];
    if (delta == null) return;
    e.preventDefault();
    // Left and right: the next free slot of the row; up and down: the bus bays or the truck lanes.
    commit(
      id,
      {
        col: Math.max(0, own.col + delta[0]),
        row: Math.min(DEPOT_ROWS.truck, Math.max(DEPOT_ROWS.bus, own.row + delta[1])),
      },
      true,
    );
  }

  const hovered = drag != null ? dropTarget(drag.id, positionToBay(drag.at)) : null;
  const slots = lengths.flatMap((n, row) => Array.from({ length: n }, (_, col) => ({ col, row })));

  return (
    <div
      ref={boardRef}
      data-testid="site-layout-2d"
      className="relative h-[700px] w-full overflow-auto rounded-lg border-2 border-dashed"
    >
      <div
        className="relative"
        data-testid="site-layout-2d-depot"
        style={{ width: extent.width + 20, height: extent.height + 20 }}
      >
        {slots.map((slot) => {
          const p = bayToPosition(slot);
          const bus = slot.row === DEPOT_ROWS.bus;
          const target = hovered?.col === slot.col && hovered.row === slot.row;
          return (
            <div
              key={`${String(slot.row)}-${String(slot.col)}`}
              aria-hidden="true"
              data-testid={
                bus
                  ? `site-layout-2d-bus-bay-${String(slot.col)}`
                  : `site-layout-2d-truck-lane-${String(slot.col)}`
              }
              className={cn(
                'pointer-events-none absolute flex items-end rounded-lg border border-primary/60 bg-muted/40 p-1.5 text-xs text-muted-foreground',
                target && 'border-2 border-primary bg-primary/20',
              )}
              style={{ left: p.x, top: p.y, width: LAYOUT_CARD_WIDTH, height: LAYOUT_CARD_HEIGHT }}
            >
              {`${t(bus ? 'sites.layoutView.busBay' : 'sites.layoutView.truckLane')} ${String(slot.col + 1)}`}
            </div>
          );
        })}
        {stations.map((station) => {
          const bay = bays.get(station.id);
          if (bay == null) return null;
          const home = bayToPosition(bay);
          const at = drag?.id === station.id ? drag.at : home;
          const p = power?.get(station.id);
          return (
            <PlacedStationCard
              key={station.id}
              station={station}
              left={at.x}
              top={at.y}
              draggable={editable}
              dragging={drag?.id === station.id}
              currentDrawKw={p?.currentDrawKw}
              allocatedLimitKw={p?.allocatedLimitKw}
              onOpenDetails={onOpenDetails}
              onKeyDown={(e) => {
                onKeyDown(e, station.id);
              }}
              onDragMove={(dx, dy) => {
                setDrag({ id: station.id, at: { x: home.x + dx, y: home.y + dy } });
              }}
              onDragEnd={(moved) => {
                const last = drag;
                setDrag(null);
                if (moved && last != null && last.id === station.id) {
                  commit(station.id, positionToBay(last.at));
                }
              }}
            />
          );
        })}
        {children}
      </div>
    </div>
  );
}
