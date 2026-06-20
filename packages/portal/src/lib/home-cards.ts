// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { LucideIcon } from 'lucide-react';
import { QrCode, CreditCard, Wifi, Car, HelpCircle } from 'lucide-react';

// The quick-action cards a driver can place on the home screen. Drivers choose
// which appear and in what order; the selection is device-local. "Scan QR Code"
// opens the charger scanner.
export type HomeCardId = 'scanQr' | 'paymentMethods' | 'rfid' | 'vehicles' | 'support';

export interface HomeCardDef {
  id: HomeCardId;
  icon: LucideIcon;
  labelKey: string;
  to: string;
}

export const HOME_CARDS: Record<HomeCardId, HomeCardDef> = {
  scanQr: { id: 'scanQr', icon: QrCode, labelKey: 'home.scanQr', to: '/scan' },
  paymentMethods: {
    id: 'paymentMethods',
    icon: CreditCard,
    labelKey: 'home.paymentMethods',
    to: '/payment-methods',
  },
  rfid: { id: 'rfid', icon: Wifi, labelKey: 'home.rfidCards', to: '/rfid-cards' },
  vehicles: { id: 'vehicles', icon: Car, labelKey: 'home.vehicles', to: '/vehicles' },
  support: { id: 'support', icon: HelpCircle, labelKey: 'home.supportCases', to: '/support' },
};

export const ALL_HOME_CARD_IDS: HomeCardId[] = [
  'scanQr',
  'paymentMethods',
  'rfid',
  'vehicles',
  'support',
];

// Default home: Scan QR Code first, Support left off.
export const DEFAULT_HOME_CARDS: HomeCardId[] = ['scanQr', 'paymentMethods', 'rfid', 'vehicles'];

export const MIN_HOME_CARDS = 2;
export const MAX_HOME_CARDS = 4;

function isHomeCardId(v: unknown): v is HomeCardId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(HOME_CARDS, v);
}

// Coerce stored or untrusted input into a valid selection: keep only known ids,
// drop duplicates, preserve order, clamp to MAX, and fall back to the defaults
// when fewer than MIN remain so a corrupt list never leaves the home empty.
export function sanitizeHomeCards(input: unknown): HomeCardId[] {
  if (!Array.isArray(input)) return [...DEFAULT_HOME_CARDS];
  const seen = new Set<HomeCardId>();
  for (const v of input) {
    if (isHomeCardId(v)) seen.add(v);
    if (seen.size >= MAX_HOME_CARDS) break;
  }
  const cards = [...seen];
  return cards.length >= MIN_HOME_CARDS ? cards : [...DEFAULT_HOME_CARDS];
}
