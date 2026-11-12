// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { evseDisplayStatus } from '../evse-status.js';

describe('evseDisplayStatus', () => {
  it('is the connector status of a 1-connector EVSE', () => {
    for (const s of ['available', 'charging', 'faulted', 'unavailable', 'reserved', 'finishing']) {
      expect(evseDisplayStatus([s])).toBe(s);
    }
  });

  it('shows a connector in use over an available one on a 2-connector EVSE', () => {
    expect(evseDisplayStatus(['available', 'charging'])).toBe('charging');
    expect(evseDisplayStatus(['occupied', 'available'])).toBe('occupied');
    expect(evseDisplayStatus(['suspended_ev', 'faulted'])).toBe('suspended_ev');
  });

  it('shows faulted or unavailable only when no connector can serve', () => {
    expect(evseDisplayStatus(['available', 'faulted'])).toBe('available');
    expect(evseDisplayStatus(['faulted', 'unavailable'])).toBe('faulted');
    expect(evseDisplayStatus(['unavailable', 'unavailable'])).toBe('unavailable');
    expect(evseDisplayStatus([])).toBe('unavailable');
  });

  it('shows a reservation over available', () => {
    expect(evseDisplayStatus(['available', 'reserved'])).toBe('reserved');
  });
});
