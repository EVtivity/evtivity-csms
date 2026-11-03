// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useLayoutWheelNav } from '../use-layout-wheel-nav';
import type { CameraNudge } from '../site-layout-keyboard-nav';
import type { KeyboardNavScene } from '../use-layout-keyboard-nav';

let stage: HTMLDivElement;
let canvas: HTMLCanvasElement;
let scene: KeyboardNavScene & { nudges: CameraNudge[] };

function wheel(target: Element, init: WheelEventInit): WheelEvent {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  stage = document.createElement('div');
  Object.defineProperty(stage, 'clientHeight', { value: 600 });
  canvas = document.createElement('canvas');
  stage.append(canvas);
  document.body.append(stage);
  scene = {
    nudges: [],
    viewDistance: () => 40,
    fit: vi.fn(),
    nudgeCamera(n) {
      scene.nudges.push(n);
    },
  };
  renderHook(() => {
    useLayoutWheelNav({ current: stage }, { current: scene });
  });
});

afterEach(() => {
  stage.remove();
});

describe('useLayoutWheelNav', () => {
  it('takes the wheel before the orbit controls on the canvas see it', () => {
    const orbitWheel = vi.fn();
    canvas.addEventListener('wheel', orbitWheel);
    const e = wheel(canvas, { deltaY: -100 });
    expect(e.defaultPrevented).toBe(true);
    expect(orbitWheel).not.toHaveBeenCalled();
    expect(scene.nudges[0]?.zoom).toBeGreaterThan(0);
  });

  it('pans for a two-finger swipe and zooms for a pinch', () => {
    wheel(canvas, { deltaX: 10, deltaY: 6.5 });
    wheel(canvas, { deltaY: -4, ctrlKey: true });
    const [swipe, pinch] = scene.nudges;
    expect(swipe?.right).toBeGreaterThan(0);
    expect(swipe?.forward).toBeLessThan(0);
    expect(swipe?.zoom).toBe(0);
    expect(pinch?.zoom).toBeGreaterThan(0);
    expect(pinch?.forward).toBe(0);
  });

  it('leaves the wheel to a scrollable panel on the stage', () => {
    const panel = document.createElement('div');
    panel.style.overflowY = 'auto';
    Object.defineProperty(panel, 'scrollHeight', { value: 500 });
    Object.defineProperty(panel, 'clientHeight', { value: 200 });
    const item = document.createElement('button');
    panel.append(item);
    stage.append(panel);
    const e = wheel(item, { deltaY: 100 });
    expect(e.defaultPrevented).toBe(false);
    expect(scene.nudges).toHaveLength(0);
  });

  it('zooms for a Safari trackpad pinch', () => {
    const start = Object.assign(new Event('gesturestart', { cancelable: true }), { scale: 1 });
    const change = Object.assign(new Event('gesturechange', { cancelable: true }), { scale: 1.5 });
    stage.dispatchEvent(start);
    stage.dispatchEvent(change);
    expect(change.defaultPrevented).toBe(true);
    expect(scene.nudges[0]?.zoom).toBeCloseTo(Math.log(1.5));
  });
});
