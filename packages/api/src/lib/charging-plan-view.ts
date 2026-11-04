// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The depot charging plan of a site as the readiness view reads it (route-aware
// charging): the stored plan row, the site's scheduled departures with their
// readiness, and the active sessions no vehicle is bound to. Reads only; the
// plan is written by the load management cycle.

import { z } from 'zod';
import { and, asc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  evses,
  siteChargingPlans,
  siteLoadManagement,
  sites,
  vehicleDepartures,
  vehicles,
  isFleetChargingEnabled,
  isOperatorStation,
} from '@evtivity/database';
import { PLAN_HORIZON_HOURS } from '@evtivity/lib/charging-plan';
import {
  departureItem,
  departureView,
  depotSystemColumns,
  requestedChargingPointSql,
  withDepotSystem,
  withoutPlanReadiness,
} from './departure-views.js';

const HOUR_MS = 3_600_000;
/** Departures that left this long ago still show until the close job completes them. */
const RECENT_DEPARTURE_MS = 2 * HOUR_MS;

export const PLAN_NOT_PLANNING_REASONS = ['fleet_charging_disabled', 'strategy'] as const;

const jsonArray = z.array(z.unknown()).nullable();

const planDepartureItem = departureItem
  .extend({
    station: z
      .object({
        id: z.string().describe('Station ID (not the OCPP identifier)'),
        stationId: z.string().describe('OCPP identity of the station'),
        evseId: z.number().int().nullable().describe('OCPP EVSE number, null when unknown'),
      })
      .loose()
      .nullable()
      .describe('Station and EVSE of the session bound to the departure, null without one'),
    vehicle: z
      .object({
        id: z.string().describe('Vehicle identifier'),
        driverId: z
          .string()
          .optional()
          .describe('Driver who owns the vehicle; only with drivers:read'),
        make: z.string().nullable().describe('Vehicle make'),
        model: z.string().nullable().describe('Vehicle model'),
        licensePlate: z.string().nullable().describe('License plate'),
        bodyType: z
          .string()
          .nullable()
          .describe('Body type (sedan, van, bus, ...), null when unset'),
      })
      .loose()
      .describe('The departing vehicle'),
  })
  .loose();

export const sitePlanItem = z
  .object({
    planning: z
      .boolean()
      .describe(
        'True while the fleet charging setting is on and the site uses the Departure Aware strategy',
      ),
    notPlanningReason: z
      .enum(PLAN_NOT_PLANNING_REASONS)
      .nullable()
      .describe('Why the site has no plan: the setting is off, or another strategy'),
    bufferMinutes: z.number().int().describe('Minutes before a departure the plan aims to finish'),
    computedAt: z.coerce.date().nullable().describe('When the plan was last computed'),
    staleAt: z.coerce
      .date()
      .nullable()
      .describe('Set when something changed; the next load management cycle replans'),
    trigger: z.string().nullable().describe('Why the last plan ran'),
    slotStarts: jsonArray.describe('Slot start times (ISO 8601)'),
    plan: z
      .unknown()
      .optional()
      .describe('Per departure: slot kW, station, EVSE and the profile state; null without a plan'),
    siteLoadKw: jsonArray.describe('Planned site load per slot, kW'),
    capacityKw: jsonArray.describe('Site headroom per slot, kW'),
    pricePerKwh: jsonArray.describe('Electricity rate per slot'),
    runtimeMs: z.number().int().nullable().describe('How long the planner ran, ms'),
    departureStatus: z
      .enum(['scheduled', 'cancelled'])
      .optional()
      .describe(
        'Which departures are listed (the departureStatus query); cancelled ones carry their cancelReason and no readiness',
      ),
    departures: z
      .array(planDepartureItem)
      .optional()
      .describe(
        'Scheduled departures of the site from 2 hours ago to 48 hours ahead, in departure order, ad hoc requests of a bus depot system first. Only with fleets:read while the Fleet feature is on; the vehicle driverId only with drivers:read',
      ),
    unidentifiedSessions: z
      .array(
        z
          .object({
            sessionId: z
              .string()
              .optional()
              .describe('Active session without a vehicle; left out without sessions:read'),
            stationId: z.string().describe('Station ID (not the OCPP identifier)'),
            stationOcppId: z.string().describe('OCPP identity of the station'),
            evseId: z.number().int().nullable().describe('OCPP EVSE number, null when unknown'),
            driverId: z
              .string()
              .nullable()
              .optional()
              .describe(
                'Driver of the session, null when none; only with sessions:read and drivers:read',
              ),
            startedAt: z.coerce.date().nullable().describe('When the session started'),
          })
          .loose(),
      )
      .describe('Active sessions at the site with no vehicle: they share power equally'),
  })
  .loose();

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** What a reader of the plan may see beyond the plan itself. */
export interface PlanViewAccess {
  /** fleets:read and the Fleet feature on: the departures and their vehicles. */
  departures: boolean;
  /** drivers:read: driver ids of the departure vehicles. */
  driverIds: boolean;
  /** sessions:read: session ids of the departures and of the sessions without a vehicle. */
  sessionIds: boolean;
  /** sessions:read and drivers:read: driver ids of the sessions without a vehicle. */
  sessionDriverIds: boolean;
  /** settings.integrations:read and every site: the names of the bus depot systems. */
  depotSystemNames?: boolean;
}

