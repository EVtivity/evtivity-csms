// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Operator notices and live updates of depot departures (route-aware
// charging): the at-risk and missed notices, each sent once per departure
// (claimed in vehicle_departure_notices), the departure-close run of the
// worker, and the csms_events the readiness views refresh on.

import {
  claimDepartureNotice,
  client,
  completePassedDepartures,
  isFleetChargingEnabled,
  markSitePlanStale,
  type CompletedDeparture,
  type SitePlanWriteResult,
} from '@evtivity/database';
import { dispatchSystemNotification, type PubSubClient, type ServiceLogger } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { ALL_TEMPLATES_DIRS } from './template-dirs.js';

export const DEPARTURE_AT_RISK_EVENT = 'fleet.DepartureAtRisk';
export const DEPARTURE_MISSED_EVENT = 'fleet.DepartureMissed';
/** Published after each plan write of a site (loadManagement:read). */
export const FLEET_CHARGING_UPDATED_EVENT = 'fleetCharging.updated';
/** Published after departures of a site changed: created, edited, cancelled, imported, completed (fleets:read). */
export const DEPARTURE_CHANGED_EVENT = 'departure.changed';

/** Readiness states that send the at-risk notice. */
const AT_RISK_STATES: ReadonlySet<string> = new Set(['at_risk', 'cannot_meet']);
/** Outcomes that send the missed notice. */
const MISSED_OUTCOMES: ReadonlySet<string> = new Set(['short', 'no_vehicle']);
/** Batches of one departure-close run; the rest waits for the next minute. */
const CLOSE_BATCHES = 10;
const CLOSE_BATCH_SIZE = 1000;

const REASON_FLAGS: Readonly<Record<string, string>> = {
  site_capacity: 'reasonSiteCapacity',
  not_plugged_in: 'reasonNotPluggedIn',
  late_arrival: 'reasonLateArrival',
  charger_not_following: 'reasonChargerNotFollowing',
  profile_rejected: 'reasonProfileRejected',
  station_offline: 'reasonStationOffline',
  vehicle_power: 'reasonVehiclePower',
  unknown_soc: 'reasonUnknownSoc',
};

export interface DepartureNoticeDeps {
  log: ServiceLogger;
  templatesDirs?: string[];
  /** The CSMS address the readiness link points at; defaults to CSMS_URL. */
  csmsUrl?: string;
  now?: () => Date;
}

interface NoticeRow {
  id: string;
  status: string;
  departure_at: Date | string | null;
  readiness: string | null;
  readiness_reason: string | null;
  shortfall_kwh: string | null;
  delivered_kwh: string | null;
  target_kind: string;
  target_energy_kwh: string | null;
  target_soc_percent: number | null;
  outcome: string | null;
  site_id: string;
  site_name: string;
  license_plate: string | null;
  make: string | null;
  model: string | null;
}

interface Recipient {
  id: string;
  email: string;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  language: string;
  timezone: string;
}

function csmsBase(deps: DepartureNoticeDeps): string {
  return (deps.csmsUrl ?? process.env['CSMS_URL'] ?? 'http://localhost:7100').replace(/\/$/, '');
}

function kwh(value: string | null): string {
  if (value == null) return '';
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(1) : '';
}

async function loadNoticeRows(ids: string[]): Promise<NoticeRow[]> {
  if (ids.length === 0) return [];
  return client<NoticeRow[]>`
    SELECT d.id, d.status, d.departure_at, d.readiness, d.readiness_reason, d.shortfall_kwh,
      d.delivered_kwh, d.target_kind, d.target_energy_kwh, d.target_soc_percent, d.outcome,
      d.site_id, si.name AS site_name, v.license_plate, v.make, v.model
    FROM vehicle_departures d
    JOIN sites si ON si.id = d.site_id
    JOIN vehicles v ON v.id = d.vehicle_id
    WHERE d.id = ANY(${ids})
    ORDER BY d.departure_at, d.id
  `;
}

/**
 * Active users with fleets:read (or write) whose sites include the depot; for
 * a null site, the ones with access to every site.
 */
