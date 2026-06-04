// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { STATION_MESSAGE_DEFAULTS } from '../station-message-defaults.js';
import type { StationMessageState } from '../station-message.js';

const EXPECTED_STATES: StationMessageState[] = [
  'available',
  'occupied',
  'reserved',
  'charging',
  'suspended',
  'discharging',
  'faulted',
  'unavailable',
  'payment_failed',
  'payment_required',
  'guest_unauthorized',
  'unauthorized',
];

describe('STATION_MESSAGE_DEFAULTS', () => {
  it('covers every StationMessageState with no extras', () => {
    const keys = Object.keys(STATION_MESSAGE_DEFAULTS).sort();
    expect(keys).toEqual([...EXPECTED_STATES].sort());
  });

  it('provides a non-empty string template for every state', () => {
    for (const state of EXPECTED_STATES) {
      const body = STATION_MESSAGE_DEFAULTS[state];
      expect(typeof body).toBe('string');
      expect(body.trim().length).toBeGreaterThan(0);
    }
  });

  it('renders the available slot with company, station, and pricing variables', () => {
    const body = STATION_MESSAGE_DEFAULTS.available;
    expect(body).toContain('{{companyName}}');
    expect(body).toContain('{{stationOcppId}}');
    expect(body).toContain('{{pricingDisplay}}');
  });

  it('exposes live charging metrics in the charging template', () => {
    const body = STATION_MESSAGE_DEFAULTS.charging;
    expect(body).toContain('{{energyKwh}}');
    expect(body).toContain('{{powerKw}}');
    expect(body).toContain('{{costFormatted}}');
    expect(body).toContain('{{elapsedFormatted}}');
  });

  it('guards the reserved driver name behind a Handlebars conditional', () => {
    const body = STATION_MESSAGE_DEFAULTS.reserved;
    expect(body).toContain('{{#if driverFirstName}}');
    expect(body).toContain('{{driverFirstName}}');
    expect(body).toContain('{{/if}}');
    expect(body).toContain('{{reservationExpiresAt}}');
  });

  it('directs faulted stations to support', () => {
    expect(STATION_MESSAGE_DEFAULTS.faulted).toContain('{{supportPhone}}');
  });

  it('guards optional support phone in one-shot payment messages', () => {
    const failed = STATION_MESSAGE_DEFAULTS.payment_failed;
    expect(failed).toContain('{{#if supportPhone}}');
    expect(failed).toContain('{{supportPhone}}');
    expect(failed.toLowerCase()).toContain('declined');
  });

  it('every Handlebars conditional is balanced', () => {
    for (const state of EXPECTED_STATES) {
      const body = STATION_MESSAGE_DEFAULTS[state];
      const opens = (body.match(/{{#if/g) ?? []).length;
      const closes = (body.match(/{{\/if}}/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });
});
