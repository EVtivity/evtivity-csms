// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { SimState } from '../types.js';

/** Every value of the Hologram `NetworkState` enum, from its OpenAPI spec. */
export const HOLOGRAM_NETWORK_STATES = [
  'INACTIVE',
  'INACTIVE-TESTED',
  'FACTORY-PENDING',
  'FACTORY',
  'LIVE-PENDING',
  'LIVE',
  'FROZEN',
  'FROZEN-PENDING',
  'DEAD',
  'DEAD-PENDING',
  'PAUSED-SYS',
  'PAUSED-PENDING-SYS',
  'PAUSED-USER',
  'PAUSED-PENDING-USER',
  'TEST-ACTIVATE',
  'TEST-ACTIVATE-PENDING',
  'TEST-AUTOACTIVATE',
  'TEST-AUTOACTIVATE-PENDING',
  'TEST-HIBERNATE',
  'TEST-HIBERNATE-PENDING',
] as const;

export type HologramNetworkState = (typeof HOLOGRAM_NETWORK_STATES)[number];

const STATE_MAP: Readonly<Record<HologramNetworkState, SimState>> = {
  LIVE: 'active',
  'LIVE-PENDING': 'pending',
  'PAUSED-PENDING-SYS': 'pending',
  'PAUSED-PENDING-USER': 'pending',
  FACTORY: 'pending',
  'FACTORY-PENDING': 'pending',
  'PAUSED-SYS': 'suspended',
  'PAUSED-USER': 'suspended',
  FROZEN: 'suspended',
  'FROZEN-PENDING': 'suspended',
  INACTIVE: 'inactive',
  'INACTIVE-TESTED': 'inactive',
  'TEST-ACTIVATE': 'test',
  'TEST-ACTIVATE-PENDING': 'test',
  'TEST-AUTOACTIVATE': 'test',
  'TEST-AUTOACTIVATE-PENDING': 'test',
  'TEST-HIBERNATE': 'test',
  'TEST-HIBERNATE-PENDING': 'test',
  DEAD: 'deactivated',
  'DEAD-PENDING': 'deactivated',
};

/** Hologram allows a network reset (update location) only in these states. */
export const HOLOGRAM_RESET_STATES: ReadonlySet<string> = new Set([
  'LIVE',
  'TEST-ACTIVATE',
  'TEST-AUTOACTIVATE',
]);

function isHologramNetworkState(value: string): value is HologramNetworkState {
  return Object.hasOwn(STATE_MAP, value);
}

/** Maps a Hologram network state; a value the spec adds later is `unknown`. */
export function mapHologramState(state: string | null): SimState {
  if (state == null || !isHologramNetworkState(state)) return 'unknown';
  return STATE_MAP[state];
}