async function depotRecipients(siteId: string | null): Promise<Recipient[]> {
  if (siteId == null) {
    return client<Recipient[]>`
      SELECT u.id, u.email, u.phone, u.first_name, u.last_name, u.language, u.timezone
      FROM users u
      WHERE u.is_active AND u.has_all_site_access
        AND EXISTS (SELECT 1 FROM user_permissions p
          WHERE p.user_id = u.id AND p.permission IN ('fleets:read', 'fleets:write'))
      ORDER BY u.id
    `;
  }
  return client<Recipient[]>`
    SELECT u.id, u.email, u.phone, u.first_name, u.last_name, u.language, u.timezone
    FROM users u
    WHERE u.is_active
      AND EXISTS (SELECT 1 FROM user_permissions p
        WHERE p.user_id = u.id AND p.permission IN ('fleets:read', 'fleets:write'))
      AND (u.has_all_site_access
        OR EXISTS (SELECT 1 FROM user_site_assignments a
          WHERE a.user_id = u.id AND a.site_id = ${siteId}))
    ORDER BY u.id
  `;
}

function baseVariables(row: NoticeRow, deps: DepartureNoticeDeps): Record<string, unknown> {
  const name = [row.make, row.model].filter((part) => part != null && part !== '').join(' ');
  return {
    vehicleName: name !== '' ? name : (row.license_plate ?? ''),
    licensePlate: row.license_plate ?? '',
    siteName: row.site_name,
    departureAt:
      row.departure_at instanceof Date ? row.departure_at.toISOString() : row.departure_at,
    readinessUrl: `${csmsBase(deps)}/sites/${encodeURIComponent(row.site_id)}?tab=fleet-readiness`,
  };
}

async function sendToDepot(
  eventType: string,
  row: NoticeRow,
  variables: Record<string, unknown>,
  deps: DepartureNoticeDeps,
): Promise<void> {
  const recipients = await depotRecipients(row.site_id);
  for (const user of recipients) {
    try {
      await dispatchSystemNotification(
        client,
        eventType,
        {
          email: user.email,
          phone: user.phone ?? undefined,
          firstName: user.first_name ?? undefined,
          lastName: user.last_name ?? undefined,
          language: user.language,
          timezone: user.timezone,
          userId: user.id,
        },
        variables,
        deps.templatesDirs ?? ALL_TEMPLATES_DIRS,
      );
    } catch (err: unknown) {
      deps.log.warn(
        { err, eventType, departureId: row.id, userId: user.id },
        'Departure notice not sent to a recipient',
      );
    }
  }
}

/** A bus depot system's charging requests were refused (features/vdv-463.md). */
export const DEPOT_REQUESTS_REFUSED_EVENT = 'fleet.DepotRequestsRefused';

/**
 * Sends a depot notice to the active users with fleets:read whose sites
 * include the depot. Fail-open per recipient; never throws.
 */
export async function notifyDepotUsers(
  eventType: string,
  siteId: string | null,
  variables: Record<string, unknown>,
  deps: DepartureNoticeDeps,
): Promise<void> {
  try {
    const recipients = await depotRecipients(siteId);
    for (const user of recipients) {
      try {
        await dispatchSystemNotification(
          client,
          eventType,
          {
            email: user.email,
            phone: user.phone ?? undefined,
            firstName: user.first_name ?? undefined,
            lastName: user.last_name ?? undefined,
            language: user.language,
            timezone: user.timezone,
            userId: user.id,
          },
          variables,
          deps.templatesDirs ?? ALL_TEMPLATES_DIRS,
        );
      } catch (err: unknown) {
        deps.log.warn(
          { err, eventType, siteId, userId: user.id },
          'Depot notice not sent to a recipient',
        );
      }
    }
  } catch (err: unknown) {
    deps.log.warn({ err, eventType, siteId }, 'Depot notice not sent');
  }
}

/** The CSMS link of the bus depot systems settings. */
export function depotSystemsUrl(deps: DepartureNoticeDeps): string {
  return `${csmsBase(deps)}/settings?tab=integrations&sub=depot-systems`;
}

/**
 * Sends `fleet.DepartureAtRisk` for each departure that is still scheduled,
 * ahead of now and at risk or unable to meet its target, once per departure:
 * the claim comes first, so parallel calls and later re-plans never send it
 * again. Fail-open: a failure is logged and the others continue. Returns the
 * number of departures notified.
 */
