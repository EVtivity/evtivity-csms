// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DEFAULT_HOME_CARDS, type HomeCardId } from '../home-cards';

const STORAGE_KEY = 'portal_home_cards';

async function freshStore() {
  vi.resetModules();
  return import('../home-cards-store');
}

describe('useHomeCards store', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('initializes to the defaults when nothing is stored', async () => {
    const { useHomeCards } = await freshStore();
    expect(useHomeCards.getState().cards).toEqual(DEFAULT_HOME_CARDS);
  });

  it('loads and sanitizes a stored selection', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['rfid', 'scanQr', 'bogus', 'rfid']));
    const { useHomeCards } = await freshStore();
    expect(useHomeCards.getState().cards).toEqual(['rfid', 'scanQr']);
  });

  it('falls back to defaults on corrupt JSON', async () => {
    localStorage.setItem(STORAGE_KEY, 'not json');
    const { useHomeCards } = await freshStore();
    expect(useHomeCards.getState().cards).toEqual(DEFAULT_HOME_CARDS);
  });

  it('setCards sanitizes, updates state, and persists', async () => {
    const { useHomeCards } = await freshStore();
    useHomeCards.getState().setCards(['vehicles', 'scanQr', 'vehicles', 'bogus'] as HomeCardId[]);
    expect(useHomeCards.getState().cards).toEqual(['vehicles', 'scanQr']);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')).toEqual(['vehicles', 'scanQr']);
  });

  it('setCards with too few valid cards reverts to defaults', async () => {
    const { useHomeCards } = await freshStore();
    useHomeCards.getState().setCards(['scanQr']);
    expect(useHomeCards.getState().cards).toEqual(DEFAULT_HOME_CARDS);
  });

  it('setCards still updates state when persistence throws', async () => {
    const { useHomeCards } = await freshStore();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => {
      useHomeCards.getState().setCards(['rfid', 'vehicles']);
    }).not.toThrow();
    expect(useHomeCards.getState().cards).toEqual(['rfid', 'vehicles']);
  });
});
