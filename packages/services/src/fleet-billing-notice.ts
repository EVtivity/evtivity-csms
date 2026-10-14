// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { client } from '@evtivity/database';
import {
  isFleetEnabled,
  loadBillingMemberships,
  pickAccountBilling,
  type AccountInvoiceRecipient,
  type BillingMembership,
} from '@evtivity/database';
import { dispatchDriverNotification } from '@evtivity/lib';
import type { ServiceLogger } from '@evtivity/lib';
import { jobQueue } from '@evtivity/lib/job-queues';
import {
  FLEET_BILLING_FANOUT_JOB_OPTIONS,
  FLEET_BILLING_FANOUT_QUEUE,
} from '@evtivity/lib/worker-queues';
import { ALL_TEMPLATES_DIRS } from './template-dirs.js';

/** The shared postgres client type (the API and worker pass `client`). */
type Sql = typeof client;

/**
 * A committed change that can move a driver between card and account billing
 * (fleet account billing, `features/fleet-billing.md`).
 *
 * - `fleet`: the fleet's account billing switch was set to `enabled`.
 * - `recipient`: the fleet's invoice recipient was set to `recipient`; with
 *   `enabled`, the switch was set to it in the same write.
 * - `optOut`: the driver's opt-out in the fleet was set to `optOut`.
 * - `joined`: the driver joined the fleet.
 * - `left`: the driver left the fleet; `membership` is the removed row.
 */
export type AccountBillingChange =
  | { kind: 'fleet'; fleetId: string; enabled: boolean }
  | { kind: 'recipient'; fleetId: string; recipient: AccountInvoiceRecipient; enabled?: boolean }
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
    case 'recipient': {
      const other: AccountInvoiceRecipient = change.recipient === 'member' ? 'fleet' : 'member';
      const set = (recipient: AccountInvoiceRecipient, enabled?: boolean): BillingMembership[] =>
        current.map((m) =>
          m.fleetId === change.fleetId
            ? {
                ...m,
                invoiceRecipient: recipient,
                accountBillingEnabled: enabled ?? m.accountBillingEnabled,
              }
            : m,
        );
      const enabledBefore = change.enabled == null ? undefined : !change.enabled;
      return {
        before: set(other, enabledBefore),
        after: set(change.recipient, change.enabled),
      };
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
 * the billing rule (pickAccountBilling) gives another fleet, card instead of
 * account or back, or another invoice recipient, with the change than
 * without it. A change that leaves the driver billed as before (an older
 * membership still wins, the member opted out, fleets are turned off) sends
 * nothing (P7: once per change). Variables: `fleetName` (the fleet that
 * changed), `billedTo` (the fleet the driver is billed to now, empty for
 * card), `accountBilling`, `invoicedTo` (`fleet`, `member`, empty for card)
 * and `invoicedToMember` (the driver now gets the monthly invoice, for
 * `{{#if}}`). Fail-open (P9): the change is committed; a failure is logged at
 * warn and returns false.
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
    if (was?.fleetId === now?.fleetId && was?.recipient === now?.recipient) return false;
    const fleetId = changedFleetId(change);
    const fleetName =
      change.kind === 'left'
        ? change.membership.fleetName
        : (current.find((m) => m.fleetId === fleetId)?.fleetName ?? '');
    await dispatchDriverNotification(
      sql,
      'fleet.AccountBillingChanged',
      driverId,
      {
        fleetName,
        billedTo: now?.fleetName ?? '',
        accountBilling: now != null,
        invoicedTo: now?.recipient ?? '',
        invoicedToMember: now?.recipient === 'member',
      },
      ALL_TEMPLATES_DIRS,
    );
    return true;
  } catch (err) {
    log.warn({ err, driverId }, 'Account billing notification failed; continuing');
    return false;
  }
}

/** The BullMQ job name of one fan-out. */
export const FLEET_BILLING_FANOUT_JOB_NAME = 'fleet-billing-fanout';

/** One fleet billing change, fanned out to its members by the worker. */
export interface FleetBillingFanoutJob {
  fleetId: string;
  /** The account billing switch after the change. */
  enabled: boolean;
  /** fleets.updated_at of the change (ISO 8601): part of the job id (P7). */
  changedAt: string;
  /**
   * Set when the change set the invoice recipient: the recipient after it.
   * Absent (the v0.1.45 shape): the change was the switch alone.
   */
  recipient?: AccountInvoiceRecipient;
  /** With `recipient`: the same write also changed the switch to `enabled`. */
  enabledChanged?: boolean;
}

/** The member-level change a fan-out job carries. */
export function fanoutChange(job: FleetBillingFanoutJob): AccountBillingChange {
  if (job.recipient == null) {
    return { kind: 'fleet', fleetId: job.fleetId, enabled: job.enabled };
  }
  return {
    kind: 'recipient',
    fleetId: job.fleetId,
    recipient: job.recipient,
    ...(job.enabledChanged === true ? { enabled: job.enabled } : {}),
  };
}

/**
 * The BullMQ job id of a fleet billing fan-out: one job per fleet and change,
 * so a repeated add of the same change adds nothing. Segments join
 * with '.' (BullMQ rejects ':' in custom job ids).
 */
export function fleetBillingFanoutJobId(job: FleetBillingFanoutJob): string {
  const recipient = job.recipient == null ? '' : `.${job.recipient}`;
  return `fbf.${job.fleetId}.${job.enabled ? 'on' : 'off'}${recipient}.${String(Date.parse(job.changedAt))}`;
}

/**
 * Hands the member notices of a fleet switch to the worker: adds the
 * `fleet-billing-fanout` job itself, so the change waits in Redis while no
 * worker runs, and a member list too long for a request is never notified
 * inside it. Job id per fleet and change (P7): a repeated add adds nothing.
 * Fail-open (P9): the switch is committed; a failed add (Redis down) loses
 * only the notices and is logged at error.
 */
export async function enqueueFleetBillingFanout(
  job: FleetBillingFanoutJob,
  log: ServiceLogger,
): Promise<void> {
  try {
    await jobQueue(FLEET_BILLING_FANOUT_QUEUE, FLEET_BILLING_FANOUT_JOB_OPTIONS).add(
      FLEET_BILLING_FANOUT_JOB_NAME,
      job,
      { jobId: fleetBillingFanoutJobId(job) },
    );
  } catch (err) {
    log.error(
      { err, fleetId: job.fleetId },
      'Fleet billing fan-out job not queued; the members are not notified',
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
    const sent = await notifyAccountBillingChange(sql, member.driver_id, fanoutChange(job), log);
    if (sent) notified++;
  }
  return { members: members.length, notified };
}
