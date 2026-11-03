// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The 2D view of every site type (owner decisions 2026-11-02 and 2026-11-03):
// only the standard charger cards on an unlimited pan and zoom board, never
// ground drawings. A card stands at its board position (a pending move or the
// saved one), else at its computed default slot (`site-layout-2d-placement.ts`),
// moved to the nearest free place (`site-layout-2d-board.ts`). Drag the empty
// board to pan; zoom with the wheel, a pinch or the buttons; Fit frames every
// card. With edit rights a card drags anywhere and, focused, moves with the
// arrow keys; it lands exactly where it is dropped, and a drop onto another
// card moves the shortest distance until it just clears, so no two overlap. Moving a card never moves its 3D spot.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Maximize, Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PlacedStationCard, type LayoutStation } from './StationCard';
import type { CardLayout } from './site-layout-2d-placement';
import {
  BOARD_OPEN_MIN_ZOOM,
  BOARD_KEY_STEP,
  boardPositions,
  fitBoardView,
  slideToFree,
  zoomViewAt,
  type BoardPoint,
  type BoardView,
} from './site-layout-2d-board';
import {
  MOUSE_ZOOM_PER_PX,
  PINCH_ZOOM_PER_PX,
  wheelSource,
  type WheelSource,
} from './site-layout-pointer-nav';
import { navKeyOf } from './site-layout-keyboard-nav';

/** The layer transform of a board view. */
function layerTransform(v: BoardView): string {
  return `translate(${String(v.panX)}px, ${String(v.panY)}px) scale(${String(v.zoom)})`;
}

/** Runs `run` on the next animation frame (right away where the browser has none). */
export function nextFrame(run: () => void): number | null {
  if (typeof requestAnimationFrame === 'undefined') {
    run();
    return null;
  }
  return requestAnimationFrame(run);
}

/** Board px a key press pans by (Shift: 3 times). */
const KEY_PAN_PX = 60;
/** The zoom step of a button or key. */
const ZOOM_STEP = 1.2;

const ARROWS: Record<string, BoardPoint> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

