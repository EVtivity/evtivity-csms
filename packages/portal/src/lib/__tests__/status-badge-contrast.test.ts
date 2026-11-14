// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import tailwindTheme from 'tailwindcss/theme.css?raw';
import { tailwindClassContrast } from '@evtivity/lib/testing/tailwind-contrast';
import { connectorStatusClassName } from '../connector-status';

// Status badges are UI components: their label meets 3:1 on the badge fill
// (WCAG 2.2 SC 1.4.11, owner decision 2026-11-13).
describe('connector status badge contrast', () => {
  it('gives every connector status badge 3:1 or more', () => {
    for (const status of [
      'available',
      'finishing',
      'occupied',
      'charging',
      'discharging',
      'preparing',
      'ev_connected',
      'reserved',
      'suspended_ev',
      'suspended_evse',
      'idle',
      'faulted',
      'unavailable',
    ]) {
      const ratio = tailwindClassContrast(tailwindTheme, connectorStatusClassName(status));
      expect(ratio, status).toBeGreaterThanOrEqual(3);
    }
  });
});
