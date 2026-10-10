// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  TOAST_ACTION_DURATION_MS,
  TOAST_DURATIONS_MS,
  toastDurationMs,
  type ToastVariantName,
} from '../toast-durations.js';

const VARIANTS: ToastVariantName[] = ['default', 'success', 'info', 'warning', 'destructive'];

describe('toastDurationMs', () => {
  it('gives success and info 4 to 5 seconds', () => {
    for (const variant of ['default', 'success', 'info'] as const) {
      expect(toastDurationMs(variant, false)).toBeGreaterThanOrEqual(4_000);
      expect(toastDurationMs(variant, false)).toBeLessThanOrEqual(5_000);
    }
  });

  it('gives warnings 6 to 8 seconds', () => {
    expect(toastDurationMs('warning', false)).toBeGreaterThanOrEqual(6_000);
    expect(toastDurationMs('warning', false)).toBeLessThanOrEqual(8_000);
  });

  it('gives errors 8 to 10 seconds', () => {
    expect(toastDurationMs('destructive', false)).toBeGreaterThanOrEqual(8_000);
    expect(toastDurationMs('destructive', false)).toBeLessThanOrEqual(10_000);
  });

  it('keeps a toast with an action longer, but still finite', () => {
    for (const variant of VARIANTS) {
      const withAction = toastDurationMs(variant, true);
      expect(withAction).toBeGreaterThanOrEqual(toastDurationMs(variant, false));
      expect(withAction).toBe(Math.max(TOAST_DURATIONS_MS[variant], TOAST_ACTION_DURATION_MS));
      expect(Number.isFinite(withAction)).toBe(true);
    }
  });

  it('never returns an infinite or zero duration', () => {
    for (const variant of VARIANTS) {
      for (const hasAction of [false, true]) {
        const ms = toastDurationMs(variant, hasAction);
        expect(Number.isFinite(ms)).toBe(true);
        expect(ms).toBeGreaterThan(0);
      }
    }
  });
});
