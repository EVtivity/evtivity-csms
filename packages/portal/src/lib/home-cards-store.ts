// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { create } from 'zustand';
import { DEFAULT_HOME_CARDS, sanitizeHomeCards, type HomeCardId } from './home-cards';

// Device-local preference, not synced to the driver profile.
const STORAGE_KEY = 'portal_home_cards';

function loadInitial(): HomeCardId[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw != null ? sanitizeHomeCards(JSON.parse(raw)) : [...DEFAULT_HOME_CARDS];
  } catch {
    return [...DEFAULT_HOME_CARDS];
  }
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
    } catch {
      /* best-effort persistence */
    }
  },
}));
