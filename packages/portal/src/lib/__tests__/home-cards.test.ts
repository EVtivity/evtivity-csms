// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  sanitizeHomeCards,
  DEFAULT_HOME_CARDS,
  ALL_HOME_CARD_IDS,
  HOME_CARDS,
  MAX_HOME_CARDS,
  MIN_HOME_CARDS,
} from '../home-cards';

describe('sanitizeHomeCards', () => {
  it('returns the defaults for non-array input', () => {
    expect(sanitizeHomeCards(null)).toEqual(DEFAULT_HOME_CARDS);
    expect(sanitizeHomeCards(undefined)).toEqual(DEFAULT_HOME_CARDS);
    expect(sanitizeHomeCards('scanQr')).toEqual(DEFAULT_HOME_CARDS);
    expect(sanitizeHomeCards({})).toEqual(DEFAULT_HOME_CARDS);
  });

  it('keeps a valid selection unchanged and in order', () => {
    expect(sanitizeHomeCards(['rfid', 'scanQr', 'vehicles'])).toEqual([
      'rfid',
      'scanQr',
      'vehicles',
    ]);
  });

  it('drops unknown ids', () => {
    expect(sanitizeHomeCards(['scanQr', 'bogus', 'vehicles'])).toEqual(['scanQr', 'vehicles']);
  });

  it('drops duplicates, preserving first position', () => {
    expect(sanitizeHomeCards(['scanQr', 'scanQr', 'rfid'])).toEqual(['scanQr', 'rfid']);
  });

  it('clamps to MAX_HOME_CARDS', () => {
    const result = sanitizeHomeCards(['scanQr', 'paymentMethods', 'rfid', 'vehicles', 'support']);
    expect(result).toHaveLength(MAX_HOME_CARDS);
    expect(result).toEqual(['scanQr', 'paymentMethods', 'rfid', 'vehicles']);
  });

  it('falls back to defaults when fewer than MIN_HOME_CARDS survive', () => {
    expect(sanitizeHomeCards(['scanQr'])).toEqual(DEFAULT_HOME_CARDS);
    expect(sanitizeHomeCards(['scanQr', 'bogus'])).toEqual(DEFAULT_HOME_CARDS);
    expect(sanitizeHomeCards([])).toEqual(DEFAULT_HOME_CARDS);
  });

  it('keeps a selection at exactly MIN_HOME_CARDS', () => {
    expect(sanitizeHomeCards(['scanQr', 'support'])).toHaveLength(MIN_HOME_CARDS);
  });
});

describe('home card registry', () => {
  it('defaults are a valid subset of the pool with Support left off', () => {
    expect(DEFAULT_HOME_CARDS.length).toBeGreaterThanOrEqual(MIN_HOME_CARDS);
    expect(DEFAULT_HOME_CARDS.length).toBeLessThanOrEqual(MAX_HOME_CARDS);
    expect(DEFAULT_HOME_CARDS).not.toContain('support');
    for (const id of DEFAULT_HOME_CARDS) {
      expect(ALL_HOME_CARD_IDS).toContain(id);
    }
  });

  it('every pool id has a registry definition with a route and label key', () => {
    for (const id of ALL_HOME_CARD_IDS) {
      const def = HOME_CARDS[id];
      expect(def).toBeDefined();
      expect(def.id).toBe(id);
      expect(def.to.startsWith('/')).toBe(true);
      expect(def.labelKey.length).toBeGreaterThan(0);
    }
  });

  it('Scan QR Code is first in the defaults and routes to the scanner', () => {
    expect(DEFAULT_HOME_CARDS[0]).toBe('scanQr');
    expect(HOME_CARDS.scanQr.to).toBe('/scan');
  });
});
