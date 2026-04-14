// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, or, ilike, sql, gte, count, desc } from 'drizzle-orm';
import { db } from '@evtivity/database';
import {
  fleets,
  fleetDrivers,
  fleetStations,
  drivers,
  vehicles,
  chargingStations,
  chargingSessions,
  connectors,
  evses,
  sites,
  pricingGroupFleets,
  pricingGroups,
} from '@evtivity/database';
import type { PaginationParams } from '../lib/pagination.js';

export async function listFleets(params: PaginationParams) {
  const { page, limit, search } = params;
  const offset = (page - 1) * limit;

  let where = undefined;
  if (search) {
    const pattern = `%${search}%`;
    where = or(
      ilike(fleets.id, pattern),
      ilike(fleets.name, pattern),
      ilike(fleets.description, pattern),
    );
  }

  const [data, countRows] = await Promise.all([
    db
      .select({
        id: fleets.id,
        name: fleets.name,
        description: fleets.description,
        createdAt: fleets.createdAt,
        updatedAt: fleets.updatedAt,
        driverCount: sql<number>`count(distinct ${fleetDrivers.id})::int`,
        stationCount: sql<number>`count(distinct ${fleetStations.id})::int`,
      })
      .from(fleets)
      .leftJoin(fleetDrivers, eq(fleetDrivers.fleetId, fleets.id))
      .leftJoin(fleetStations, eq(fleetStations.fleetId, fleets.id))
      .where(where)
      .groupBy(fleets.id)
      .orderBy(desc(fleets.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(fleets)
      .where(where),
  ]);

  return { data, total: countRows[0]?.count ?? 0 };
}

export async function getFleet(id: string) {
  const [fleet] = await db.select().from(fleets).where(eq(fleets.id, id));
  return fleet ?? null;
}

export async function createFleet(data: { name: string; description?: string | undefined }) {
  const [fleet] = await db.insert(fleets).values(data).returning();
  return fleet;
}

export async function updateFleet(
  id: string,
  data: { name?: string | undefined; description?: string | undefined },
) {
  const [fleet] = await db
    .update(fleets)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(fleets.id, id))
    .returning();
  return fleet ?? null;
}

export async function deleteFleet(id: string) {
  const [fleet] = await db.delete(fleets).where(eq(fleets.id, id)).returning();
  return fleet ?? null;
}

export async function getFleetDrivers(fleetId: string, page: number, limit: number) {
  const offset = (page - 1) * limit;

  const [data, countRows] = await Promise.all([
    db
      .select({
        id: drivers.id,
        firstName: drivers.firstName,
        lastName: drivers.lastName,
        email: drivers.email,
        phone: drivers.phone,
        isActive: drivers.isActive,
        createdAt: drivers.createdAt,
      })
      .from(fleetDrivers)
      .innerJoin(drivers, eq(fleetDrivers.driverId, drivers.id))
      .where(eq(fleetDrivers.fleetId, fleetId))
      .orderBy(drivers.firstName)
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(fleetDrivers)
      .where(eq(fleetDrivers.fleetId, fleetId)),
  ]);

  return { data, total: countRows[0]?.count ?? 0 };
}

export async function addDriverToFleet(fleetId: string, driverId: string) {
  const [record] = await db.insert(fleetDrivers).values({ fleetId, driverId }).returning();
  return record;
}

export async function removeDriverFromFleet(fleetId: string, driverId: string) {
  const [record] = await db
    .delete(fleetDrivers)
    .where(and(eq(fleetDrivers.fleetId, fleetId), eq(fleetDrivers.driverId, driverId)))
    .returning();
  return record ?? null;
}

export async function getFleetStations(fleetId: string) {
  const derivedStatus = sql<string>`CASE
    WHEN COUNT(${connectors.id}) FILTER (WHERE ${connectors.status} = 'occupied') > 0 THEN 'charging'
    WHEN COUNT(${connectors.id}) FILTER (WHERE ${connectors.status} = 'reserved') > 0 THEN 'reserved'
    WHEN COUNT(${connectors.id}) FILTER (WHERE ${connectors.status} = 'faulted') > 0 THEN 'faulted'
    WHEN COUNT(${connectors.id}) = 0 THEN 'unknown'
    WHEN COUNT(${connectors.id}) FILTER (WHERE ${connectors.status} = 'available') = COUNT(${connectors.id}) THEN 'available'
    ELSE 'unavailable'
  END`;

  return db
    .select({
      id: chargingStations.id,
      stationId: chargingStations.stationId,
      siteId: chargingStations.siteId,
      model: chargingStations.model,
      securityProfile: chargingStations.securityProfile,
      ocppProtocol: chargingStations.ocppProtocol,
      status: derivedStatus,
      connectorCount: sql<number>`COUNT(${connectors.id})::int`,
      connectorTypes: sql<
        string[]
      >`array_agg(DISTINCT ${connectors.connectorType}) FILTER (WHERE ${connectors.connectorType} IS NOT NULL)`,
      isOnline: chargingStations.isOnline,
      lastHeartbeat: chargingStations.lastHeartbeat,
    })
    .from(fleetStations)
    .innerJoin(chargingStations, eq(fleetStations.stationId, chargingStations.id))
    .leftJoin(evses, eq(evses.stationId, chargingStations.id))
    .leftJoin(connectors, eq(connectors.evseId, evses.id))
    .where(eq(fleetStations.fleetId, fleetId))
    .groupBy(chargingStations.id);
}

export async function addStationToFleet(fleetId: string, stationId: string) {
  const [record] = await db.insert(fleetStations).values({ fleetId, stationId }).returning();
  return record;
}

export async function removeStationFromFleet(fleetId: string, stationId: string) {
  const [record] = await db
    .delete(fleetStations)
    .where(and(eq(fleetStations.fleetId, fleetId), eq(fleetStations.stationId, stationId)))
    .returning();
  return record ?? null;
}

export async function getFleetVehicles(fleetId: string, page: number, limit: number) {
  const offset = (page - 1) * limit;

  const [data, countRows] = await Promise.all([
    db
      .select({
        id: vehicles.id,
        driverId: vehicles.driverId,
        driverName: sql<string>`${drivers.firstName} || ' ' || ${drivers.lastName}`,
        make: vehicles.make,
        model: vehicles.model,
        year: vehicles.year,
        vin: vehicles.vin,
        licensePlate: vehicles.licensePlate,
      })
      .from(fleetDrivers)
      .innerJoin(drivers, eq(fleetDrivers.driverId, drivers.id))
      .innerJoin(vehicles, eq(vehicles.driverId, drivers.id))
      .where(eq(fleetDrivers.fleetId, fleetId))
      .orderBy(drivers.firstName)
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(fleetDrivers)
      .innerJoin(vehicles, eq(vehicles.driverId, fleetDrivers.driverId))
      .where(eq(fleetDrivers.fleetId, fleetId)),
  ]);

  return { data, total: countRows[0]?.count ?? 0 };
}

export async function searchAvailableVehicles(fleetId: string, search: string, limit: number) {
  const fleetDriverSubquery = sql`SELECT driver_id FROM fleet_drivers WHERE fleet_id = ${fleetId}`;
  const pattern = `%${search}%`;

  return db
    .select({
      id: vehicles.id,
      driverId: vehicles.driverId,
      driverName: sql<string>`${drivers.firstName} || ' ' || ${drivers.lastName}`,
      make: vehicles.make,
      model: vehicles.model,
      year: vehicles.year,
      vin: vehicles.vin,
      licensePlate: vehicles.licensePlate,
    })
    .from(vehicles)
    .innerJoin(drivers, eq(vehicles.driverId, drivers.id))
    .where(
      and(
        sql`${vehicles.driverId} NOT IN (${fleetDriverSubquery})`,
        or(
          ilike(vehicles.make, pattern),
          ilike(vehicles.model, pattern),
          ilike(vehicles.vin, pattern),
          ilike(vehicles.licensePlate, pattern),
          ilike(drivers.firstName, pattern),
          ilike(drivers.lastName, pattern),
        ),
      ),
    )
    .orderBy(drivers.firstName)
    .limit(limit);
}

export async function getFleetSessions(fleetId: string, page: number, limit: number) {
  const offset = (page - 1) * limit;
  const driverFilter = sql`${chargingSessions.driverId} IN (select driver_id from fleet_drivers where fleet_id = ${fleetId})`;

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: chargingSessions.id,
        stationId: chargingSessions.stationId,
        stationName: chargingStations.stationId,
        siteName: sites.name,
        transactionId: chargingSessions.transactionId,
        status: chargingSessions.status,
        startedAt: chargingSessions.startedAt,
        endedAt: chargingSessions.endedAt,
        idleStartedAt: chargingSessions.idleStartedAt,
        energyDeliveredWh: chargingSessions.energyDeliveredWh,
        currentCostCents: chargingSessions.currentCostCents,
        finalCostCents: chargingSessions.finalCostCents,
        currency: chargingSessions.currency,
      })
      .from(chargingSessions)
      .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
      .leftJoin(sites, eq(chargingStations.siteId, sites.id))
      .where(driverFilter)
      .orderBy(desc(chargingSessions.startedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(chargingSessions)
      .where(driverFilter),
  ]);

  return { data: rows, total: countRows[0]?.count ?? 0 };
}

