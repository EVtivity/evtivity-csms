// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { client } from '@evtivity/database';
import {
  isFleetEnabled,
  loadBillingMemberships,
  pickAccountBilling,
  type BillingMembership,
} from '@evtivity/database';
import { dispatchDriverNotification } from '@evtivity/lib';
import type { ServiceLogger } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { ALL_TEMPLATES_DIRS } from './template-dirs.js';

/** The shared postgres client type (the API and worker pass `client`). */
type Sql = typeof client;

/**
 * A committed change that can move a driver between card and account billing
 * (fleet account billing, `features/fleet-billing.md`).
 *
 * - `fleet`: the fleet's account billing switch was set to `enabled`.
 * - `optOut`: the driver's opt-out in the fleet was set to `optOut`.
 * - `joined`: the driver joined the fleet.
 * - `left`: the driver left the fleet; `membership` is the removed row.
 */
export type AccountBillingChange =
  | { kind: 'fleet'; fleetId: string; enabled: boolean }
  | { kind: 'optOut'; fleetId: string; optOut: boolean }
  | { kind: 'joined'; fleetId: string }
  | { kind: 'left'; membership: BillingMembership };

function changedFleetId(change: AccountBillingChange): string {
  return change.kind === 'left' ? change.membership.fleetId : change.fleetId;
}

/**
 * The driver's memberships with and without the change, from the current
 * ones. The change itself is pinned in `after` (a fan-out job for an older
 * switch evaluates its own change, not whatever the switch reads now), and
 * every other membership is read as it is.
 */
export function membershipsAround(
  current: readonly BillingMembership[],
  change: AccountBillingChange,
): { before: BillingMembership[]; after: BillingMembership[] } {
  switch (change.kind) {
    case 'fleet': {
      const set = (enabled: boolean): BillingMembership[] =>
        current.map((m) =>
          m.fleetId === change.fleetId ? { ...m, accountBillingEnabled: enabled } : m,
        );
      return { before: set(!change.enabled), after: set(change.enabled) };
    }
    case 'optOut': {
      const set = (optOut: boolean): BillingMembership[] =>
        current.map((m) => (m.fleetId === change.fleetId ? { ...m, optOut } : m));
      return { before: set(!change.optOut), after: set(change.optOut) };
    }
    case 'joined':
      return { before: current.filter((m) => m.fleetId !== change.fleetId), after: [...current] };
    case 'left': {
      const after = current.filter((m) => m.fleetId !== change.membership.fleetId);
      return { before: [...after, change.membership], after };
    }
  }
}

/**
 * Sends the driver fleet.AccountBillingChanged when the change moved them:
 * the billing rule (pickAccountBilling) gives another fleet, or card instead
 * of account or back, with the change than without it. A change that leaves
 * the driver billed as before (an older membership still wins, the member
 * opted out, fleets are turned off) sends nothing (P7: once per change).
 * Variables: `fleetName` (the fleet that changed), `billedTo` (the fleet the
 * driver is billed to now, empty for card), `accountBilling`. Fail-open (P9):
 * the change is committed; a failure is logged at warn and returns false.
 */
export async function notifyAccountBillingChange(
  sql: Sql,
  driverId: string,
  change: AccountBillingChange,
  log: ServiceLogger,
): Promise<boolean> {
  try {
    if (!(await isFleetEnabled())) return false;
    const current = await loadBillingMemberships(sql, driverId);
    const { before, after } = membershipsAround(current, change);
    const was = pickAccountBilling(before);
    const now = pickAccountBilling(after);
    if (was?.fleetId === now?.fleetId) return false;
    const fleetId = changedFleetId(change);
    const fleetName =
      change.kind === 'left'
        ? change.membership.fleetName
        : (current.find((m) => m.fleetId === fleetId)?.fleetName ?? '');
    await dispatchDriverNotification(
      sql,
      'fleet.AccountBillingChanged',
      driverId,
      { fleetName, billedTo: now?.fleetName ?? '', accountBilling: now != null },
      ALL_TEMPLATES_DIRS,
    );
    return true;
  } catch (err) {
    log.warn({ err, driverId }, 'Account billing notification failed; continuing');
    return false;
  }
}

/** The pub/sub channel the API hands a fleet switch fan-out to the worker on. */
export const FLEET_BILLING_FANOUT_CHANNEL = 'fleet_billing_fanout';

/** One fleet switch change, fanned out to its members by the worker. */
export interface FleetBillingFanoutJob {
  fleetId: string;
  enabled: boolean;
  /** fleets.updated_at of the change (ISO 8601): part of the job id (P7). */
  changedAt: string;
}

/**
 * The BullMQ job id of a fleet switch fan-out: one job per fleet and change,
 * so a repeated publish of the same change enqueues nothing. Segments join
 * with '.' (BullMQ rejects ':' in custom job ids).
 */
export function fleetBillingFanoutJobId(job: FleetBillingFanoutJob): string {
  return `fbf.${job.fleetId}.${job.enabled ? 'on' : 'off'}.${String(Date.parse(job.changedAt))}`;
}

/**
 * Hands the member notices of a fleet switch to the worker (the
 * `fleet_billing_fanout` channel, then the `fleet-billing-fanout` queue), so
 * a fleet with many members never notifies inside the request. Fail-open
 * (P9): the switch is committed; a lost publish loses only the notices and
 * is logged at error.
 */
export async function publishFleetBillingFanout(
  job: FleetBillingFanoutJob,
  log: ServiceLogger,
): Promise<void> {
  try {
    await getPubSub().publish(FLEET_BILLING_FANOUT_CHANNEL, JSON.stringify(job));
  } catch (err) {
    log.error(
      { err, fleetId: job.fleetId },
      'Fleet billing fan-out publish failed; the members are not notified',
    );
  }
}

/** Notifies one fleet member at a time; the worker job is not on a request path. */
export async function runFleetBillingFanout(
  sql: Sql,
  job: FleetBillingFanoutJob,
  log: ServiceLogger,
): Promise<{ members: number; notified: number }> {
  const members = await sql<Array<{ driver_id: string }>>`
    SELECT driver_id FROM fleet_drivers WHERE fleet_id = ${job.fleetId} ORDER BY id
  `;
  let notified = 0;
  for (const member of members) {
    const sent = await notifyAccountBillingChange(
      sql,
      member.driver_id,
      { kind: 'fleet', fleetId: job.fleetId, enabled: job.enabled },
      log,
    );
    if (sent) notified++;
  }
  return { members: members.length, notified };
}
