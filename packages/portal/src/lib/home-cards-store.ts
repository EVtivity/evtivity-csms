// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { create } from 'zustand';
import { tryParseJson } from '@evtivity/lib/safe-json';
import { DEFAULT_HOME_CARDS, sanitizeHomeCards, type HomeCardId } from './home-cards';

// Device-local preference, not synced to the driver profile.
const STORAGE_KEY = 'portal_home_cards';

function loadInitial(): HomeCardId[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    console.warn('Read the home cards from localStorage failed, using the defaults', err);
    return [...DEFAULT_HOME_CARDS];
  }
  const parsed = tryParseJson(raw);
  return parsed !== undefined ? sanitizeHomeCards(parsed) : [...DEFAULT_HOME_CARDS];
}

interface HomeCardsState {
  cards: HomeCardId[];
  setCards: (cards: HomeCardId[]) => void;
}

export const useHomeCards = create<HomeCardsState>((set) => ({
  cards: loadInitial(),
  setCards: (cards) => {
    const next = sanitizeHomeCards(cards);
    set({ cards: next });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (err) {
      // Best-effort persistence: the cards still apply for this page load.
      console.warn('Save the home cards to localStorage failed', err);
    }
  },
}));
