// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import type { DomainEvent } from '@evtivity/lib';
import { createTtlCache } from './ttl-cache.js';

export interface ProjectionLookups {
  resolveStationUuid(stationId: string): Promise<string | null>;
  resolveEvseUuid(
    stationUuid: string,
    ocppEvseId: number,
    bypassCache?: boolean,
  ): Promise<string | null>;
  resolveSiteId(stationUuid: string): Promise<string | null>;
  resolveSiteName(stationUuid: string): Promise<string | null>;
  invalidateStationCache(stationId: string): void;
  getStationUuid(event: DomainEvent): Promise<string | null>;
}

export function createProjectionLookups(sql: postgres.Sql): ProjectionLookups {
  const stationIdCache = createTtlCache<string>();
  const siteIdCache = createTtlCache<string | null>();

  async function resolveSiteId(stationUuid: string): Promise<string | null> {
    const cached = siteIdCache.get(stationUuid);
    if (cached !== undefined) return cached;

    const rows = await sql`SELECT site_id FROM charging_stations WHERE id = ${stationUuid}`;
    const siteId = (rows[0]?.site_id as string | null) ?? null;
    siteIdCache.set(stationUuid, siteId);
    return siteId;
  }

  const siteNameCache = createTtlCache<string | null>();

  async function resolveSiteName(stationUuid: string): Promise<string | null> {
    const cached = siteNameCache.get(stationUuid);
    if (cached !== undefined) return cached;

    const rows = await sql`
      SELECT s.name FROM sites s
      JOIN charging_stations cs ON cs.site_id = s.id
      WHERE cs.id = ${stationUuid}
    `;
    const name = (rows[0]?.name as string | null) ?? null;
    siteNameCache.set(stationUuid, name);
    return name;
  }

  async function resolveStationUuid(stationId: string): Promise<string | null> {
    const cached = stationIdCache.get(stationId);
    if (cached != null) return cached;

    const rows = await sql`SELECT id FROM charging_stations WHERE station_id = ${stationId}`;
    const row = rows[0];
    if (row == null) return null;

    const uuid = row.id as string;
    stationIdCache.set(stationId, uuid);
    return uuid;
  }

  const evseUuidCache = createTtlCache<string | null>();

  async function resolveEvseUuid(
    stationUuid: string,
    ocppEvseId: number,
    bypassCache = false,
  ): Promise<string | null> {
    if (ocppEvseId === 0) return null; // main power meter, not a specific EVSE
    const cacheKey = `${stationUuid}:${String(ocppEvseId)}`;
    if (!bypassCache) {
      const cached = evseUuidCache.get(cacheKey);
      if (cached !== undefined) return cached;
    }

    const rows = await sql`
      SELECT id FROM evses WHERE station_id = ${stationUuid} AND evse_id = ${ocppEvseId}
    `;
    const uuid = (rows[0]?.id as string | null) ?? null;
    // Only a found EVSE is cached. The station lane creates an EVSE from its first
    // StatusNotification, and a TransactionEvent or MeterValues on the transaction
    // lane can be projected before that row exists. Caching the miss would leave
    // every session started on that EVSE within the TTL without its EVSE.
    if (uuid != null) evseUuidCache.set(cacheKey, uuid);
    return uuid;
  }

  function invalidateStationCache(stationId: string): void {
    const uuid = stationIdCache.get(stationId);
    stationIdCache.delete(stationId);
    if (uuid != null) siteIdCache.delete(uuid);
  }

  async function getStationUuid(event: DomainEvent): Promise<string | null> {
    const stationDbId = event.payload.stationDbId as string | undefined;
    if (stationDbId != null) {
      stationIdCache.set(event.aggregateId, stationDbId);
      return stationDbId;
    }
    return resolveStationUuid(event.aggregateId);
  }

  return {
    resolveStationUuid,
    resolveEvseUuid,
    resolveSiteId,
    resolveSiteName,
    invalidateStationCache,
    getStationUuid,
  };
}
