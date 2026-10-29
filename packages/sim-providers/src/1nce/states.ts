// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { SimState } from '../types.js';

/** The two SIM states of `GET /v2/sims/{iccid}` (`SimsSim.status`). */
export const ONENCE_SIM_STATES: readonly string[] = Object.freeze(['Enabled', 'Disabled']);

/** The connectivity states of `GET /v2/sims/{iccid}/status` (`SimsConnectivityStatus`). */
export const ONENCE_CONNECTIVITY_STATES: readonly string[] = Object.freeze([
  'ONLINE',
  'ATTACHED',
  'OFFLINE',
  'BLOCKED',
]);

const PROVIDER_STATE_MAX_LENGTH = 64;

/**
 * The CSMS state of a 1NCE SIM. `Disabled` reads as suspended (owner decision
 * 2026-10-29): the customer can enable it again in the 1NCE Portal. A quota
 * that is used up or expired does not change the state; it shows in the usage
 * and the alerts.
 */
export function mapOneNceState(simStatus: string | null, connectivity: string | null): SimState {
  if (simStatus === 'Disabled') return 'suspended';
  if (simStatus === 'Enabled') return connectivity === 'BLOCKED' ? 'suspended' : 'active';
  return 'unknown';
}

/** The provider state shown beside the mapped one: `Enabled (ONLINE)`, at most 64 characters. */
export function oneNceProviderState(simStatus: string | null, connectivity: string | null): string {
  const sim = simStatus != null && ONENCE_SIM_STATES.includes(simStatus) ? simStatus : '';
  const link =
    connectivity != null && ONENCE_CONNECTIVITY_STATES.includes(connectivity) ? connectivity : '';
  const text = sim === '' ? link : link === '' ? sim : `${sim} (${link})`;
  return text.slice(0, PROVIDER_STATE_MAX_LENGTH);
}
