// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Map-style wheel input on the 3D layout stage. The listener runs in the
// capture phase and stops the event, so the orbit controls on the canvas
// never zoom as well; a scrollable panel on the stage (the station list, a
// popup) keeps its own scrolling.

import { useEffect, useRef, type RefObject } from 'react';
import { isZeroNudge } from './site-layout-keyboard-nav';
import { gestureZoom, wheelNudge, wheelSource, type WheelSource } from './site-layout-pointer-nav';
import type { KeyboardNavScene } from './use-layout-keyboard-nav';

/** Whether an element between the target and the stage can scroll the way the wheel goes. */
export function insideScrollable(target: EventTarget | null, stage: HTMLElement): boolean {
  let el = target instanceof Element ? target : null;
  while (el != null && el !== stage) {
    if (el instanceof HTMLElement) {
      const { overflowY, overflowX } = window.getComputedStyle(el);
      const scrollsY = /auto|scroll/.test(overflowY) && el.scrollHeight > el.clientHeight;
      const scrollsX = /auto|scroll/.test(overflowX) && el.scrollWidth > el.clientWidth;
      if (scrollsY || scrollsX) return true;
    }
    el = el.parentElement;
  }
  return false;
}

interface GestureLike extends Event {
  scale?: number;
}

export function useLayoutWheelNav(
  stageRef: RefObject<HTMLElement | null>,
  sceneRef: RefObject<KeyboardNavScene | null>,
): void {
  const lastRef = useRef<{ source: WheelSource; timeStamp: number } | null>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (stage == null) return;
    let gestureScale = 1;

    function onWheel(e: WheelEvent): void {
      if (insideScrollable(e.target, stage as HTMLElement)) return;
      e.preventDefault();
      e.stopPropagation();
      const scene = sceneRef.current;
      if (scene == null) return;
      const source = wheelSource(
        {
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaMode: e.deltaMode,
          ctrlKey: e.ctrlKey,
          timeStamp: e.timeStamp,
          wheelDeltaY: (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY,
        },
        lastRef.current,
      );
      lastRef.current = { source, timeStamp: e.timeStamp };
      const nudge = wheelNudge(e, source, {
        distance: scene.viewDistance(),
        stageHeightPx: (stage as HTMLElement).clientHeight,
      });
      if (!isZeroNudge(nudge)) scene.nudgeCamera?.(nudge);
    }

    // Safari sends a trackpad pinch as gesture events, not a ctrl wheel.
    function onGestureStart(e: GestureLike): void {
      e.preventDefault();
      gestureScale = e.scale ?? 1;
    }
    function onGestureChange(e: GestureLike): void {
      e.preventDefault();
      const scale = e.scale ?? 1;
      const zoom = gestureZoom(gestureScale, scale);
      gestureScale = scale;
      if (zoom !== 0)
        sceneRef.current?.nudgeCamera?.({ forward: 0, right: 0, yaw: 0, pitch: 0, zoom });
    }

    stage.addEventListener('wheel', onWheel, { capture: true, passive: false });
    stage.addEventListener('gesturestart', onGestureStart, { capture: true, passive: false });
    stage.addEventListener('gesturechange', onGestureChange, { capture: true, passive: false });
    return () => {
      stage.removeEventListener('wheel', onWheel, { capture: true });
      stage.removeEventListener('gesturestart', onGestureStart, { capture: true });
      stage.removeEventListener('gesturechange', onGestureChange, { capture: true });
    };
  }, [stageRef, sceneRef]);
}