/** Which departures the plan view lists: the scheduled ones (default) or the cancelled ones. */
export type PlanDepartureStatus = 'scheduled' | 'cancelled';

/** How far back the cancelled list of the readiness view reaches. */
export const CANCELLED_DEPARTURES_LOOKBACK_MS = 7 * 24 * HOUR_MS;

/** The plan view of a site the caller may read (the route checks the site). */
export async function siteChargingPlanView(
  siteId: string,
  access: PlanViewAccess,
  now: Date = new Date(),
  departureStatus: PlanDepartureStatus = 'scheduled',
): Promise<Record<string, unknown>> {
  // Scheduled: from 2 hours ago to the plan horizon, ad hoc always. Cancelled:
  // the last 7 days to the horizon, by departure time (ad hoc: when requested),
  // within the departure log retention.
  const windowFromMs =
    departureStatus === 'cancelled'
      ? now.getTime() - CANCELLED_DEPARTURES_LOOKBACK_MS
      : now.getTime() - RECENT_DEPARTURE_MS;
  const [enabled, [config], [plan], departureRows, sessionRows] = await Promise.all([
    isFleetChargingEnabled(),
    db
      .select({
        strategy: siteLoadManagement.strategy,
        bufferMinutes: siteLoadManagement.departureBufferMinutes,
      })
      .from(siteLoadManagement)
      .where(eq(siteLoadManagement.siteId, siteId)),
    db.select().from(siteChargingPlans).where(eq(siteChargingPlans.siteId, siteId)),
    db
      .select({
        departure: vehicleDepartures,
        vehicleDriverId: vehicles.driverId,
        vehicleMake: vehicles.make,
        vehicleModel: vehicles.model,
        vehicleLicensePlate: vehicles.licensePlate,
        vehicleBodyType: vehicles.bodyType,
        requestedChargingPointId: requestedChargingPointSql,
        ...depotSystemColumns,
        siteName: sites.name,
        siteTimezone: sites.timezone,
        boundStationId: chargingStations.id,
        boundStationOcppId: chargingStations.stationId,
        boundEvseId: evses.evseId,
      })
      .from(vehicleDepartures)
      .innerJoin(vehicles, eq(vehicles.id, vehicleDepartures.vehicleId))
      .innerJoin(sites, eq(sites.id, vehicleDepartures.siteId))
      .leftJoin(chargingSessions, eq(chargingSessions.id, vehicleDepartures.sessionId))
      .leftJoin(chargingStations, eq(chargingStations.id, chargingSessions.stationId))
      .leftJoin(evses, eq(evses.id, chargingSessions.evseId))
      .where(
        and(
          eq(vehicleDepartures.siteId, siteId),
          eq(vehicleDepartures.status, departureStatus),
          departureStatus === 'scheduled'
            ? or(
                // An ad hoc request (no time) shows until it completes.
                eq(vehicleDepartures.adHoc, true),
                and(
                  gte(vehicleDepartures.departureAt, new Date(windowFromMs)),
                  lt(
                    vehicleDepartures.departureAt,
                    new Date(now.getTime() + PLAN_HORIZON_HOURS * HOUR_MS),
                  ),
                ),
              )
            : and(
                gte(
                  sql`COALESCE(${vehicleDepartures.departureAt}, ${vehicleDepartures.createdAt})`,
                  new Date(windowFromMs),
                ),
                lt(
                  sql`COALESCE(${vehicleDepartures.departureAt}, ${vehicleDepartures.createdAt})`,
                  new Date(now.getTime() + PLAN_HORIZON_HOURS * HOUR_MS),
                ),
              ),
        ),
      )
      .orderBy(sql`${vehicleDepartures.departureAt} ASC NULLS FIRST`, asc(vehicleDepartures.id)),
    db
      .select({
        sessionId: chargingSessions.id,
        stationId: chargingSessions.stationId,
        stationOcppId: chargingStations.stationId,
        evseId: evses.evseId,
        driverId: chargingSessions.driverId,
        startedAt: chargingSessions.startedAt,
      })
      .from(chargingSessions)
      .innerJoin(chargingStations, eq(chargingStations.id, chargingSessions.stationId))
      .leftJoin(evses, eq(evses.id, chargingSessions.evseId))
      .where(
        and(
          eq(chargingSessions.siteId, siteId),
          eq(chargingSessions.status, 'active'),
          isNull(chargingSessions.vehicleId),
          // Conformance test stations stay out, as in every operator station list.
          isOperatorStation(),
        ),
      )
      .orderBy(asc(chargingSessions.startedAt), asc(chargingSessions.id)),
  ]);

  const departureAware = config?.strategy === 'departure_aware';
  const planning = enabled && departureAware;
  const notPlanningReason = !enabled
    ? 'fleet_charging_disabled'
    : !departureAware
      ? 'strategy'
      : null;
  const stored = planning ? plan : undefined;

  return {
    planning,
    notPlanningReason,
    bufferMinutes: config?.bufferMinutes ?? 30,
    computedAt: stored?.computedAt ?? null,
    staleAt: stored?.staleAt ?? null,
    trigger: stored?.trigger ?? null,
    slotStarts: asArray(stored?.slotStarts),
    plan: stored?.plan ?? null,
    siteLoadKw: asArray(stored?.siteLoadKw),
    capacityKw: asArray(stored?.capacityKw),
    pricePerKwh: asArray(stored?.pricePerKwh),
    runtimeMs: stored?.runtimeMs ?? null,
    ...(access.departures
      ? {
          departureStatus,
          departures: departureRows.map((r) => ({
            ...withDepotSystem(
              planning && departureStatus === 'scheduled'
                ? departureView(r.departure, access)
                : withoutPlanReadiness(departureView(r.departure, access)),
              r,
              access,
            ),
            requestedChargingPointId: r.requestedChargingPointId,
            siteName: r.siteName,
            siteTimezone: r.siteTimezone,
            station:
              r.boundStationId != null && r.boundStationOcppId != null
                ? {
                    id: r.boundStationId,
                    stationId: r.boundStationOcppId,
                    evseId: r.boundEvseId ?? null,
                  }
                : null,
            vehicle: {
              id: r.departure.vehicleId,
              ...(access.driverIds ? { driverId: r.vehicleDriverId } : {}),
              make: r.vehicleMake,
              model: r.vehicleModel,
              licensePlate: r.vehicleLicensePlate,
              bodyType: r.vehicleBodyType ?? null,
            },
          })),
        }
      : {}),
    // The same reader rule as the stored plan entries: a session id needs sessions:read.
    unidentifiedSessions: sessionRows.map(({ driverId, sessionId, ...row }) => ({
      ...(access.sessionIds ? { sessionId } : {}),
      ...row,
      ...(access.sessionDriverIds ? { driverId } : {}),
    })),
  };
}