export async function notifyDepartureAtRisk(
  departureIds: string[],
  deps: DepartureNoticeDeps,
): Promise<number> {
  let sent = 0;
  try {
    const nowMs = (deps.now?.() ?? new Date()).getTime();
    for (const row of await loadNoticeRows([...new Set(departureIds)])) {
      try {
        if (row.status !== 'scheduled' || row.readiness == null) continue;
        if (!AT_RISK_STATES.has(row.readiness)) continue;
        // An ad hoc request has no departure, so it is never at risk of missing one.
        if (row.departure_at == null || new Date(row.departure_at).getTime() <= nowMs) continue;
        if (!(await claimDepartureNotice(row.id, 'at_risk'))) continue;
        const variables: Record<string, unknown> = {
          ...baseVariables(row, deps),
          cannotMeet: row.readiness === 'cannot_meet',
          shortfallKwh: kwh(row.shortfall_kwh),
        };
        const flag = row.readiness_reason != null ? REASON_FLAGS[row.readiness_reason] : undefined;
        if (flag != null) variables[flag] = true;
        await sendToDepot(DEPARTURE_AT_RISK_EVENT, row, variables, deps);
        sent++;
      } catch (err: unknown) {
        deps.log.warn({ err, departureId: row.id }, 'Departure at-risk notice not sent');
      }
    }
  } catch (err: unknown) {
    deps.log.warn({ err }, 'Departure at-risk notices not sent');
  }
  return sent;
}

/**
 * Sends `fleet.DepartureMissed` for each completed departure whose outcome is
 * short or no vehicle, once per departure (claimed first). Fail-open.
 */
export async function notifyDepartureMissed(
  departureIds: string[],
  deps: DepartureNoticeDeps,
): Promise<number> {
  let sent = 0;
  try {
    for (const row of await loadNoticeRows([...new Set(departureIds)])) {
      try {
        if (row.status !== 'completed' || row.outcome == null) continue;
        if (!MISSED_OUTCOMES.has(row.outcome)) continue;
        // An ad hoc request has no departure to miss.
        if (row.departure_at == null) continue;
        if (!(await claimDepartureNotice(row.id, 'missed'))) continue;
        await sendToDepot(
          DEPARTURE_MISSED_EVENT,
          row,
          {
            ...baseVariables(row, deps),
            noVehicle: row.outcome === 'no_vehicle',
            deliveredKwh: kwh(row.delivered_kwh),
            targetKwh: row.target_kind === 'energy' ? kwh(row.target_energy_kwh) : '',
            targetSocPercent:
              row.target_kind === 'soc' && row.target_soc_percent != null
                ? String(row.target_soc_percent)
                : '',
          },
          deps,
        );
        sent++;
      } catch (err: unknown) {
        deps.log.warn({ err, departureId: row.id }, 'Departure missed notice not sent');
      }
    }
  } catch (err: unknown) {
    deps.log.warn({ err }, 'Departure missed notices not sent');
  }
  return sent;
}

async function publishSiteEvent(
  eventType: string,
  siteIds: Iterable<string>,
  log: ServiceLogger,
  pubsub?: PubSubClient,
): Promise<void> {
  const target = pubsub ?? getPubSub();
  for (const siteId of new Set(siteIds)) {
    try {
      await target.publish(
        'csms_events',
        JSON.stringify({ eventType, siteId, stationId: null, sessionId: null }),
      );
    } catch (err: unknown) {
      log.warn({ err, eventType, siteId }, 'Depot event not published, the page refreshes later');
    }
  }
}

/** `fleetCharging.updated` for a site after its plan was written. Fail-open. */
export async function publishFleetChargingUpdated(
  siteId: string,
  log: ServiceLogger,
  pubsub?: PubSubClient,
): Promise<void> {
  await publishSiteEvent(FLEET_CHARGING_UPDATED_EVENT, [siteId], log, pubsub);
}

/** `departure.changed` for each site whose departures changed. Fail-open. */
export async function publishDepartureChanged(
  siteIds: Iterable<string>,
  log: ServiceLogger,
  pubsub?: PubSubClient,
): Promise<void> {
  await publishSiteEvent(DEPARTURE_CHANGED_EVENT, siteIds, log, pubsub);
}

/**
 * After the planner wrote a site's plan: `fleetCharging.updated` for the site,
 * `departure.changed` when the readiness of a departure changed (the fleet
 * Departures tab, for users without loadManagement:read), and the at-risk
 * notice for each departure the write moved into at risk or cannot meet. Fire
 * and forget, never throws, so the load management cycle never waits for mail
 * or Redis.
 */
