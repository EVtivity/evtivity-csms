// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Keyboard navigation of the 3D layout stage, "game style": keys act only
// while the stage (or a station marker in it) has the keyboard focus. Held
// keys move the camera every frame; with reduced motion each press is a step.

import { useEffect, useRef, type RefObject } from 'react';
import {
  isZeroNudge,
  navDelta,
  navKeyOf,
  navStep,
  type CameraNudge,
  type NavAction,
} from './site-layout-keyboard-nav';

/** What the hook needs from the scene. */
export interface KeyboardNavScene {
  viewDistance: () => number;
  fit: (toggle?: boolean) => void;
  nudgeCamera?: (n: CameraNudge) => void;
}

export interface LayoutKeyboardNavOptions {
  reducedMotion: boolean;
  /** Whether a key event from this element navigates (default: the stage itself). */
  acceptsTarget?: (target: EventTarget | null) => boolean;
  /** A key another handler owns right now (Edit Layout arrows and R): left alone. */
  isReserved?: (e: KeyboardEvent) => boolean;
}

export function useLayoutKeyboardNav(
  stageRef: RefObject<HTMLElement | null>,
  sceneRef: RefObject<KeyboardNavScene | null>,
  options: LayoutKeyboardNavOptions,
): void {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    const stage = stageRef.current;
    if (stage == null) return;
    const held = new Set<NavAction>();
    let fast = false;
    let frame = 0;
    let last = 0;

    function distance(): number {
      return sceneRef.current?.viewDistance() ?? 0;
    }

    function tick(now: number): void {
      frame = 0;
      if (held.size === 0) return;
      const delta = navDelta(held, (now - last) / 1000, { distance: distance(), fast });
      last = now;
      if (!isZeroNudge(delta)) sceneRef.current?.nudgeCamera?.(delta);
      frame = window.requestAnimationFrame(tick);
    }

    function release(): void {
      held.clear();
      fast = false;
      if (frame !== 0) window.cancelAnimationFrame(frame);
      frame = 0;
    }

    function onKeyDown(e: KeyboardEvent): void {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const opts = optionsRef.current;
      const accepts = opts.acceptsTarget ?? ((t: EventTarget | null) => t === stage);
      if (!accepts(e.target)) return;
      if (e.key === 'Shift') {
        fast = true;
        return;
      }
      const key = navKeyOf(e);
      if (key == null || opts.isReserved?.(e) === true) return;
      e.preventDefault();
      fast = e.shiftKey;
      if (key === 'fit') {
        if (!e.repeat) sceneRef.current?.fit(true);
        return;
      }
      if (opts.reducedMotion) {
        sceneRef.current?.nudgeCamera?.(navStep(key, { distance: distance(), fast }));
        return;
      }
      held.add(key);
      if (frame === 0) {
        last = performance.now();
        frame = window.requestAnimationFrame(tick);
      }
    }

    function onKeyUp(e: KeyboardEvent): void {
      if (e.key === 'Shift') {
        fast = false;
        return;
      }
      const key = navKeyOf(e);
      if (key != null && key !== 'fit') held.delete(key);
    }

    function onVisibility(): void {
      if (document.visibilityState === 'hidden') release();
    }

    stage.addEventListener('keydown', onKeyDown);
    stage.addEventListener('keyup', onKeyUp);
    stage.addEventListener('focusout', release);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      release();
      stage.removeEventListener('keydown', onKeyDown);
      stage.removeEventListener('keyup', onKeyUp);
      stage.removeEventListener('focusout', release);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [stageRef, sceneRef]);
}
