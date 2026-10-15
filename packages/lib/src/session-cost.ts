// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The cost a session shows, shared by the CSMS and the portal (browser-safe,
// no imports). One rule for every list and detail view:
// - active: the running cost;
// - faulted or failed: the final cost, 0 when none was stored (such a
//   session is not billed unless an operator re-bills it, which stores one);
// - completed and any other ended status: the final cost (null when the
//   session was never priced).

export interface SessionCostFields {
  status: string;
  finalCostCents?: number | null;
  currentCostCents?: number | null;
}

/** True for the statuses of a session that ended without a normal completion. */
export function isUnsuccessfulSessionStatus(status: string): boolean {
  return status === 'faulted' || status === 'failed';
}

/** The cost in cents a session shows, or null when it has none to show. */
export function sessionDisplayCostCents(session: SessionCostFields): number | null {
  if (session.status === 'active') return session.currentCostCents ?? null;
  if (isUnsuccessfulSessionStatus(session.status)) return session.finalCostCents ?? 0;
  return session.finalCostCents ?? null;
}

/** A faulted or failed session that costs nothing: the driver was not charged. */
export function isUnchargedSession(session: SessionCostFields): boolean {
  return isUnsuccessfulSessionStatus(session.status) && sessionDisplayCostCents(session) === 0;
}