export function afterSitePlanWrite(
  siteId: string,
  written: SitePlanWriteResult,
  log: ServiceLogger,
): void {
  void publishFleetChargingUpdated(siteId, log);
  if (written.changed.length > 0) void publishDepartureChanged([siteId], log);
  const atRisk = written.changed
    .filter((c) => c.readiness != null && AT_RISK_STATES.has(c.readiness))
    .map((c) => c.id);
  if (atRisk.length > 0) {
    void notifyDepartureAtRisk(atRisk, { log }).catch((err: unknown) => {
      log.warn({ err, siteId }, 'Departure at-risk notices not sent');
    });
  }
}

/** How far back the close run looks for missed notices not sent yet (a run that stopped after completing). */
export const MISSED_NOTICE_LOOKBACK_HOURS = 6;
const MISSED_NOTICE_BATCH = 500;

/**
 * Completed short or vehicle-less departures of the last hours at departure-aware
 * sites that have no missed notice yet: the ones this run completed, and any a
 * run that stopped after completing them left without a notice.
 */
async function missedNoticeBacklog(now: Date): Promise<string[]> {
  const since = new Date(now.getTime() - MISSED_NOTICE_LOOKBACK_HOURS * 3_600_000);
  const rows = await client<Array<{ id: string }>>`
    SELECT d.id
    FROM vehicle_departures d
    JOIN site_load_management slm ON slm.site_id = d.site_id AND slm.strategy = 'departure_aware'
    WHERE d.status = 'completed'
      AND d.outcome IN ('short', 'no_vehicle')
      AND d.departure_at > ${since}
      AND d.departure_at <= ${now}
      AND NOT EXISTS (SELECT 1 FROM vehicle_departure_notices n
        WHERE n.departure_id = d.id AND n.kind = 'missed')
    ORDER BY d.departure_at, d.id
    LIMIT ${MISSED_NOTICE_BATCH}
  `;
  return rows.map((r) => r.id);
}

/**
 * Sends the missed notices due: only while fleet charging is on and only at
 * departure-aware sites (elsewhere nothing plans the departures, so every one
 * would read as missed). A failed setting or backlog read is logged and the
 * next run tries again.
 */
async function sendMissedNotices(now: Date, deps: DepartureNoticeDeps): Promise<number> {
  try {
    if (!(await isFleetChargingEnabled())) return 0;
    const ids = await missedNoticeBacklog(now);
    return ids.length > 0 ? await notifyDepartureMissed(ids, deps) : 0;
  } catch (err: unknown) {
    deps.log.warn({ err }, 'Departure missed notices not sent, retried next run');
    return 0;
  }
}

export interface DepartureCloseResult {
  completed: number;
  met: number;
  short: number;
  noVehicle: number;
  notified: number;
}

/**
 * The departure-close run (worker, every minute): completes the departures
 * whose time passed with their outcome, marks their sites' plans stale, tells
 * the CSMS, and sends the missed notice once per departure. It completes
 * departures while fleet charging is off too, but sends missed notices only
 * while it is on and only at departure-aware sites (`sendMissedNotices`).
 */
export async function closePassedDepartures(
  deps: DepartureNoticeDeps & { pubsub?: PubSubClient },
): Promise<DepartureCloseResult> {
  const now = deps.now?.() ?? new Date();
  const completed: CompletedDeparture[] = [];
  for (let i = 0; i < CLOSE_BATCHES; i++) {
    const batch = await completePassedDepartures(now, CLOSE_BATCH_SIZE);
    completed.push(...batch);
    if (batch.length < CLOSE_BATCH_SIZE) break;
  }
  const result: DepartureCloseResult = {
    completed: completed.length,
    met: completed.filter((d) => d.outcome === 'met').length,
    short: completed.filter((d) => d.outcome === 'short').length,
    noVehicle: completed.filter((d) => d.outcome === 'no_vehicle').length,
    notified: 0,
  };
  if (completed.length > 0) {
    const siteIds = new Set(completed.map((d) => d.siteId));
    for (const siteId of siteIds) {
      await markSitePlanStale(siteId, 'departure_completed', deps.log, {
        departureAwareOnly: true,
      });
    }
    await publishDepartureChanged(siteIds, deps.log, deps.pubsub);
  }
  result.notified = await sendMissedNotices(now, deps);
  return result;
}
