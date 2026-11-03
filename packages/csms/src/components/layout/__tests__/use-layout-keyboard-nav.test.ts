// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  useLayoutKeyboardNav,
  type KeyboardNavScene,
  type LayoutKeyboardNavOptions,
} from '../use-layout-keyboard-nav';
import { STEP_SECONDS, YAW_SPEED, type CameraNudge } from '../site-layout-keyboard-nav';

let frames: FrameRequestCallback[] = [];
let stage: HTMLDivElement;
let scene: KeyboardNavScene & { nudges: CameraNudge[]; fits: number };

function runFrame(time: number): void {
  const queued = frames;
  frames = [];
  for (const cb of queued) cb(time);
}

function setup(options: Partial<LayoutKeyboardNavOptions> = {}) {
  return renderHook(
    (opts: LayoutKeyboardNavOptions) => {
      useLayoutKeyboardNav({ current: stage }, { current: scene }, opts);
    },
    { initialProps: { reducedMotion: false, ...options } },
  );
}

function key(
  type: 'keydown' | 'keyup',
  init: KeyboardEventInit,
  target: HTMLElement = stage,
): KeyboardEvent {
  const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  frames = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
    frames = [];
  });
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  stage = document.createElement('div');
  stage.tabIndex = 0;
  document.body.append(stage);
  scene = {
    nudges: [],
    fits: 0,
    viewDistance: () => 20,
    fit() {
      scene.fits += 1;
    },
    nudgeCamera(n) {
      scene.nudges.push(n);
    },
  };
});

afterEach(() => {
  stage.remove();
  vi.restoreAllMocks();
});

describe('useLayoutKeyboardNav', () => {
  it('moves every frame while a key is held and stops on release', () => {
    setup();
    const down = key('keydown', { key: 'w', code: 'KeyW' });
    expect(down.defaultPrevented).toBe(true);
    runFrame(1016);
    runFrame(1032);
    expect(scene.nudges).toHaveLength(2);
    expect(scene.nudges[0]?.forward).toBeGreaterThan(0);
    // Key repeat does not add jumps: still one move per frame.
    key('keydown', { key: 'w', code: 'KeyW', repeat: true });
    runFrame(1048);
    expect(scene.nudges).toHaveLength(3);
    key('keyup', { key: 'w', code: 'KeyW' });
    runFrame(1064);
    expect(scene.nudges).toHaveLength(3);
    expect(frames).toHaveLength(0);
  });

  it('goes three times as fast with Shift held', () => {
    setup();
    key('keydown', { key: 'q', code: 'KeyQ' });
    runFrame(1050);
    key('keydown', { key: 'Shift', code: 'ShiftLeft', shiftKey: true });
    runFrame(1100);
    const [slow, fast] = scene.nudges;
    expect(slow?.yaw).toBeCloseTo(YAW_SPEED * 0.05);
    expect(fast?.yaw).toBeCloseTo(YAW_SPEED * 0.05 * 3);
  });

  it('releases every key when the stage loses focus', () => {
    setup();
    key('keydown', { key: 'ArrowLeft' });
    stage.dispatchEvent(new FocusEvent('focusout'));
    runFrame(1016);
    expect(scene.nudges).toHaveLength(0);
  });

  it('takes one step per press with reduced motion', () => {
    setup({ reducedMotion: true });
    key('keydown', { key: 'e', code: 'KeyE' });
    key('keydown', { key: 'e', code: 'KeyE', repeat: true });
    expect(frames).toHaveLength(0);
    expect(scene.nudges).toHaveLength(2);
    expect(scene.nudges[0]?.yaw).toBeCloseTo(-YAW_SPEED * STEP_SECONDS);
  });

  it('fits the view on Home once per press', () => {
    setup();
    key('keydown', { key: 'Home' });
    key('keydown', { key: 'Home', repeat: true });
    expect(scene.fits).toBe(1);
  });

  it('ignores keys from other elements, reserved keys and browser shortcuts', () => {
    const chip = document.createElement('button');
    const input = document.createElement('input');
    stage.append(chip, input);
    setup({
      reducedMotion: true,
      acceptsTarget: (t) => t === stage || t === chip,
      isReserved: (e) => e.key === 'ArrowUp',
    });
    const fromInput = key('keydown', { key: 'w', code: 'KeyW' }, input);
    expect(fromInput.defaultPrevented).toBe(false);
    const reserved = key('keydown', { key: 'ArrowUp' }, chip);
    expect(reserved.defaultPrevented).toBe(false);
    key('keydown', { key: 'w', code: 'KeyW', ctrlKey: true });
    key('keydown', { key: 'x', code: 'KeyX' });
    expect(scene.nudges).toHaveLength(0);
    key('keydown', { key: 'w', code: 'KeyW' }, chip);
    expect(scene.nudges).toHaveLength(1);
  });

  it('stops listening on unmount', () => {
    const { unmount } = setup({ reducedMotion: true });
    unmount();
    key('keydown', { key: 'w', code: 'KeyW' });
    expect(scene.nudges).toHaveLength(0);
  });
});
