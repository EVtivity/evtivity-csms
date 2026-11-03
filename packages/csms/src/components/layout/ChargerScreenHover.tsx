// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The magnified charger screen beside the pointer while it hovers a screen
// in the 3D site layout: follows the pointer over the stage, shows nothing
// while no screen is hovered or the station has no screen text.

import { useEffect, useRef, useState } from 'react';
import { ScreenMessageZoom } from './ScreenMessageZoom';
import type { ScreenKind, ScreenMessage } from './site-layout-screen-text';

export interface ChargerScreenHoverProps {
  /** The stage the overlay is placed in (it listens to the pointer there). */
  stageRef: React.RefObject<HTMLElement | null>;
  /** The hovered screen (`parseScreenHoverKey`), or null. */
  target: { kind: ScreenKind; stationId: string } | null;
  /** The stations of the layout: their OCPP id and screen text. */
  stations: ReadonlyArray<{
    id: string;
    stationId: string;
    screenMessage?: ScreenMessage | null | undefined;
  }>;
  /** The width of the stage the overlay may use (left of an open side panel). */
  areaWidth?: ((stage: HTMLElement) => number) | undefined;
}

export function ChargerScreenHover({
  stageRef,
  target,
  stations,
  areaWidth,
}: ChargerScreenHoverProps): React.JSX.Element | null {
  const last = useRef<{ x: number; y: number } | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const active = target != null;

  useEffect(() => {
    const stage = stageRef.current;
    if (stage == null) return;
    function onMove(e: PointerEvent): void {
      const el = stageRef.current;
      if (el == null) return;
      const rect = el.getBoundingClientRect();
      last.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (active) setAnchor(last.current);
    }
    stage.addEventListener('pointermove', onMove);
    return () => {
      stage.removeEventListener('pointermove', onMove);
    };
  }, [stageRef, active]);

  useEffect(() => {
    setAnchor(active ? last.current : null);
  }, [active, target?.stationId, target?.kind]);

  const stage = stageRef.current;
  if (target == null || anchor == null || stage == null) return null;
  const station = stations.find((s) => s.id === target.stationId);
  const message = station?.screenMessage;
  if (station == null || message == null || message.text === '') return null;
  return (
    <ScreenMessageZoom
      stationName={station.stationId}
      text={message.text}
      kind={target.kind}
      anchor={anchor}
      bounds={{
        left: 0,
        top: 0,
        width: areaWidth?.(stage) ?? stage.clientWidth,
        height: stage.clientHeight,
      }}
      source={message.source}
    />
  );
}