export async function getFleetMetrics(fleetId: string, months: number) {
  const since = new Date();
  since.setMonth(since.getMonth() - months);

  const driverFilter = sql`${chargingSessions.driverId} IN (select driver_id from fleet_drivers where fleet_id = ${fleetId})`;

  const [sessionStats] = await db
    .select({
      totalSessions: count(),
      completedSessions: sql<number>`count(*) filter (where ${chargingSessions.status} = 'completed')`,
      faultedSessions: sql<number>`count(*) filter (where ${chargingSessions.status} = 'faulted')`,
      totalEnergyWh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric), 0)`,
      avgDurationMinutes: sql<number>`coalesce(avg(extract(epoch from (${chargingSessions.endedAt} - ${chargingSessions.startedAt})) / 60) filter (where ${chargingSessions.endedAt} is not null), 0)`,
      activeDrivers: sql<number>`count(distinct ${chargingSessions.driverId})`,
    })
    .from(chargingSessions)
    .where(and(driverFilter, gte(chargingSessions.startedAt, since)));

  const [driverStats] = await db
    .select({
      totalDrivers: count(),
    })
    .from(fleetDrivers)
    .where(eq(fleetDrivers.fleetId, fleetId));

  const [vehicleStats] = await db
    .select({
      totalVehicles: sql<number>`count(*)::int`,
    })
    .from(fleetDrivers)
    .innerJoin(vehicles, eq(vehicles.driverId, fleetDrivers.driverId))
    .where(eq(fleetDrivers.fleetId, fleetId));

  const total = sessionStats?.totalSessions ?? 0;
  const completed = sessionStats?.completedSessions ?? 0;

  return {
    totalSessions: total,
    completedSessions: completed,
    faultedSessions: sessionStats?.faultedSessions ?? 0,
    sessionSuccessPercent: total > 0 ? Math.round((completed / total) * 100) : 100,
    totalEnergyWh: sessionStats?.totalEnergyWh ?? 0,
    avgSessionDurationMinutes: Math.round(sessionStats?.avgDurationMinutes ?? 0),
    activeDrivers: sessionStats?.activeDrivers ?? 0,
    totalDrivers: driverStats?.totalDrivers ?? 0,
    totalVehicles: vehicleStats?.totalVehicles ?? 0,
    periodMonths: months,
  };
}

export async function getFleetEnergyHistory(fleetId: string, days: number) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const driverFilter = sql`${chargingSessions.driverId} IN (select driver_id from fleet_drivers where fleet_id = ${fleetId})`;

  const rows = await db
    .select({
      date: sql<string>`date_trunc('day', ${chargingSessions.startedAt} AT TIME ZONE 'UTC')::date::text`,
      energyWh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric), 0)`,
    })
    .from(chargingSessions)
    .where(and(driverFilter, gte(chargingSessions.startedAt, since)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  return rows.map((r) => ({ date: r.date, energyWh: r.energyWh }));
}

export async function getFleetPricingGroup(fleetId: string) {
  const rows = await db
    .select({
      id: pricingGroups.id,
      name: pricingGroups.name,
      description: pricingGroups.description,
      isDefault: pricingGroups.isDefault,
      tariffCount: sql<number>`(select count(*)::int from tariffs where tariffs.pricing_group_id = ${pricingGroups.id})`,
    })
    .from(pricingGroupFleets)
    .innerJoin(pricingGroups, eq(pricingGroupFleets.pricingGroupId, pricingGroups.id))
    .where(eq(pricingGroupFleets.fleetId, fleetId))
    .limit(1);
  return rows[0] ?? null;
}

export async function addPricingGroupToFleet(fleetId: string, pricingGroupId: string) {
  const [record] = await db
    .insert(pricingGroupFleets)
    .values({ fleetId, pricingGroupId })
    .onConflictDoUpdate({
      target: [pricingGroupFleets.fleetId],
      set: { pricingGroupId, createdAt: new Date() },
    })
    .returning();
  return record;
}

export async function removePricingGroupFromFleet(fleetId: string, pricingGroupId: string) {
  const [record] = await db
    .delete(pricingGroupFleets)
    .where(
      and(
        eq(pricingGroupFleets.fleetId, fleetId),
        eq(pricingGroupFleets.pricingGroupId, pricingGroupId),
      ),
    )
    .returning();
  return record ?? null;
}
