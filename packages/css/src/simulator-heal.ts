// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Self-heal watchdog tuning for SimulatorManager. The 5s sync poll restarts a
// station that has been running past STUCK_GRACE_MS without becoming ready
// (booted Accepted + reported connector status). This recovers stations that
// jammed during a cold-start connection storm, where they boot but never
// complete the StatusNotification sweep, leaving their connectors stuck at the
// seeded Unavailable.

// How long a station may be continuously not-ready before it counts as stuck.
export const STUCK_GRACE_MS = 45_000;

// Cap restarts per poll so healing a large jammed fleet does not recreate the
// same simultaneous-reconnect herd that caused the jam.
export const MAX_HEAL_PER_TICK = 25;

// Stop restarting a single station after this many heals: if restarts have not
// fixed it, the cause is not something a restart can address.
export const MAX_HEAL_ATTEMPTS = 5;

export interface StuckCheckState {
  ready: boolean;
  notReadyMs: number;
  bootStatus: 'Accepted' | 'Pending' | 'Rejected' | null;
  healAttempts: number;
  // True when chaos goOffline deliberately parked the station offline.
  offline: boolean;
}

// A station is stuck (and worth restarting) only when it is not ready, has been
// so past the grace period, is not deliberately offline (chaos goOffline), is
// not deliberately held at Pending/Rejected boot (a restart cannot change an
// onboarding decision), and has not already exhausted its restart budget.
export function isStationStuck(s: StuckCheckState): boolean {
  if (s.ready) return false;
  if (s.offline) return false;
  if (s.notReadyMs <= STUCK_GRACE_MS) return false;
  if (s.bootStatus === 'Pending' || s.bootStatus === 'Rejected') return false;
  if (s.healAttempts >= MAX_HEAL_ATTEMPTS) return false;
  return true;
}