export function StationCardBoard({
  stations,
  layoutFor,
  positions,
  editable,
  power,
  boardRef,
  onOpenDetails,
  onMove,
  children,
}: {
  stations: readonly LayoutStation[];
  /** The computed default slots for a board of this width in card px (a depot wraps to it). */
  layoutFor: (boardWidth: number) => CardLayout;
  /** Each station's board position: a pending move, else the saved one, else null. */
  positions: ReadonlyMap<string, BoardPoint | null>;
  /** Cards drag and move with the arrow keys (sites:write, not while replaying). */
  editable: boolean;
  /** The live draw of a station (the card shows it). */
  power?: ReadonlyMap<string, { currentDrawKw: number; allocatedLimitKw: number | null }>;
  /** The board element (the popup places itself inside it). */
  boardRef: React.RefObject<HTMLDivElement | null>;
  onOpenDetails: (stationId: string) => void;
  /** A card moved to a free place on the board (board px). */
  onMove: (stationId: string, point: BoardPoint) => void;
  /** The station popup, placed in board element px. */
  children?: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [size, setSize] = useState({ width: 1024, height: 700 });
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (board == null) return;
    const read = (): void => {
      setSize({ width: board.clientWidth, height: board.clientHeight });
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(board);
    return () => {
      observer.disconnect();
    };
  }, [boardRef]);

  const defaults = useMemo(() => layoutFor(size.width), [layoutFor, size.width]);
  const placed = useMemo(
    () =>
      boardPositions(
        stations.flatMap((s) => {
          const slot = defaults.cards.get(s.id);
          return slot == null && positions.get(s.id) == null
            ? []
            : [{ id: s.id, fixed: positions.get(s.id) ?? null, slot: slot ?? { x: 0, y: 0 } }];
        }),
      ),
    [stations, defaults, positions],
  );

  const [view, setViewState] = useState<BoardView | null>(null);
  const shown =
    view ?? fitBoardView(placed.values(), size.width, size.height, 24, BOARD_OPEN_MIN_ZOOM);
  // A pan or zoom gesture paints the live view onto the layer once a frame and
  // commits it to state when it ends, so the cards never re-render per event.
  const liveView = useRef<BoardView | null>(null);
  const shownRef = useRef(shown);
  useLayoutEffect(() => {
    shownRef.current = shown;
  });
  const layerRef = useRef<HTMLDivElement | null>(null);
  const paintFrame = useRef<number | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = (): BoardView => liveView.current ?? shownRef.current;
  function setView(v: BoardView): void {
    liveView.current = v;
    setViewState(v);
  }
  function paintView(v: BoardView): void {
    liveView.current = v;
    if (paintFrame.current != null) return;
    paintFrame.current = nextFrame(() => {
      paintFrame.current = null;
      const layer = layerRef.current;
      const live = liveView.current;
      if (layer == null || live == null) return;
      layer.style.transform = layerTransform(live);
      layer.dataset['zoom'] = String(live.zoom);
    });
  }
  function commitView(delayMs = 0): void {
    if (commitTimer.current != null) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      commitTimer.current = null;
      if (liveView.current != null) setViewState(liveView.current);
    }, delayMs);
  }
  useEffect(
    () => () => {
      if (commitTimer.current != null) clearTimeout(commitTimer.current);
    },
    [],
  );
  // The board opens framing every card; later changes keep the view.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || placed.size === 0 || size.width <= 0) return;
    fitted.current = true;
    setView(fitBoardView(placed.values(), size.width, size.height, 24, BOARD_OPEN_MIN_ZOOM));
  }, [placed, size]);

  function fit(): void {
    setView(fitBoardView(placed.values(), size.width, size.height));
  }
  function zoomBy(factor: number, at?: BoardPoint): void {
    setView(zoomViewAt(current(), factor, at ?? { x: size.width / 2, y: size.height / 2 }));
  }
  function panBy(dx: number, dy: number): void {
    const v = current();
    setView({ ...v, panX: v.panX + dx, panY: v.panY + dy });
  }

  // The wheel: a mouse wheel or a pinch zooms at the pointer, a trackpad swipe pans.
  const lastWheel = useRef<{ source: WheelSource; timeStamp: number } | null>(null);
  useEffect(() => {
    const board = boardRef.current;
    if (board == null) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      // No pan or zoom under a card drag (a trackpad keeps sending momentum).
      if (cardDragging.current) return;
      const source = wheelSource(e, lastWheel.current);
      lastWheel.current = { source, timeStamp: e.timeStamp };
      const r = board.getBoundingClientRect();
      const at = { x: e.clientX - r.left, y: e.clientY - r.top };
      const v = current();
      if (source === 'trackpad') {
        paintView({ ...v, panX: v.panX - e.deltaX, panY: v.panY - e.deltaY });
      } else {
        const per = source === 'pinch' ? PINCH_ZOOM_PER_PX : MOUSE_ZOOM_PER_PX;
        paintView(zoomViewAt(v, Math.exp(-e.deltaY * per), at));
      }
      commitView(150);
    };
    board.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      board.removeEventListener('wheel', onWheel);
    };
    // The handler reads the view through refs, so it is added once.
  }, [boardRef]);

  // A card drag in progress: the board neither pans nor zooms meanwhile.
  const cardDragging = useRef(false);
  // Dragging the empty board pans it.
  const pan = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const others = (id: string): BoardPoint[] =>
    [...placed].filter(([other]) => other !== id).map(([, p]) => p);
  const dropAt = (id: string, dx: number, dy: number): BoardPoint | null => {
    const own = placed.get(id);
    return own == null
      ? null
      : slideToFree({ x: Math.round(own.x + dx), y: Math.round(own.y + dy) }, others(id));
  };

  function onBoardKeyDown(e: React.KeyboardEvent): void {
    const key = navKeyOf(e);
    if (key == null) return;
    const step = KEY_PAN_PX * (e.shiftKey ? 3 : 1);
    if (key === 'forward') panBy(0, step);
    else if (key === 'back') panBy(0, -step);
    else if (key === 'left') panBy(step, 0);
    else if (key === 'right') panBy(-step, 0);
    else if (key === 'zoomIn') zoomBy(ZOOM_STEP);
    else if (key === 'zoomOut') zoomBy(1 / ZOOM_STEP);
    else if (key === 'fit') fit();
    else return;
    e.preventDefault();
  }

  function onCardKeyDown(e: React.KeyboardEvent, id: string): void {
    const arrow = ARROWS[e.key];
    if (!editable || arrow == null) return;
    e.preventDefault();
    e.stopPropagation();
    const own = placed.get(id);
    if (own == null) return;
    const step = BOARD_KEY_STEP * (e.shiftKey ? 4 : 1);
    // Move one step that way, then on past any card in the way.
    let next = slideToFree({ x: own.x + arrow.x * step, y: own.y + arrow.y * step }, others(id));
    for (let n = 2; n < 400 && (next.x - own.x) * arrow.x + (next.y - own.y) * arrow.y <= 0; n++) {
      next = slideToFree(
        { x: own.x + arrow.x * step * n, y: own.y + arrow.y * step * n },
        others(id),
      );
    }
    onMove(id, next);
  }

  // The cards render only when a card or its data changes, never on a pan or
  // zoom commit: their handlers read the board through this ref.
  const setCardDragging = (active: boolean): void => {
    cardDragging.current = active;
    if (active) pan.current = null;
  };
  const handlers = useRef({ current, dropAt, onCardKeyDown, onMove, setCardDragging });
  useLayoutEffect(() => {
    handlers.current = { current, dropAt, onCardKeyDown, onMove, setCardDragging };
  });
  const cardElements = useMemo(
    () =>
      stations.map((station) => {
        const at = placed.get(station.id);
        if (at == null) return null;
        return (
          <PlacedStationCard
            key={station.id}
            station={station}
            left={at.x}
            top={at.y}
            draggable={editable}
            zoom={() => handlers.current.current().zoom}
            currentDrawKw={power?.get(station.id)?.currentDrawKw}
            onOpenDetails={onOpenDetails}
            onKeyDown={(e) => {
              handlers.current.onCardKeyDown(e, station.id);
            }}
            onDragActive={(active) => {
              handlers.current.setCardDragging(active);
            }}
            onDragEnd={(dx, dy) => {
              const p = handlers.current.dropAt(station.id, dx, dy);
              if (p == null) return null;
              if (p.x !== at.x || p.y !== at.y) handlers.current.onMove(station.id, p);
              return p;
            }}
          />
        );
      }),
    [stations, placed, editable, power, onOpenDetails],
  );

  return (
    <div
      ref={boardRef}
      data-testid="site-layout-2d"
      role="application"
      tabIndex={0}
      aria-label={t('sites.layoutView.board2d.label')}
      className="relative h-[700px] w-full touch-none overflow-hidden rounded-lg border focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      onKeyDown={onBoardKeyDown}
      onPointerDown={(e) => {
        if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset['boardLayer'])
          return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const v = current();
        pan.current = { x: e.clientX, y: e.clientY, panX: v.panX, panY: v.panY };
      }}
      onPointerMove={(e) => {
        const p = pan.current;
        if (p == null) return;
        if (e.buttons === 0 || cardDragging.current) {
          pan.current = null;
          commitView();
          return;
        }
        paintView({ ...current(), panX: p.panX + e.clientX - p.x, panY: p.panY + e.clientY - p.y });
      }}
      onPointerUp={() => {
        if (pan.current == null) return;
        pan.current = null;
        commitView();
      }}
      onPointerCancel={() => {
        if (pan.current == null) return;
        pan.current = null;
        commitView();
      }}
      onLostPointerCapture={() => {
        if (pan.current == null) return;
        pan.current = null;
        commitView();
      }}
    >
      <div
        data-board-layer="true"
        data-testid="site-layout-2d-cards"
        ref={layerRef}
        data-zoom={(liveView.current ?? shown).zoom}
        className="absolute left-0 top-0 origin-top-left will-change-transform"
        style={{ transform: layerTransform(liveView.current ?? shown) }}
      >
        {cardElements}
      </div>
      <div className="absolute right-2 top-2 flex gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={t('sites.layoutView.board2d.zoomIn')}
          title={t('sites.layoutView.board2d.zoomIn')}
          data-testid="site-layout-2d-zoom-in"
          onClick={() => {
            zoomBy(ZOOM_STEP);
          }}
        >
          <Plus aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={t('sites.layoutView.board2d.zoomOut')}
          title={t('sites.layoutView.board2d.zoomOut')}
          data-testid="site-layout-2d-zoom-out"
          onClick={() => {
            zoomBy(1 / ZOOM_STEP);
          }}
        >
          <Minus aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={t('sites.layoutView.fitToView')}
          title={t('sites.layoutView.fitToView')}
          data-testid="site-layout-2d-fit"
          onClick={fit}
        >
          <Maximize aria-hidden="true" />
        </Button>
      </div>
      {children}
    </div>
  );
}
