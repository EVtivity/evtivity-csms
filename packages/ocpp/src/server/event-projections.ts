// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import postgres from 'postgres';
import type { EventBus, DomainEvent, PubSubClient, ConnectionRegistry } from '@evtivity/lib';
import { config } from '../lib/config.js';
import {
  isRoamingEnabled,
  getIdlingGracePeriodMinutes,
  isSplitBillingEnabled,
  getOfflineCommandTtlHours,
  getMeterValueIntervalSeconds,
  getClockAlignedIntervalSeconds,
  getSampledMeasurands,
  getAlignedMeasurands,
  getTxEndedMeasurands,
} from '@evtivity/database';
import {
  calculateSessionCost,
  calculateSplitSessionCost,
  resolveActiveTariff,
  generateId,
  createLogger,
  calculateCo2AvoidedKg,
} from '@evtivity/lib';
import type {
  TariffInput,
  TariffRestrictions,
  TariffWithRestrictions,
  TariffSegment,
} from '@evtivity/lib';
import crypto from 'node:crypto';
import {
  dispatchOcppNotification,
  dispatchDriverNotification,
  dispatchSystemNotification,
  ALL_TEMPLATES_DIRS,
} from './notification-dispatcher.js';
import { TransactionBuffer } from './transaction-buffer.js';

const OCPP_STATUS_MAP: Record<string, string> = {
  // OCPP 2.1 connector statuses
  Available: 'available',
  Occupied: 'occupied',
  Reserved: 'reserved',
  Unavailable: 'unavailable',
  Faulted: 'faulted',
  // OCPP 1.6 connector statuses (stored as raw OCPP terms)
  Charging: 'charging',
  Preparing: 'preparing',
  SuspendedEV: 'suspended_ev',
  SuspendedEVSE: 'suspended_evse',
  Finishing: 'finishing',
  EVConnected: 'ev_connected',
  Idle: 'idle',
  Discharging: 'discharging',
};

const CHARGING_STATE_TO_STATUS: Record<string, string> = {
  Charging: 'charging',
  EVConnected: 'ev_connected',
  SuspendedEV: 'suspended_ev',
  SuspendedEVSE: 'suspended_evse',
  Idle: 'idle',
  Discharging: 'discharging',
};

function getString(obj: Record<string, unknown>, key: string): string | null {
  const val = obj[key];
  return typeof val === 'string' ? val : null;
}

export interface ProjectionOptions {
  registry?: ConnectionRegistry;
  instanceId?: string;
}

export function registerProjections(
  eventBus: EventBus,
  databaseUrl: string,
  pubsub: PubSubClient,
  options?: ProjectionOptions,
): void {
  const registry = options?.registry ?? null;
  const instanceId = options?.instanceId ?? null;
  // Only the primary pod runs periodic cleanup tasks to avoid duplicate work.
  // No instanceId (single-pod mode) or instanceId ending in '-0' is primary.
  const isPrimary = instanceId == null || instanceId.endsWith('-0');
  const sql = postgres(databaseUrl);
  const logger = createLogger('event-projections');

  const CACHE_MAX_SIZE = 5000;
  const CACHE_TTL_MS = 300_000; // 5 minutes

  const CACHE_CLEANUP_INTERVAL_MS = 60_000; // 1 minute

  function createTtlCache<V>(): {
    get: (key: string) => V | undefined;
    set: (key: string, value: V) => void;
    delete: (key: string) => void;
  } {
    const store = new Map<string, { value: V; expiresAt: number }>();

    // Periodic sweep removes all expired entries. This is the primary eviction
    // mechanism. The get() lazy-delete and set() overflow-delete are secondary.
    setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of store) {
        if (now > entry.expiresAt) store.delete(key);
      }
    }, CACHE_CLEANUP_INTERVAL_MS);

    return {
      get(key: string): V | undefined {
        const entry = store.get(key);
        if (entry == null) return undefined;
        if (Date.now() > entry.expiresAt) {
          store.delete(key);
          return undefined;
        }
        return entry.value;
      },
      set(key: string, value: V): void {
        // Only evict when inserting a new key (not updating an existing one).
        // The periodic sweep handles bulk expired-entry cleanup. This is just a
        // safety valve so the cache never exceeds CACHE_MAX_SIZE between sweeps.
        if (!store.has(key) && store.size >= CACHE_MAX_SIZE) {
          const firstKey = store.keys().next().value;
          if (firstKey != null) store.delete(firstKey);
        }
        store.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
      },
      delete(key: string): void {
        store.delete(key);
      },
    };
  }

  const stationIdCache = createTtlCache<string>();
  const siteIdCache = createTtlCache<string | null>();
  const txBuffer = new TransactionBuffer();

  const SESSION_UPDATE_THROTTLE_MS = 15 * 60 * 1000;

  // The EventBus fires handlers with `void Promise.allSettled(...)`, so in-flight
  // promises accumulate without backpressure. With 2000+ stations sending MeterValues
  // every 10s, that is ~200 events/sec. If DB queries slow down, promises pile up
  // until OOM.
  //
  // Fix: per-station sequential queue. Events from the same station are processed
  // one at a time in order. Different stations run in parallel. This bounds total
  // concurrency to the number of active stations and preserves event ordering.
  // Each aggregate ID (station or transaction) gets a sequential promise chain.
  // The Map stores the tail promise and last activity timestamp per station.
  // A periodic cleanup removes entries for stations inactive for 10+ minutes.
  const stationQueues = new Map<string, { promise: Promise<void>; lastActivity: number }>();

  // Clean up stale station queue entries every 5 minutes
  const QUEUE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
  const QUEUE_STALE_THRESHOLD_MS = 10 * 60 * 1000;
  const queueCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of stationQueues) {
      if (now - entry.lastActivity >= QUEUE_STALE_THRESHOLD_MS) {
        stationQueues.delete(id);
      }
    }
  }, QUEUE_CLEANUP_INTERVAL_MS);
  queueCleanupTimer.unref();

  function enqueueForStation(id: string, work: () => Promise<void>): Promise<void> {
    const prev = stationQueues.get(id)?.promise ?? Promise.resolve();
    const next = prev.then(work, work); // run even if previous failed
    stationQueues.set(id, { promise: next, lastActivity: Date.now() });
    return next;
  }

  function safeSubscribe(eventType: string, handler: (event: DomainEvent) => Promise<void>): void {
    eventBus.subscribe(eventType, (event: DomainEvent) => {
      return enqueueForStation(event.aggregateId, async () => {
        try {
          await handler(event);
        } catch (err) {
          logger.error(
            {
              eventType,
              stationId: event.aggregateId,
              error: err instanceof Error ? err.message : String(err),
            },
            'Event projection failed',
          );
        }
      });
    });
  }

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

  // Dispatch IdlingStarted notification for both driver and guest sessions.
  // Used by TransactionEvent Updated (chargingState) and StatusNotification (1.6 fallback).
  async function dispatchIdlingNotification(
    sessionId: string,
    stationId: string,
    transactionId: string,
  ): Promise<void> {
    const idleSession = await sql`
      SELECT driver_id, idle_started_at, tariff_idle_fee_price_per_minute, currency
      FROM charging_sessions WHERE id = ${sessionId} AND idle_started_at IS NOT NULL
    `;
    const idleRow = idleSession[0];
    if (idleRow == null) return;

    const stationUuid = await resolveStationUuid(stationId);
    const gracePeriodMinutes = await getIdlingGracePeriodMinutes();
    const idleFeeRate = idleRow.tariff_idle_fee_price_per_minute as string | null;
    const idleSiteName = stationUuid != null ? await resolveSiteName(stationUuid) : null;

    const templateVars = {
      siteName: idleSiteName ?? '',
      stationId,
      transactionId,
      idleStartedAt: idleRow.idle_started_at as string,
      gracePeriodMinutes,
      idleFeePricePerMinute: idleFeeRate ?? '0',
      currency: (idleRow.currency as string | null) ?? 'USD',
    };

    if (idleRow.driver_id != null) {
      void dispatchDriverNotification(
        sql,
        'session.IdlingStarted',
        idleRow.driver_id as string,
        templateVars,
        ALL_TEMPLATES_DIRS,
        pubsub,
      );
    } else {
      // Guest session: check for guest email
      const guestRows = await sql`
        SELECT guest_email FROM guest_sessions
        WHERE charging_session_id = ${sessionId} AND guest_email != ''
        LIMIT 1
      `;
      const guestRow = guestRows[0];
      if (guestRow != null) {
        void dispatchSystemNotification(
          sql,
          'session.IdlingStarted',
          { email: guestRow.guest_email as string },
          templateVars,
          ALL_TEMPLATES_DIRS,
        );
      }
    }
  }

  async function notifyChange(
    eventType: string,
    stationId: string | null,
    siteId: string | null,
    sessionId?: string | null,
  ): Promise<void> {
    try {
      const payload = JSON.stringify({
        eventType,
        stationId,
        siteId,
        sessionId: sessionId ?? null,
      });
      await pubsub.publish('csms_events', payload);
    } catch {
      // Non-critical: SSE notification failure should not block event processing
    }
  }

  async function notifyOcpiPush(
    type: 'location' | 'session' | 'cdr' | 'tariff',
    ids: { siteId?: string; sessionId?: string; cdrId?: string; tariffId?: string },
  ): Promise<void> {
    try {
      if (!(await isRoamingEnabled())) return;
      const payload = JSON.stringify({ type, ...ids });
      await pubsub.publish('ocpi_push', payload);
    } catch {
      // Non-critical: OCPI push failure should not block event processing
    }
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
    evseUuidCache.set(cacheKey, uuid);
    return uuid;
  }

  async function resolveActiveSessionId(
    stationUuid: string,
    evseUuid: string | null,
    transactionId: string | undefined,
    allowCompleted = false,
  ): Promise<string | null> {
    // 1. By transactionId (1.6 path)
    if (transactionId != null) {
      const rows = await sql`
        SELECT id FROM charging_sessions
        WHERE transaction_id = ${transactionId} AND status = 'active'
        LIMIT 1
      `;
      if (rows[0] != null) return rows[0].id as string;

      // When allowCompleted is true, also match completed sessions.
      // This handles meter values from StopTransaction transactionData
      // where the session was already ended before the MeterValues event.
      if (allowCompleted) {
        const completedRows = await sql`
          SELECT id FROM charging_sessions
          WHERE transaction_id = ${transactionId} AND status IN ('active', 'completed')
          ORDER BY started_at DESC
          LIMIT 1
        `;
        if (completedRows[0] != null) return completedRows[0].id as string;
      }
    }
    // 2. By EVSE (newest first to avoid stale sessions)
    if (evseUuid != null) {
      const rows = await sql`
        SELECT id FROM charging_sessions
        WHERE station_id = ${stationUuid} AND evse_id = ${evseUuid} AND status = 'active'
        ORDER BY started_at DESC
        LIMIT 1
      `;
      if (rows[0] != null) return rows[0].id as string;
    }
    // 3. Fallback: any active session on this station (newest first)
    const rows = await sql`
      SELECT id FROM charging_sessions
      WHERE station_id = ${stationUuid} AND status = 'active'
      ORDER BY started_at DESC
      LIMIT 1
    `;
    return (rows[0]?.id as string | null) ?? null;
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

  function getSessionId(rows: postgres.RowList<postgres.Row[]>): string | null {
    const row = rows[0];
    if (row == null) return null;
    return row.id as string;
  }

  // Cached holiday loader (60s TTL)
  let holidayCache: { dates: Date[]; loadedAt: number } | null = null;
  const HOLIDAY_CACHE_TTL_MS = 60_000;

  async function loadHolidays(): Promise<Date[]> {
    const now = Date.now();
    if (holidayCache != null && now - holidayCache.loadedAt < HOLIDAY_CACHE_TTL_MS) {
      return holidayCache.dates;
    }
    const rows = await sql`SELECT date FROM pricing_holidays`;
    const dates = rows.map((r) => new Date(r.date as string));
    holidayCache = { dates, loadedAt: now };
    return dates;
  }

  // ---- Payment simulation helpers (used in Started/Ended handlers) ----

  function formatCostFromCents(cents: number | null, currency: string): string {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
      }).format((cents ?? 0) / 100);
    } catch {
      return `${((cents ?? 0) / 100).toFixed(2)} ${currency}`;
    }
  }

  function isSimulatedCustomer(stripeCustomerId: string): boolean {
    return stripeCustomerId.startsWith('cus_sim_');
  }

  function isSimulatedIntent(stripePaymentIntentId: string): boolean {
    return stripePaymentIntentId.startsWith('pi_sim_');
  }

  /** Returns true 20% of the time. Used to simulate realistic payment failure rates. */
  function shouldSimulateFailure(): boolean {
    return Math.random() < 0.2;
  }

  /**
   * Checks if the active tariff for a station resolves to free (all price components zero/null).
   * Uses the same group resolution priority as resolveTariffGroup() in tariff.service.ts:
   * driver-specific > fleet > station > site > default.
   * Returns true if free, false if not free or if no tariff is found (safe default = charge).
   *
   * See also: resolveTariff() in packages/api/src/services/tariff.service.ts which provides
   * full tariff resolution with time-of-day support. This inline CTE is intentionally simpler
   * to avoid an API package dependency from the OCPP package.
   */
  async function isTariffFreeForStation(
    stationId: string,
    driverId: string | null,
  ): Promise<boolean> {
    const rows = await sql`
      WITH driver_group AS (
        SELECT pgd.pricing_group_id AS id, 1 AS priority
        FROM pricing_group_drivers pgd
        WHERE pgd.driver_id = ${driverId ?? ''}
        LIMIT 1
      ),
      fleet_group AS (
        SELECT pgf.pricing_group_id AS id, 2 AS priority
        FROM pricing_group_fleets pgf
        JOIN fleet_drivers fd ON fd.fleet_id = pgf.fleet_id
        WHERE fd.driver_id = ${driverId ?? ''}
        LIMIT 1
      ),
      station_group AS (
        SELECT pgs.pricing_group_id AS id, 3 AS priority
        FROM pricing_group_stations pgs
        WHERE pgs.station_id = ${stationId}
        LIMIT 1
      ),
      site_group AS (
        SELECT pgsit.pricing_group_id AS id, 4 AS priority
        FROM pricing_group_sites pgsit
        JOIN charging_stations cs ON cs.site_id = pgsit.site_id
        WHERE cs.id = ${stationId}
        LIMIT 1
      ),
      default_group AS (
        SELECT pg.id, 5 AS priority
        FROM pricing_groups pg
        WHERE pg.is_default = true
        LIMIT 1
      ),
      resolved AS (
        SELECT id, priority FROM (
          SELECT id, priority FROM driver_group
          UNION ALL SELECT id, priority FROM fleet_group
          UNION ALL SELECT id, priority FROM station_group
          UNION ALL SELECT id, priority FROM site_group
          UNION ALL SELECT id, priority FROM default_group
        ) groups
        ORDER BY priority
        LIMIT 1
      )
      SELECT
        (COALESCE(t.price_per_kwh, '0') = '0' AND
         COALESCE(t.price_per_minute, '0') = '0' AND
         COALESCE(t.price_per_session, '0') = '0' AND
         COALESCE(t.idle_fee_price_per_minute, '0') = '0') AS is_free
      FROM tariffs t
      JOIN resolved r ON t.pricing_group_id = r.id
      WHERE t.is_active = true AND t.is_default = true
      LIMIT 1
    `;
    const row = rows[0];
    if (row == null) return false; // No tariff found -- not free
    return row.is_free as boolean;
  }

  async function resolvePricingGroupId(
    stationUuid: string,
    driverUuid: string | null,
  ): Promise<string | null> {
    // Priority 1: Driver-specific pricing group (applies at all stations)
    if (driverUuid != null) {
      const rows = await sql`
        SELECT pg.id
        FROM pricing_group_drivers pgd
        JOIN pricing_groups pg ON pgd.pricing_group_id = pg.id
        WHERE pgd.driver_id = ${driverUuid}
        LIMIT 1
      `;
      if (rows[0] != null) return rows[0].id as string;
    }

    // Priority 2: Fleet-specific pricing group (applies at all stations)
    if (driverUuid != null) {
      const rows = await sql`
        SELECT pg.id
        FROM fleet_drivers fd
        JOIN pricing_group_fleets pgf ON pgf.fleet_id = fd.fleet_id
        JOIN pricing_groups pg ON pgf.pricing_group_id = pg.id
        WHERE fd.driver_id = ${driverUuid}
        LIMIT 1
      `;
      if (rows[0] != null) return rows[0].id as string;
    }

    // Priority 3: Station pricing group
    const stationRows = await sql`
      SELECT pg.id
      FROM pricing_group_stations pgs
      JOIN pricing_groups pg ON pgs.pricing_group_id = pg.id
      WHERE pgs.station_id = ${stationUuid}
      LIMIT 1
    `;
    if (stationRows[0] != null) return stationRows[0].id as string;

    // Priority 4: Site-specific pricing group
    const siteRows = await sql`
      SELECT pg.id
      FROM charging_stations cs
      JOIN pricing_group_sites pgsit ON pgsit.site_id = cs.site_id
      JOIN pricing_groups pg ON pgsit.pricing_group_id = pg.id
      WHERE cs.id = ${stationUuid}
        AND cs.site_id IS NOT NULL
      LIMIT 1
    `;
    if (siteRows[0] != null) return siteRows[0].id as string;

    // Priority 5: Default pricing group
    const defaultRows = await sql`
      SELECT pg.id FROM pricing_groups pg WHERE pg.is_default = true LIMIT 1
    `;
    if (defaultRows[0] != null) return defaultRows[0].id as string;

    return null;
  }

  async function resolveTariffForStation(
    stationUuid: string,
    driverUuid: string | null,
  ): Promise<(TariffInput & { id: string }) | null> {
    const groupId = await resolvePricingGroupId(stationUuid, driverUuid);
    if (groupId == null) return null;

    const rows = await sql`
      SELECT id, currency, price_per_kwh, price_per_minute, price_per_session,
             idle_fee_price_per_minute, reservation_fee_per_minute, tax_rate,
             restrictions, priority, is_default
      FROM tariffs
      WHERE pricing_group_id = ${groupId} AND is_active = true
    `;
    if (rows.length === 0) return null;

    const tariffs: TariffWithRestrictions[] = rows.map((r) => ({
      id: r.id as string,
      currency: r.currency as string,
      pricePerKwh: r.price_per_kwh as string | null,
      pricePerMinute: r.price_per_minute as string | null,
      pricePerSession: r.price_per_session as string | null,
      idleFeePricePerMinute: r.idle_fee_price_per_minute as string | null,
      reservationFeePerMinute: r.reservation_fee_per_minute as string | null,
      taxRate: r.tax_rate as string | null,
      restrictions: r.restrictions as TariffRestrictions | null,
      priority: r.priority as number,
      isDefault: r.is_default as boolean,
    }));

    const holidays = await loadHolidays();
    const resolved = resolveActiveTariff(tariffs, new Date(), holidays, 0);
    if (resolved == null) return null;

    return {
      id: resolved.id,
      currency: resolved.currency,
      pricePerKwh: resolved.pricePerKwh,
      pricePerMinute: resolved.pricePerMinute,
      pricePerSession: resolved.pricePerSession,
      idleFeePricePerMinute: resolved.idleFeePricePerMinute,
      reservationFeePerMinute: resolved.reservationFeePerMinute,
      taxRate: resolved.taxRate,
    };
  }

  safeSubscribe('station.Connected', async (event: DomainEvent) => {
    const stationUuid = await getStationUuid(event);
    if (stationUuid == null) return;

    const ocppProtocol = (event.payload as { ocppProtocol?: string }).ocppProtocol ?? null;

    await sql`
      UPDATE charging_stations
      SET is_online = true, last_heartbeat = now(), updated_at = now(),
          ocpp_protocol = COALESCE(${ocppProtocol}, ocpp_protocol)
      WHERE id = ${stationUuid}
    `;

    const connLog = await sql`
      INSERT INTO connection_logs (station_id, event, protocol)
      SELECT ${stationUuid}, 'connected', ${ocppProtocol}
      WHERE EXISTS (SELECT 1 FROM charging_stations WHERE id = ${stationUuid})
    `;
    if (connLog.count === 0) {
      invalidateStationCache(event.aggregateId);
      return;
    }

    const evseRows = await sql`SELECT evse_id FROM evses WHERE station_id = ${stationUuid}`;
    for (const row of evseRows) {
      await sql`
        INSERT INTO port_status_log (station_id, evse_id, previous_status, new_status, timestamp)
        VALUES (${stationUuid}, ${row.evse_id as number}, 'unavailable', 'available', now())
      `;
    }

    const siteId = await resolveSiteId(stationUuid);
    await notifyChange('station.status', stationUuid, siteId);
    if (siteId != null) {
      await notifyOcpiPush('location', { siteId });
    }

    // Drain offline command queue for this station
    const stationOcppId = event.aggregateId;
    try {
      const pendingCommands = await sql`
        SELECT id, command_id, action, payload, version
        FROM offline_command_queue
        WHERE station_id = ${stationOcppId} AND status = 'pending' AND expires_at > now()
        ORDER BY created_at ASC
      `;
      for (const cmd of pendingCommands) {
        const queuedPayload = JSON.stringify({
          commandId: cmd.command_id as string,
          stationId: stationOcppId,
          action: cmd.action as string,
          payload: cmd.payload as Record<string, unknown>,
          version: (cmd.version as string | undefined) ?? undefined,
        });
        await pubsub.publish('ocpp_commands', queuedPayload);
        await sql`
          UPDATE offline_command_queue SET status = 'sent', sent_at = now()
          WHERE id = ${cmd.id as number}
        `;
      }
    } catch {
      // Non-critical: queue drain failure should not block connection handling
    }
  });

  safeSubscribe('station.Disconnected', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    await sql`
      UPDATE charging_stations
      SET is_online = false, updated_at = now()
      WHERE id = ${stationUuid}
    `;

    const connLog = await sql`
      INSERT INTO connection_logs (station_id, event)
      SELECT ${stationUuid}, 'disconnected'
      WHERE EXISTS (SELECT 1 FROM charging_stations WHERE id = ${stationUuid})
    `;
    if (connLog.count === 0) {
      invalidateStationCache(event.aggregateId);
      return;
    }

    const connectorRows = await sql`
      SELECT e.evse_id, c.connector_id, c.status
      FROM connectors c
      INNER JOIN evses e ON c.evse_id = e.id
      WHERE e.station_id = ${stationUuid}
    `;
    for (const row of connectorRows) {
      await sql`
        INSERT INTO port_status_log (station_id, evse_id, connector_id, previous_status, new_status, timestamp)
        VALUES (${stationUuid}, ${row.evse_id as number}, ${row.connector_id as number}, ${row.status as string}, 'unavailable', now())
      `;
    }

    const siteId = await resolveSiteId(stationUuid);
    await notifyChange('station.status', stationUuid, siteId);
    if (siteId != null) {
      await notifyOcpiPush('location', { siteId });
    }

    // Notify drivers with active or in_use reservations on the disconnected station
    const stationOcppId = event.aggregateId;
    try {
      const affectedReservations = await sql`
        SELECT id, driver_id FROM reservations
        WHERE station_id = ${stationUuid}
          AND status IN ('active', 'in_use')
      `;
      for (const reservation of affectedReservations) {
        if (reservation.driver_id == null) continue;
        void dispatchDriverNotification(
          sql,
          'reservation.StationFaulted',
          reservation.driver_id as string,
          {
            reservationId: reservation.id as string,
            stationId: stationOcppId,
          },
          ALL_TEMPLATES_DIRS,
          pubsub,
        ).catch((err: unknown) => {
          logger.error(
            { err, reservationId: reservation.id },
            'reservation.StationFaulted notification failed',
          );
        });
      }
    } catch (err) {
      logger.error({ err }, 'failed to query reservations for station fault notification');
    }
  });

  safeSubscribe('ocpp.BootNotification', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const firmwareVersion = getString(payload, 'firmwareVersion');
    const model = getString(payload, 'model');
    const serialNumber = getString(payload, 'serialNumber');
    const iccid = getString(payload, 'iccid');
    const imsi = getString(payload, 'imsi');

    // Check if station is pending onboarding
    const [current] = await sql`
      SELECT onboarding_status FROM charging_stations WHERE id = ${stationUuid}
    `;

    if (current?.onboarding_status === 'accepted') {
      await sql`
        UPDATE charging_stations
        SET
          firmware_version = ${firmwareVersion},
          model = ${model},
          serial_number = ${serialNumber},
          iccid = COALESCE(${iccid}, iccid),
          imsi = COALESCE(${imsi}, imsi),
          availability = 'available',
          is_online = true,
          updated_at = now()
        WHERE id = ${stationUuid}
      `;
    } else {
      // Pending or blocked: update hardware info and online status but do not touch availability
      await sql`
        UPDATE charging_stations
        SET
          firmware_version = ${firmwareVersion},
          model = ${model},
          serial_number = ${serialNumber},
          iccid = COALESCE(${iccid}, iccid),
          imsi = COALESCE(${imsi}, imsi),
          is_online = true,
          updated_at = now()
        WHERE id = ${stationUuid}
      `;
    }

    const siteId = await resolveSiteId(stationUuid);
    await notifyChange('station.status', stationUuid, siteId);

    // Push OCPP configuration to station after boot
    try {
      const meterValueInterval = await getMeterValueIntervalSeconds();
      const clockAlignedInterval = await getClockAlignedIntervalSeconds();
      const sampledMeasurands = await getSampledMeasurands();
      const alignedMeasurands = await getAlignedMeasurands();
      const txEndedMeasurands = await getTxEndedMeasurands();
      const stationOcppId = event.aggregateId;

      // Look up the station's OCPP protocol version
      const [stationRow] = await sql`
        SELECT ocpp_protocol FROM charging_stations WHERE id = ${stationUuid}
      `;
      const protocol = stationRow?.ocpp_protocol as string | null;

      const publishCmd = (action: string, payload: Record<string, unknown>, version: string) =>
        pubsub.publish(
          'ocpp_commands',
          JSON.stringify({
            commandId: crypto.randomUUID(),
            stationId: stationOcppId,
            action,
            payload,
            version,
          }),
        );

      // Measurands valid only in OCPP 1.6 (not in 2.1 MeasurandEnumType)
      const OCPP_16_ONLY = new Set(['Temperature', 'RPM']);
      const filter21 = (csv: string) =>
        csv
          .split(',')
          .filter((m) => !OCPP_16_ONLY.has(m.trim()))
          .join(',');

      if (protocol === 'ocpp2.1') {
        // OCPP 2.1: SetVariables (one command per variable)
        if (meterValueInterval > 0) {
          await publishCmd(
            'SetVariables',
            {
              setVariableData: [
                {
                  component: { name: 'SampledDataCtrlr' },
                  variable: { name: 'TxUpdatedInterval' },
                  attributeValue: String(meterValueInterval),
                },
              ],
            },
            'ocpp2.1',
          );
        }
        if (sampledMeasurands) {
          await publishCmd(
            'SetVariables',
            {
              setVariableData: [
                {
                  component: { name: 'SampledDataCtrlr' },
                  variable: { name: 'TxUpdatedMeasurands' },
                  attributeValue: filter21(sampledMeasurands),
                },
              ],
            },
            'ocpp2.1',
          );
        }
        if (txEndedMeasurands) {
          await publishCmd(
            'SetVariables',
            {
              setVariableData: [
                {
                  component: { name: 'SampledDataCtrlr' },
                  variable: { name: 'TxEndedMeasurands' },
                  attributeValue: filter21(txEndedMeasurands),
                },
              ],
            },
            'ocpp2.1',
          );
        }
        if (clockAlignedInterval > 0) {
          await publishCmd(
            'SetVariables',
            {
              setVariableData: [
                {
                  component: { name: 'AlignedDataCtrlr' },
                  variable: { name: 'Interval' },
                  attributeValue: String(clockAlignedInterval),
                },
              ],
            },
            'ocpp2.1',
          );
          if (alignedMeasurands) {
            await publishCmd(
              'SetVariables',
              {
                setVariableData: [
                  {
                    component: { name: 'AlignedDataCtrlr' },
                    variable: { name: 'Measurands' },
                    attributeValue: filter21(alignedMeasurands),
                  },
                ],
              },
              'ocpp2.1',
            );
          }
        }
      } else if (protocol === 'ocpp1.6') {
        // OCPP 1.6: ChangeConfiguration (one command per key)
        if (meterValueInterval > 0) {
          await publishCmd(
            'ChangeConfiguration',
            { key: 'MeterValueSampleInterval', value: String(meterValueInterval) },
            'ocpp1.6',
          );
        }
        if (sampledMeasurands) {
          await publishCmd(
            'ChangeConfiguration',
            { key: 'MeterValuesSampledData', value: sampledMeasurands },
            'ocpp1.6',
          );
        }
        if (txEndedMeasurands) {
          await publishCmd(
            'ChangeConfiguration',
            { key: 'StopTxnSampledData', value: txEndedMeasurands },
            'ocpp1.6',
          );
        }
        if (clockAlignedInterval > 0) {
          await publishCmd(
            'ChangeConfiguration',
            { key: 'ClockAlignedDataInterval', value: String(clockAlignedInterval) },
            'ocpp1.6',
          );
          if (alignedMeasurands) {
            await publishCmd(
              'ChangeConfiguration',
              { key: 'MeterValuesAlignedData', value: alignedMeasurands },
              'ocpp1.6',
            );
          }
        }
      }

      logger.info(
        {
          stationId: stationOcppId,
          protocol,
          meterValueInterval,
          clockAlignedInterval,
          sampledMeasurands,
          txEndedMeasurands,
        },
        'Pushed OCPP configuration on boot',
      );
    } catch (err) {
      logger.warn(
        { stationId: event.aggregateId, error: err instanceof Error ? err.message : String(err) },
        'Failed to push OCPP configuration on boot',
      );
    }
  });

  safeSubscribe('ocpp.Heartbeat', async (event: DomainEvent) => {
    const stationUuid = await getStationUuid(event);
    if (stationUuid == null) return;

    await sql`
      UPDATE charging_stations
      SET last_heartbeat = now(), updated_at = now()
      WHERE id = ${stationUuid}
    `;

    // Refresh registry TTL on heartbeat for horizontal scaling
    if (registry != null && instanceId != null) {
      try {
        await registry.register(event.aggregateId, instanceId);
      } catch {
        // Non-critical: registry refresh failure should not block heartbeat
      }
    }
  });

  safeSubscribe('ocpp.StatusNotification', async (event: DomainEvent) => {
    const payload = event.payload;
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const evseIdNum = payload.evseId as number;
    const connectorIdNum = payload.connectorId as number;
    const ocppStatus = payload.connectorStatus as string;
    const dbStatus = OCPP_STATUS_MAP[ocppStatus] ?? 'unavailable';

    const evseRows = await sql`
      SELECT id FROM evses WHERE station_id = ${stationUuid} AND evse_id = ${evseIdNum}
    `;

    const evseRow = evseRows[0];
    let resolvedEvseUuid: string | undefined;

    if (evseRow == null) {
      // Auto-create EVSE (only if station still exists)
      const insertedEvse = await sql`
        INSERT INTO evses (id, station_id, evse_id, auto_created)
        SELECT ${generateId('evse')}, ${stationUuid}, ${evseIdNum}, true
        WHERE EXISTS (SELECT 1 FROM charging_stations WHERE id = ${stationUuid})
        RETURNING id
      `;
      if (insertedEvse.length === 0) {
        invalidateStationCache(event.aggregateId);
        return;
      }
      const newEvseUuid = insertedEvse[0]?.id as string;
      resolvedEvseUuid = newEvseUuid;

      // Auto-create connector
      await sql`
        INSERT INTO connectors (id, evse_id, connector_id, status, auto_created)
        VALUES (${generateId('connector')}, ${newEvseUuid}, ${connectorIdNum}, ${dbStatus}, true)
      `;

      await sql`
        INSERT INTO port_status_log (station_id, evse_id, connector_id, previous_status, new_status, timestamp)
        VALUES (${stationUuid}, ${evseIdNum}, ${connectorIdNum}, ${null}, ${dbStatus}, now())
      `;
    } else {
      const evseUuid = evseRow.id as string;
      resolvedEvseUuid = evseUuid;

      // Get previous connector status for audit log
      const prevRows = await sql`
        SELECT status FROM connectors WHERE evse_id = ${evseUuid} AND connector_id = ${connectorIdNum}
      `;
      const previousStatus = prevRows[0]?.status as string | undefined;

      await sql`
        INSERT INTO port_status_log (station_id, evse_id, connector_id, previous_status, new_status, timestamp)
        VALUES (${stationUuid}, ${evseIdNum}, ${connectorIdNum}, ${previousStatus ?? null}, ${dbStatus}, now())
      `;

      // Check if connector exists; create if missing
      if (prevRows.length === 0) {
        await sql`
          INSERT INTO connectors (id, evse_id, connector_id, status, auto_created)
          VALUES (${generateId('connector')}, ${evseUuid}, ${connectorIdNum}, ${dbStatus}, true)
        `;
      } else {
        await sql`
          UPDATE connectors SET status = ${dbStatus}, updated_at = now()
          WHERE evse_id = ${evseUuid} AND connector_id = ${connectorIdNum}
        `;
      }
    }

    const siteId = await resolveSiteId(stationUuid);
    await notifyChange('station.status', stationUuid, siteId);
    if (siteId != null) {
      await notifyOcpiPush('location', { siteId });
    }

    // OCPP 1.6 StatusNotification idle detection fallback.
    // OCPP 1.6 sends fine-grained statuses (SuspendedEV, SuspendedEVSE, Finishing, Charging).
    // OCPP 2.1 only sends coarse statuses (Available, Occupied, Reserved, Unavailable, Faulted).
    // If we see a 1.6-specific status, use it for idle detection on active sessions
    // that do not already have idle_started_at set by a higher-priority signal.
    const IDLE_STATUSES_1_6 = new Set(['SuspendedEV', 'SuspendedEVSE', 'Finishing']);
    const RESUME_STATUSES_1_6 = new Set(['Charging', 'Preparing']);

    if (IDLE_STATUSES_1_6.has(ocppStatus)) {
      const statusTimestamp = (payload.timestamp as string | undefined) ?? new Date().toISOString();
      await sql`
        UPDATE charging_sessions
        SET idle_started_at = ${statusTimestamp}, updated_at = now()
        WHERE station_id = ${stationUuid} AND status = 'active' AND idle_started_at IS NULL
          AND evse_id = ${resolvedEvseUuid}
      `;

      // Dispatch idling notification for the active session on this EVSE
      const activeSession = await sql`
        SELECT id, transaction_id FROM charging_sessions
        WHERE station_id = ${stationUuid} AND status = 'active' AND idle_started_at IS NOT NULL
          AND evse_id = ${resolvedEvseUuid}
      `;
      const sess = activeSession[0];
      if (sess != null) {
        await dispatchIdlingNotification(
          sess.id as string,
          event.aggregateId,
          sess.transaction_id as string,
        );
      }
    } else if (RESUME_STATUSES_1_6.has(ocppStatus)) {
      const statusTimestamp = (payload.timestamp as string | undefined) ?? new Date().toISOString();
      await sql`
        UPDATE charging_sessions
        SET idle_minutes = idle_minutes + EXTRACT(EPOCH FROM (${statusTimestamp}::timestamptz - idle_started_at)) / 60,
            idle_started_at = NULL,
            updated_at = now()
        WHERE station_id = ${stationUuid} AND status = 'active' AND idle_started_at IS NOT NULL
          AND evse_id = ${resolvedEvseUuid}
      `;
    }
  });

  safeSubscribe('ocpp.TransactionEvent', async (event: DomainEvent) => {
    const payload = event.payload;
    const eventType = payload.eventType as string;
    const stationId = payload.stationId as string;
    const stationUuid = await resolveStationUuid(stationId);
    if (stationUuid == null) return;

    const transactionId = payload.transactionId as string;
    const seqNo = payload.seqNo as number;
    const triggerReason = payload.triggerReason as string;
    const timestamp = payload.timestamp as string;
    const payloadJson = JSON.stringify(payload);

    if (eventType === 'Started') {
      // For remote starts, link back to the session created by the portal/API
      // instead of creating a duplicate
      let sessionId: string | null = null;
      if (triggerReason === 'RemoteStart') {
        const existing = await sql`
          SELECT id FROM charging_sessions
          WHERE station_id = ${stationUuid}
            AND remote_start_id IS NOT NULL
            AND status = 'active'
            AND transaction_id != ${transactionId}
          ORDER BY started_at DESC
          LIMIT 1
        `;
        if (existing[0] != null) {
          sessionId = existing[0].id as string;
          await sql`
            UPDATE charging_sessions
            SET transaction_id = ${transactionId}, updated_at = now()
            WHERE id = ${sessionId}
          `;
        }
      }

      if (sessionId == null) {
        const newSessionId = generateId('session');
        const ocppEvseId =
          typeof payload.evseId === 'number'
            ? payload.evseId
            : typeof payload.evseId === 'string'
              ? parseInt(payload.evseId, 10)
              : 0;
        const txEvseUuid = await resolveEvseUuid(stationUuid, ocppEvseId);
        const meterStartVal = payload.meterStart != null ? Number(payload.meterStart) : 0;
        await sql`
          INSERT INTO charging_sessions (id, station_id, evse_id, transaction_id, status, started_at, meter_start)
          VALUES (${newSessionId}, ${stationUuid}, ${txEvseUuid}, ${transactionId}, 'active', ${timestamp}, ${meterStartVal})
          ON CONFLICT (transaction_id) DO NOTHING
        `;

        sessionId = getSessionId(
          await sql`SELECT id FROM charging_sessions WHERE transaction_id = ${transactionId}`,
        );
      }
      if (sessionId != null) {
        // Close stale active sessions on the same EVSE (if any).
        // A new transaction starting means any previous session on this EVSE ended
        // without a proper Ended event (e.g., station rebooted, connection lost).
        await sql`
          UPDATE charging_sessions
          SET status = 'faulted', stopped_reason = 'StaleSession', ended_at = ${timestamp}, updated_at = now()
          WHERE station_id = ${stationUuid} AND status = 'active'
            AND id != ${sessionId}
            AND evse_id = (SELECT evse_id FROM charging_sessions WHERE id = ${sessionId})
        `;

        // Set connector to 'ev_connected' on transaction start (cable connected)
        // Skip when EVConnectTimeout: the EV was never actually connected
        if (triggerReason !== 'EVConnectTimeout') {
          const startEvseRows = await sql`
            SELECT evse_id FROM charging_sessions WHERE id = ${sessionId}
          `;
          const startEvseUuid = startEvseRows[0]?.evse_id as string | null;
          if (startEvseUuid != null) {
            await sql`
              UPDATE connectors SET status = 'ev_connected', updated_at = now()
              WHERE evse_id = ${startEvseUuid}
            `;
          }
        }

        // EVConnectTimeout: station timed out waiting for EV to connect after remote start
        if (triggerReason === 'EVConnectTimeout') {
          await sql`
            UPDATE charging_sessions
            SET status = 'failed', stopped_reason = 'EVConnectTimeout', updated_at = now()
            WHERE id = ${sessionId}
          `;
          logger.info(
            { stationId, transactionId, sessionId },
            'Session marked failed: EVConnectTimeout on Started',
          );
        }

        try {
          await sql`
            INSERT INTO transaction_events (session_id, event_type, seq_no, timestamp, trigger_reason, payload)
            VALUES (${sessionId}, 'started', ${seqNo}, ${timestamp}, ${triggerReason}, ${payloadJson})
          `;
        } catch (txEvtErr: unknown) {
          logger.warn(
            { err: txEvtErr, sessionId, transactionId },
            'Failed to insert transaction_event (session may have been deleted)',
          );
        }

        // Check if site has free-vend enabled (skip driver resolution and payment gate)
        const freeVendRows = await sql`
          SELECT s.free_vend_enabled FROM sites s
          JOIN charging_stations cs ON cs.site_id = s.id
          WHERE cs.id = ${stationUuid}
        `;
        const isFreeVend = freeVendRows[0]?.free_vend_enabled === true;

        let driverUuid: string | null = null;
        let isRoamingSession = false;
        let guestStatus: string | null = null;
        let guestEmail: string | null = null;

        if (isFreeVend) {
          // Mark session as free-vend, skip driver resolution and payment gate
          await sql`
            UPDATE charging_sessions
            SET driver_id = NULL, free_vend = true, updated_at = now()
            WHERE id = ${sessionId}
          `;
        } else {
          // Resolve driver from idToken if not already set (e.g., RFID tap)
          const sessionRows =
            await sql`SELECT driver_id FROM charging_sessions WHERE id = ${sessionId}`;
          driverUuid = sessionRows[0]?.driver_id as string | null;

          if (driverUuid == null) {
            const idTokenValue = payload.idToken as string | null;

            // Token resolution chain: driver_tokens -> ocpi_external_tokens -> guest_sessions
            // Match on id_token only. Token type is not needed because id_token values are unique
            // and OCPP 1.6 has no token type concept (the handler hardcodes ISO14443).
            if (idTokenValue != null) {
              const tokenRows = await sql`
                SELECT driver_id FROM driver_tokens
                WHERE id_token = ${idTokenValue} AND is_active = true
                LIMIT 1
              `;
              driverUuid = (tokenRows[0]?.driver_id as string | null) ?? null;
              if (driverUuid != null) {
                await sql`
                  UPDATE charging_sessions SET driver_id = ${driverUuid}, updated_at = now()
                  WHERE id = ${sessionId}
                `;
              } else {
                // Token not in driver_tokens. Check if it is a roaming token.
                try {
                  const externalRows = await sql`
                    SELECT 1 FROM ocpi_external_tokens
                    WHERE uid = ${idTokenValue} AND is_valid = true
                    LIMIT 1
                  `;
                  if (externalRows.length > 0) {
                    isRoamingSession = true;
                    await sql`
                      UPDATE charging_sessions SET is_roaming = true, updated_at = now()
                      WHERE id = ${sessionId}
                    `;
                  }
                } catch {
                  // OCPI tables may not exist in test/dev environments
                }
              }
            }

            // If still unresolved and idToken present, check guest sessions
            if (driverUuid == null && !isRoamingSession && idTokenValue != null) {
              const guestRows = await sql`
                SELECT status, guest_email
                FROM guest_sessions
                WHERE session_token = ${idTokenValue}
                LIMIT 1
              `;
              const guest = guestRows[0];
              if (guest != null) {
                guestStatus = guest.status as string;
                guestEmail = (guest.guest_email as string | null) ?? null;
              }
            }
          }

          // Resolve tariff for this station and snapshot rates
          const tariff = await resolveTariffForStation(stationUuid, driverUuid);
          if (tariff != null) {
            await sql`
              UPDATE charging_sessions
              SET tariff_id = ${tariff.id}, currency = ${tariff.currency},
                  tariff_price_per_kwh = ${tariff.pricePerKwh},
                  tariff_price_per_minute = ${tariff.pricePerMinute},
                  tariff_price_per_session = ${tariff.pricePerSession},
                  tariff_idle_fee_price_per_minute = ${tariff.idleFeePricePerMinute},
                  tariff_tax_rate = ${tariff.taxRate},
                  updated_at = now()
              WHERE id = ${sessionId}
            `;

            // Insert initial tariff segment for split-billing tracking
            await sql`
              INSERT INTO session_tariff_segments (session_id, tariff_id, started_at, energy_wh_start)
              VALUES (${sessionId}, ${tariff.id}, ${timestamp}, 0)
            `;
          }
        }

        // Link reservation to session if reservationId present
        const ocppReservationId = payload.reservationId as number | undefined;
        if (ocppReservationId != null) {
          try {
            const reservationRows = await sql`
              SELECT id FROM reservations
              WHERE reservation_id = ${ocppReservationId}
                AND station_id = ${stationUuid}
                AND status = 'active'
              LIMIT 1
            `;
            const reservationUuid = reservationRows[0]?.id as string | undefined;
            if (reservationUuid != null) {
              await sql`
                UPDATE charging_sessions SET reservation_id = ${reservationUuid}, updated_at = now()
                WHERE id = ${sessionId}
              `;
              await sql`
                UPDATE reservations SET status = 'in_use', updated_at = now()
                WHERE id = ${reservationUuid} AND status = 'active'
              `;
            }
          } catch {
            // Non-critical: reservation linking failure should not break session creation
          }
        }

        const siteId = await resolveSiteId(stationUuid);
        await notifyChange('session.started', stationUuid, siteId, sessionId);
        await notifyOcpiPush('session', { sessionId });

        if (!isFreeVend) {
          // Notify guest session service for linking
          const idTokenForGuest = payload.idToken as string | null;
          if (idTokenForGuest != null) {
            try {
              const guestPayload = JSON.stringify({
                type: 'TransactionStarted',
                sessionId,
                stationId,
                transactionId,
                idToken: {
                  idToken: idTokenForGuest,
                  type: (payload.tokenType as string | undefined) ?? 'ISO14443',
                },
              });
              await pubsub.publish('csms_events', guestPayload);
            } catch {
              // Non-critical
            }
          }

          // Driver notification: transaction started (awaited so it is recorded before the payment gate
          // can fire a PreAuthFailed notification, preserving chronological order in the portal drawer)
          const driverIdForNotify = driverUuid;
          if (driverIdForNotify != null) {
            const startedSiteName = await resolveSiteName(stationUuid);
            await dispatchDriverNotification(
              sql,
              'session.Started',
              driverIdForNotify,
              {
                siteName: startedSiteName ?? '',
                stationId,
                transactionId,
                startedAt: timestamp,
              },
              ALL_TEMPLATES_DIRS,
              pubsub,
            );
          }

          // Payment gate: pre-authorize or stop session if payment not possible.
          // Called here (not as a separate subscriber) to guarantee the session exists.
          // Awaited is safe because the EventBus already runs handlers fire-and-forget.
          await runPaymentGate({
            sessionId,
            transactionId,
            driverId: driverUuid,
            stationDbId: stationUuid,
            ocppStationId: stationId,
            siteId: siteId ?? null,
            isRoaming: isRoamingSession,
            idToken: payload.idToken as string | undefined,
            guestStatus,
            guestEmail,
          });
        }
      }

      // Drain buffered out-of-order events for this transaction
      const buffered = txBuffer.drain(transactionId);
      for (const bufferedEvent of buffered) {
        void eventBus.publish(bufferedEvent);
      }
    } else if (eventType === 'Updated') {
      const sessionId = getSessionId(
        await sql`SELECT id FROM charging_sessions WHERE transaction_id = ${transactionId}`,
      );
      if (sessionId != null) {
        try {
          await sql`
            INSERT INTO transaction_events (session_id, event_type, seq_no, timestamp, trigger_reason, payload)
            VALUES (${sessionId}, 'updated', ${seqNo}, ${timestamp}, ${triggerReason}, ${payloadJson})
          `;
        } catch (txEvtErr: unknown) {
          logger.warn(
            { err: txEvtErr, sessionId, transactionId },
            'Failed to insert transaction_event (session may have been deleted)',
          );
        }

        // Idle detection from chargingState (OCPP 2.1)
        const chargingState = getString(payload, 'chargingState');
        if (chargingState != null) {
          if (chargingState !== 'Charging') {
            // Vehicle stopped charging: mark idle start if not already set
            await sql`
              UPDATE charging_sessions
              SET idle_started_at = ${timestamp}, updated_at = now()
              WHERE id = ${sessionId} AND idle_started_at IS NULL
            `;

            // Dispatch idling notification to driver or guest
            await dispatchIdlingNotification(sessionId, stationId, transactionId);
          } else {
            // Charging resumed: accumulate idle time and clear idle_started_at
            await sql`
              UPDATE charging_sessions
              SET idle_minutes = idle_minutes + EXTRACT(EPOCH FROM (${timestamp}::timestamptz - idle_started_at)) / 60,
                  idle_started_at = NULL,
                  updated_at = now()
              WHERE id = ${sessionId} AND idle_started_at IS NOT NULL
            `;
          }
        }

        // Update connector status from chargingState (OCPP 2.1 enrichment)
        if (chargingState != null) {
          const connectorStatus = CHARGING_STATE_TO_STATUS[chargingState];
          if (connectorStatus != null) {
            const sessionEvse = await sql`
              SELECT evse_id FROM charging_sessions WHERE id = ${sessionId}
            `;
            const evseUuid = sessionEvse[0]?.evse_id as string | null;
            if (evseUuid != null) {
              await sql`
                UPDATE connectors SET status = ${connectorStatus}, updated_at = now()
                WHERE evse_id = ${evseUuid}
              `;
            }
          }
        }

        const siteId = await resolveSiteId(stationUuid);
        await notifyChange('session.updated', stationUuid, siteId, sessionId);
        await notifyOcpiPush('session', { sessionId });

        // Driver notification: transaction updated (throttled to once per 15 min via DB)
        const throttleResult = await sql`
          UPDATE charging_sessions
          SET last_update_notified_at = now()
          WHERE id = ${sessionId}
            AND driver_id IS NOT NULL
            AND (last_update_notified_at IS NULL
              OR last_update_notified_at < now() - make_interval(secs => ${SESSION_UPDATE_THROTTLE_MS / 1000}))
          RETURNING driver_id, energy_delivered_wh, current_cost_cents, currency, started_at
        `;
        if (throttleResult.length > 0 && throttleResult[0] != null) {
          const updatedSession = throttleResult[0];
          const startedAtDate = new Date(updatedSession.started_at as string);
          const durationMinutes = Math.round((Date.now() - startedAtDate.getTime()) / 60000);
          const updatedSiteName = await resolveSiteName(stationUuid);
          void dispatchDriverNotification(
            sql,
            'session.Updated',
            updatedSession.driver_id as string,
            {
              siteName: updatedSiteName ?? '',
              stationId,
              transactionId,
              energyDeliveredWh: updatedSession.energy_delivered_wh as number,
              currentCostCents: updatedSession.current_cost_cents as number,
              costFormatted: formatCostFromCents(
                updatedSession.current_cost_cents as number | null,
                (updatedSession.currency as string | null) ?? 'USD',
              ),
              currency: (updatedSession.currency as string | null) ?? 'USD',
              durationMinutes,
            },
            ALL_TEMPLATES_DIRS,
            pubsub,
          );
        }
      } else {
        txBuffer.add(transactionId, event);
      }
    } else if (eventType === 'Ended') {
      const stoppedReason = getString(payload, 'stoppedReason');

      // Check if this session was stopped due to a payment failure (pre-auth or missing payment method)
      const failedPaymentRows = await sql`
        SELECT id FROM payment_records
        WHERE session_id = (SELECT id FROM charging_sessions WHERE transaction_id = ${transactionId} LIMIT 1)
          AND status = 'failed'
        LIMIT 1
      `;
      const hasPaymentFailure = failedPaymentRows.length > 0;

      const endStatus = hasPaymentFailure ? 'faulted' : 'completed';
      const meterStopVal = payload.meterStop != null ? Number(payload.meterStop) : null;
      await sql`
        UPDATE charging_sessions
        SET status = ${endStatus}, ended_at = ${timestamp}, stopped_reason = ${stoppedReason},
            meter_stop = COALESCE(${meterStopVal}, meter_stop),
            updated_at = now()
        WHERE transaction_id = ${transactionId}
      `;

      const sessionRows = await sql`
        SELECT id, tariff_id, current_cost_cents, started_at, ended_at, energy_delivered_wh,
               currency, tariff_price_per_kwh, tariff_price_per_minute, tariff_price_per_session,
               tariff_idle_fee_price_per_minute, tariff_tax_rate,
               idle_started_at, idle_minutes, reservation_id
        FROM charging_sessions WHERE transaction_id = ${transactionId}
      `;
      const sessionRow = sessionRows[0];
      if (sessionRow != null) {
        const sessionId = sessionRow.id as string;

        // After session query, check for timeout with zero energy
        const energyWh = Number(sessionRow.energy_delivered_wh ?? 0);
        const isTimeoutEnd =
          (triggerReason === 'EVConnectTimeout' || stoppedReason === 'Timeout') && energyWh === 0;

        if (isTimeoutEnd && endStatus !== 'faulted') {
          await sql`
            UPDATE charging_sessions SET status = 'failed', updated_at = now()
            WHERE id = ${sessionId}
          `;
        }

        try {
          await sql`
            INSERT INTO transaction_events (session_id, event_type, seq_no, timestamp, trigger_reason, payload)
            VALUES (${sessionId}, 'ended', ${seqNo}, ${timestamp}, ${triggerReason}, ${payloadJson})
          `;
        } catch (txEvtErr: unknown) {
          logger.warn(
            { err: txEvtErr, sessionId, transactionId },
            'Failed to insert transaction_event (session may have been deleted)',
          );
        }

        // Compute final cost from snapshotted tariff rates
        const hasTariffSnapshot = sessionRow.tariff_id != null && sessionRow.currency != null;
        if (hasTariffSnapshot) {
          const endedAt = new Date(sessionRow.ended_at as string);
          const energyWh = Number(sessionRow.energy_delivered_wh ?? 0);

          // Calculate idle minutes: accumulated + any open idle period at session end
          const accumulatedIdle = Number(sessionRow.idle_minutes ?? 0);
          const idleStart = sessionRow.idle_started_at as string | null;
          const idleMinutes =
            idleStart != null
              ? accumulatedIdle + (endedAt.getTime() - new Date(idleStart).getTime()) / 60000
              : accumulatedIdle;

          const endGracePeriod = await getIdlingGracePeriodMinutes();

          // Close the open tariff segment
          const endedAtIso = endedAt.toISOString();
          await sql`
            UPDATE session_tariff_segments
            SET ended_at = ${endedAtIso},
                energy_wh_end = ${energyWh},
                duration_minutes = EXTRACT(EPOCH FROM (${endedAtIso}::timestamptz - started_at)) / 60,
                idle_minutes = ${idleMinutes}
            WHERE session_id = ${sessionId} AND ended_at IS NULL
          `;

          // Fetch reservation start time to compute holding minutes (time from reservation
          // start until session start, charged as a holding fee).
          const reservationUuid = sessionRow.reservation_id as string | null;
          let reservationHoldingMinutes = 0;
          if (reservationUuid != null) {
            const reservationRows = await sql`
              SELECT starts_at, created_at FROM reservations WHERE id = ${reservationUuid}
            `;
            const row = reservationRows[0];
            if (row != null) {
              const referenceTime = (row.starts_at ?? row.created_at) as string;
              const sessionStartedAt = new Date(sessionRow.started_at as string);
              const holdingMs = sessionStartedAt.getTime() - new Date(referenceTime).getTime();
              reservationHoldingMinutes = Math.max(0, Math.ceil(holdingMs / 60_000));
            }
          }

          // Fetch all segments to determine if split-billing applies
          const splitEnabled = await isSplitBillingEnabled();
          const finalSegments = splitEnabled
            ? await sql`
                SELECT sts.started_at, sts.ended_at, sts.energy_wh_start, sts.energy_wh_end,
                       sts.idle_minutes AS seg_idle_minutes,
                       t.currency, t.price_per_kwh, t.price_per_minute, t.price_per_session,
                       t.idle_fee_price_per_minute, t.reservation_fee_per_minute, t.tax_rate
                FROM session_tariff_segments sts
                JOIN tariffs t ON t.id = sts.tariff_id
                WHERE sts.session_id = ${sessionId}
                ORDER BY sts.started_at
              `
            : [];

          let totalCents: number;
          if (splitEnabled && finalSegments.length > 1) {
            const tariffSegments: TariffSegment[] = finalSegments.map((seg, index) => {
              const segStartMs = new Date(seg.started_at as string).getTime();
              const segEndMs = new Date(seg.ended_at as string).getTime();
              return {
                tariff: {
                  pricePerKwh: seg.price_per_kwh as string | null,
                  pricePerMinute: seg.price_per_minute as string | null,
                  pricePerSession: seg.price_per_session as string | null,
                  idleFeePricePerMinute: seg.idle_fee_price_per_minute as string | null,
                  reservationFeePerMinute: seg.reservation_fee_per_minute as string | null,
                  taxRate: seg.tax_rate as string | null,
                  currency: seg.currency as string,
                },
                durationMinutes: (segEndMs - segStartMs) / 60000,
                energyDeliveredWh:
                  Number(seg.energy_wh_end ?? 0) - Number(seg.energy_wh_start ?? 0),
                idleMinutes: Number(seg.seg_idle_minutes ?? 0),
                isFirstSegment: index === 0,
              };
            });
            totalCents = calculateSplitSessionCost(
              tariffSegments,
              endGracePeriod,
              reservationHoldingMinutes,
            ).totalCents;
          } else {
            // Fetch reservation_fee_per_minute from the tariff row (not snapshotted on session)
            let tariffReservationFeePerMinute: string | null = null;
            if (sessionRow.tariff_id != null) {
              const tariffFeeRows = await sql`
                SELECT reservation_fee_per_minute FROM tariffs WHERE id = ${sessionRow.tariff_id as string}
              `;
              tariffReservationFeePerMinute =
                (tariffFeeRows[0]?.reservation_fee_per_minute as string | null) ?? null;
            }

            const startedAt = new Date(sessionRow.started_at as string);
            const durationMinutes = (endedAt.getTime() - startedAt.getTime()) / 60000;
            totalCents = calculateSessionCost(
              {
                pricePerKwh: sessionRow.tariff_price_per_kwh as string | null,
                pricePerMinute: sessionRow.tariff_price_per_minute as string | null,
                pricePerSession: sessionRow.tariff_price_per_session as string | null,
                idleFeePricePerMinute: sessionRow.tariff_idle_fee_price_per_minute as string | null,
                reservationFeePerMinute: tariffReservationFeePerMinute,
                taxRate: sessionRow.tariff_tax_rate as string | null,
                currency: sessionRow.currency as string,
              },
              energyWh,
              durationMinutes,
              idleMinutes,
              endGracePeriod,
              reservationHoldingMinutes,
            ).totalCents;
          }

          await sql`
            UPDATE charging_sessions
            SET final_cost_cents = ${totalCents}, current_cost_cents = ${totalCents}, updated_at = now()
            WHERE id = ${sessionId}
          `;
        }

        // Carbon footprint calculation
        try {
          const carbonRows = await sql`
            SELECT s.carbon_region_code, cif.carbon_intensity_kg_per_kwh
            FROM charging_stations cs
            JOIN sites s ON s.id = cs.site_id
            JOIN carbon_intensity_factors cif ON cif.region_code = s.carbon_region_code
            WHERE cs.id = ${stationUuid}
          `;
          const carbonRow = carbonRows[0];
          if (carbonRow != null) {
            const intensity = Number(carbonRow.carbon_intensity_kg_per_kwh);
            const sessionEnergyWh = Number(sessionRow.energy_delivered_wh ?? 0);
            const co2Avoided = calculateCo2AvoidedKg(sessionEnergyWh, intensity);
            await sql`
              UPDATE charging_sessions SET co2_avoided_kg = ${co2Avoided}, updated_at = now()
              WHERE id = ${sessionId}
            `;
          }
        } catch (carbonErr: unknown) {
          logger.warn({ err: carbonErr, sessionId }, 'Failed to compute CO2 avoided');
        }

        const siteId = await resolveSiteId(stationUuid);
        await notifyChange('session.ended', stationUuid, siteId, sessionId);
        await notifyOcpiPush('session', { sessionId });

        // Transition in_use reservation to used when session ends
        const reservationUuidForEnd = sessionRow.reservation_id as string | null;
        if (reservationUuidForEnd != null) {
          await sql`
            UPDATE reservations SET status = 'used', updated_at = now()
            WHERE id = ${reservationUuidForEnd} AND status = 'in_use'
          `.catch((err: unknown) => {
            logger.error({ err }, 'failed to transition reservation to used');
          });
        }

        // Notify guest session service for payment finalization
        try {
          const endPayload = JSON.stringify({
            type: 'TransactionEnded',
            sessionId,
            stationId,
            transactionId,
          });
          await pubsub.publish('csms_events', endPayload);
        } catch {
          // Non-critical
        }

        // Driver notification: transaction completed (skip if session failed due to payment)
        const endedDriverRows =
          await sql`SELECT driver_id, energy_delivered_wh, final_cost_cents, currency, started_at, ended_at FROM charging_sessions WHERE id = ${sessionId}`;
        const endedSession = endedDriverRows[0];
        if (endedSession != null && endedSession.driver_id != null && !hasPaymentFailure) {
          const startedAtDate = new Date(endedSession.started_at as string);
          const endedAtDate = new Date(endedSession.ended_at as string);
          const durationMinutes = Math.round(
            (endedAtDate.getTime() - startedAtDate.getTime()) / 60000,
          );
          const endedSiteName = await resolveSiteName(stationUuid);
          void dispatchDriverNotification(
            sql,
            'session.Completed',
            endedSession.driver_id as string,
            {
              siteName: endedSiteName ?? '',
              stationId,
              transactionId,
              energyDeliveredWh: endedSession.energy_delivered_wh as number,
              finalCostCents: endedSession.final_cost_cents as number,
              costFormatted: formatCostFromCents(
                endedSession.final_cost_cents as number | null,
                (endedSession.currency as string | null) ?? 'USD',
              ),
              currency: (endedSession.currency as string | null) ?? 'USD',
              durationMinutes,
              startedAt: endedSession.started_at as string,
              endedAt: endedSession.ended_at as string,
            },
            ALL_TEMPLATES_DIRS,
            pubsub,
          );

          // Session receipt notification
          void dispatchDriverNotification(
            sql,
            'session.Receipt',
            endedSession.driver_id as string,
            {
              siteName: endedSiteName ?? '',
              stationId,
              transactionId,
              energyDeliveredWh: endedSession.energy_delivered_wh as number,
              finalCostCents: endedSession.final_cost_cents as number,
              costFormatted: formatCostFromCents(
                endedSession.final_cost_cents as number | null,
                (endedSession.currency as string | null) ?? 'USD',
              ),
              currency: (endedSession.currency as string | null) ?? 'USD',
              durationMinutes,
              startedAt: endedSession.started_at as string,
              endedAt: endedSession.ended_at as string,
            },
            ALL_TEMPLATES_DIRS,
            pubsub,
          );
        }
      } else {
        txBuffer.add(transactionId, event);
      }
    }
  });

  safeSubscribe('ocpp.MeterValues', async (event: DomainEvent) => {
    const payload = event.payload;
    const stationId = payload.stationId as string;
    let stationUuid = await resolveStationUuid(stationId);
    if (stationUuid == null) return;

    const ocppEvseId =
      typeof payload.evseId === 'number'
        ? payload.evseId
        : typeof payload.evseId === 'string'
          ? parseInt(payload.evseId, 10)
          : 0;
    const transactionId = payload.transactionId as string | undefined;
    const source = (payload.source as string | undefined) ?? null;

    const evseUuid = await resolveEvseUuid(stationUuid, ocppEvseId);
    // Link meter values to a session when they came from a TransactionEvent or
    // when the MeterValues message includes a transactionId (OCPP 1.6 always does this).
    const isTransactionScoped = source === 'TransactionEvent' || transactionId != null;
    const sessionId = isTransactionScoped
      ? await resolveActiveSessionId(
          stationUuid,
          evseUuid,
          transactionId,
          source === 'TransactionEvent',
        )
      : null;

    if (sessionId == null && transactionId != null && isTransactionScoped) {
      txBuffer.add(transactionId, event);
      return;
    }

    const meterValues = payload.meterValues as Array<Record<string, unknown>> | undefined;
    if (meterValues == null) return;

    for (const mv of meterValues) {
      const mvTimestamp = mv.timestamp as string;
      const sampledValues = mv.sampledValue as Array<Record<string, unknown>> | undefined;
      if (sampledValues == null) continue;

      for (const sv of sampledValues) {
        const measurand = getString(sv, 'measurand');
        // 2.1: sv.unitOfMeasure.unit, 1.6: sv.unit
        const unitOfMeasure = sv.unitOfMeasure as Record<string, unknown> | undefined;
        const unit =
          unitOfMeasure != null ? getString(unitOfMeasure, 'unit') : getString(sv, 'unit');
        const phase = getString(sv, 'phase');
        const location = getString(sv, 'location');
        const context = getString(sv, 'context');
        const signedMeterValue = sv.signedMeterValue ?? null;

        const mvInserted = await sql`
          INSERT INTO meter_values (
            station_id, evse_id, session_id, timestamp, measurand, value, unit,
            phase, location, context, signed_data, source
          )
          SELECT
            ${stationUuid},
            (SELECT id FROM evses WHERE id = ${evseUuid} LIMIT 1),
            ${sessionId},
            ${mvTimestamp},
            ${measurand},
            ${sv.value as number},
            ${unit},
            ${phase},
            ${location},
            ${context},
            ${signedMeterValue != null ? JSON.stringify(signedMeterValue) : null}::jsonb,
            ${source}
          WHERE EXISTS (SELECT 1 FROM charging_stations WHERE id = ${stationUuid})
        `;
        if (mvInserted.count === 0) {
          invalidateStationCache(stationId);
          stationUuid = await resolveStationUuid(stationId);
          if (stationUuid == null) return;
          await sql`
            INSERT INTO meter_values (
              station_id, evse_id, session_id, timestamp, measurand, value, unit,
              phase, location, context, signed_data, source
            )
            VALUES (
              ${stationUuid},
              (SELECT id FROM evses WHERE id = ${evseUuid} LIMIT 1),
              ${sessionId},
              ${mvTimestamp},
              ${measurand},
              ${sv.value as number},
              ${unit},
              ${phase},
              ${location},
              ${context},
              ${signedMeterValue != null ? JSON.stringify(signedMeterValue) : null}::jsonb,
              ${source}
            )
          `;
        }

        // Update energy_delivered_wh on active sessions when we get an energy reading.
        // Energy registers are cumulative, so we compute: currentValue - meterStart.
        // If meterStart is not yet set (OCPP 2.1 sessions), capture the first reading as meterStart.
        // Both transaction-scoped (TransactionEvent, 1.6 MeterValues with transactionId) and
        // standalone 2.1 MeterValues update energy if an active session exists on the EVSE.
        if (measurand === 'Energy.Active.Import.Register') {
          const meterValue = Number(sv.value);

          // Capture previous energy and meter_start for flat-reading idle detection
          const prevRows = await sql`
            SELECT energy_delivered_wh, meter_start FROM charging_sessions
            WHERE station_id = ${stationUuid} AND status = 'active'
              AND (${evseUuid}::text IS NULL OR evse_id = ${evseUuid})
          `;
          const prevEnergyWh = Number(prevRows[0]?.energy_delivered_wh ?? -1);
          const existingMeterStart = prevRows[0]?.meter_start as string | null | undefined;

          // Set meter_start from the first energy reading if not already set (OCPP 2.1 path)
          await sql`
            UPDATE charging_sessions
            SET meter_start = ${meterValue}, updated_at = now()
            WHERE station_id = ${stationUuid} AND status = 'active'
              AND (${evseUuid}::text IS NULL OR evse_id = ${evseUuid})
              AND meter_start IS NULL
          `;
          // Compute energy as delta: currentReading - meterStart (clamp to 0 if meter resets)
          await sql`
            UPDATE charging_sessions
            SET energy_delivered_wh = GREATEST(0, ${meterValue} - meter_start), updated_at = now()
            WHERE station_id = ${stationUuid} AND status = 'active'
              AND (${evseUuid}::text IS NULL OR evse_id = ${evseUuid})
              AND meter_start IS NOT NULL
          `;

          // Flat energy reading idle detection (Priority 3 fallback).
          // If energy_delivered_wh did not change after this reading, no power is flowing.
          // The idle_started_at IS NULL guard ensures higher-priority signals are not overwritten.
          if (existingMeterStart != null && prevEnergyWh >= 0) {
            const newEnergyWh = meterValue - Number(existingMeterStart);
            if (Math.abs(newEnergyWh - prevEnergyWh) < 1) {
              // Energy unchanged: mark idle if not already set
              await sql`
                UPDATE charging_sessions
                SET idle_started_at = ${mvTimestamp}, updated_at = now()
                WHERE station_id = ${stationUuid} AND status = 'active' AND idle_started_at IS NULL
                  AND (${evseUuid}::text IS NULL OR evse_id = ${evseUuid})
              `;
            } else {
              // Energy increased: accumulate idle time and clear idle_started_at
              await sql`
                UPDATE charging_sessions
                SET idle_minutes = idle_minutes + EXTRACT(EPOCH FROM (${mvTimestamp}::timestamptz - idle_started_at)) / 60,
                    idle_started_at = NULL,
                    updated_at = now()
                WHERE station_id = ${stationUuid} AND status = 'active' AND idle_started_at IS NOT NULL
                  AND (${evseUuid}::text IS NULL OR evse_id = ${evseUuid})
              `;
            }
          }
        }

        // Power-based idle detection (fallback for OCPP 1.6 and stations without chargingState)
        // Only transaction-scoped readings should update session idle state.
        if (isTransactionScoped && measurand === 'Power.Active.Import') {
          const powerValue = Number(sv.value);
          if (powerValue === 0) {
            // No power flowing: mark idle start if not already set
            await sql`
              UPDATE charging_sessions
              SET idle_started_at = ${mvTimestamp}, updated_at = now()
              WHERE station_id = ${stationUuid} AND status = 'active' AND idle_started_at IS NULL
                AND (${evseUuid}::text IS NULL OR evse_id = ${evseUuid})
            `;
          } else {
            // Power resumed: accumulate idle time and clear idle_started_at
            await sql`
              UPDATE charging_sessions
              SET idle_minutes = idle_minutes + EXTRACT(EPOCH FROM (${mvTimestamp}::timestamptz - idle_started_at)) / 60,
                  idle_started_at = NULL,
                  updated_at = now()
              WHERE station_id = ${stationUuid} AND status = 'active' AND idle_started_at IS NOT NULL
                AND (${evseUuid}::text IS NULL OR evse_id = ${evseUuid})
            `;
          }
        }
      }
    }

    // Notify for all MeterValues (both standalone and transaction-scoped).
    // Cost recalculation and session updates follow below when active sessions exist.

    // Update real-time cost on active sessions for this station using snapshotted rates
    const activeSessions = await sql`
      SELECT id, tariff_id, driver_id, started_at, energy_delivered_wh, current_cost_cents,
             currency, tariff_price_per_kwh, tariff_price_per_minute, tariff_price_per_session,
             tariff_idle_fee_price_per_minute, tariff_tax_rate,
             idle_started_at, idle_minutes
      FROM charging_sessions
      WHERE station_id = ${stationUuid} AND status = 'active' AND tariff_id IS NOT NULL
        AND (${evseUuid}::text IS NULL OR evse_id = ${evseUuid})
    `;

    const meterGracePeriod = await getIdlingGracePeriodMinutes();
    const splitBillingEnabled = await isSplitBillingEnabled();
    for (const session of activeSessions) {
      if (session.currency == null) continue;
      const sessionId = session.id as string;

      const startedAt = new Date(session.started_at as string);
      const durationMinutes = (Date.now() - startedAt.getTime()) / 60000;
      const energyWh = Number(session.energy_delivered_wh ?? 0);

      // Calculate idle minutes: accumulated + current open idle period
      const accumulatedIdle = Number(session.idle_minutes ?? 0);
      const idleStart = session.idle_started_at as string | null;
      const idleMinutes =
        idleStart != null
          ? accumulatedIdle + (Date.now() - new Date(idleStart).getTime()) / 60000
          : accumulatedIdle;

      // Split-billing: check if tariff has changed since session started
      if (splitBillingEnabled) {
        const currentTariff = await resolveTariffForStation(
          stationUuid,
          session.driver_id as string | null,
        );
        if (currentTariff != null && currentTariff.id !== (session.tariff_id as string)) {
          const now = new Date().toISOString();
          // Compute idle minutes for the closing segment:
          // session total idle - sum of all previously closed segments' idle
          const priorIdleRows = await sql`
            SELECT COALESCE(SUM(idle_minutes), 0) AS total
            FROM session_tariff_segments
            WHERE session_id = ${sessionId} AND ended_at IS NOT NULL
          `;
          const priorIdleSum = Number(priorIdleRows[0]?.total ?? 0);
          const segmentIdleMinutes = Math.max(0, idleMinutes - priorIdleSum);
          // Close the current open segment
          await sql`
            UPDATE session_tariff_segments
            SET ended_at = ${now},
                energy_wh_end = ${energyWh},
                duration_minutes = EXTRACT(EPOCH FROM (${now}::timestamptz - started_at)) / 60,
                idle_minutes = ${segmentIdleMinutes}
            WHERE session_id = ${sessionId} AND ended_at IS NULL
          `;
          // Open a new segment for the new tariff
          await sql`
            INSERT INTO session_tariff_segments (session_id, tariff_id, started_at, energy_wh_start)
            VALUES (${sessionId}, ${currentTariff.id}, ${now}, ${energyWh})
          `;
          // Update session tariff snapshot to the new tariff
          await sql`
            UPDATE charging_sessions
            SET tariff_id = ${currentTariff.id}, currency = ${currentTariff.currency},
                tariff_price_per_kwh = ${currentTariff.pricePerKwh},
                tariff_price_per_minute = ${currentTariff.pricePerMinute},
                tariff_price_per_session = ${currentTariff.pricePerSession},
                tariff_idle_fee_price_per_minute = ${currentTariff.idleFeePricePerMinute},
                tariff_tax_rate = ${currentTariff.taxRate},
                updated_at = now()
            WHERE id = ${sessionId}
          `;
        }
      }

      // Calculate cost (split-billing or single tariff)
      let totalCents: number;
      if (splitBillingEnabled) {
        const segments = await sql`
          SELECT sts.started_at, sts.ended_at, sts.energy_wh_start, sts.energy_wh_end,
                 t.currency, t.price_per_kwh, t.price_per_minute, t.price_per_session,
                 t.idle_fee_price_per_minute, t.tax_rate
          FROM session_tariff_segments sts
          JOIN tariffs t ON t.id = sts.tariff_id
          WHERE sts.session_id = ${sessionId}
          ORDER BY sts.started_at
        `;
        if (segments.length > 1) {
          const nowMs = Date.now();
          const tariffSegments: TariffSegment[] = segments.map((seg, index) => {
            const segStartMs = new Date(seg.started_at as string).getTime();
            const segEndMs =
              seg.ended_at != null ? new Date(seg.ended_at as string).getTime() : nowMs;
            const segEnergyStart = Number(seg.energy_wh_start ?? 0);
            const segEnergyEnd = seg.ended_at != null ? Number(seg.energy_wh_end ?? 0) : energyWh;
            return {
              tariff: {
                pricePerKwh: seg.price_per_kwh as string | null,
                pricePerMinute: seg.price_per_minute as string | null,
                pricePerSession: seg.price_per_session as string | null,
                idleFeePricePerMinute: seg.idle_fee_price_per_minute as string | null,
                reservationFeePerMinute: null, // holding fee applied at session end only
                taxRate: seg.tax_rate as string | null,
                currency: seg.currency as string,
              },
              durationMinutes: (segEndMs - segStartMs) / 60000,
              energyDeliveredWh: segEnergyEnd - segEnergyStart,
              // Idle time attributed to the last (current) segment
              idleMinutes: index === segments.length - 1 ? idleMinutes : 0,
              isFirstSegment: index === 0,
            };
          });
          totalCents = calculateSplitSessionCost(tariffSegments, meterGracePeriod).totalCents;
        } else {
          totalCents = calculateSessionCost(
            {
              pricePerKwh: session.tariff_price_per_kwh as string | null,
              pricePerMinute: session.tariff_price_per_minute as string | null,
              pricePerSession: session.tariff_price_per_session as string | null,
              idleFeePricePerMinute: session.tariff_idle_fee_price_per_minute as string | null,
              reservationFeePerMinute: null, // holding fee applied at session end only
              taxRate: session.tariff_tax_rate as string | null,
              currency: session.currency as string,
            },
            energyWh,
            durationMinutes,
            idleMinutes,
            meterGracePeriod,
          ).totalCents;
        }
      } else {
        totalCents = calculateSessionCost(
          {
            pricePerKwh: session.tariff_price_per_kwh as string | null,
            pricePerMinute: session.tariff_price_per_minute as string | null,
            pricePerSession: session.tariff_price_per_session as string | null,
            idleFeePricePerMinute: session.tariff_idle_fee_price_per_minute as string | null,
            reservationFeePerMinute: null, // holding fee applied at session end only
            taxRate: session.tariff_tax_rate as string | null,
            currency: session.currency as string,
          },
          energyWh,
          durationMinutes,
          idleMinutes,
          meterGracePeriod,
        ).totalCents;
      }

      const previousCostCents = session.current_cost_cents as number | null;

      await sql`
        UPDATE charging_sessions
        SET current_cost_cents = ${totalCents}, currency = ${session.currency as string}, updated_at = now()
        WHERE id = ${sessionId}
      `;

      // Send CostUpdated to station when cost changes (OCPP 2.1 only)
      if (previousCostCents !== totalCents) {
        const txAndProtocol = await sql`
          SELECT cs.transaction_id, st.ocpp_protocol
          FROM charging_sessions cs
          JOIN charging_stations st ON st.id = cs.station_id
          WHERE cs.id = ${sessionId}
        `;
        const txId = txAndProtocol[0]?.transaction_id as string | null;
        const protocol = txAndProtocol[0]?.ocpp_protocol as string | null;
        if (txId != null && protocol === 'ocpp2.1') {
          const commandId = crypto.randomUUID();
          const costUpdatePayload = JSON.stringify({
            commandId,
            stationId,
            action: 'CostUpdated',
            payload: {
              totalCost: totalCents / 100,
              transactionId: txId,
            },
          });
          try {
            await pubsub.publish('ocpp_commands', costUpdatePayload);
          } catch {
            // Non-critical: CostUpdated failure should not block meter value processing
          }
        }
      }
    }

    const siteId = await resolveSiteId(stationUuid);
    await notifyChange('meter.values', stationUuid, siteId);
  });

  safeSubscribe('ocpp.FirmwareStatusNotification', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const status = payload.status as string;

    if (status === 'Installed') {
      await sql`
        UPDATE charging_stations
        SET availability = 'available', updated_at = now()
        WHERE id = ${stationUuid}
      `;
    } else if (
      status === 'InstallationFailed' ||
      status === 'InvalidSignature' ||
      status === 'InstallVerificationFailed'
    ) {
      await sql`
        UPDATE charging_stations
        SET availability = 'faulted', updated_at = now()
        WHERE id = ${stationUuid}
      `;
    } else if (status === 'Installing') {
      await sql`
        UPDATE charging_stations
        SET availability = 'unavailable', updated_at = now()
        WHERE id = ${stationUuid}
      `;
    }

    // Persist to firmware_updates table
    const fwRequestId = (payload.requestId as number | undefined) ?? null;
    const fwStatusInfo = payload.statusInfo != null ? JSON.stringify(payload.statusInfo) : null;

    if (fwRequestId != null) {
      // 2.1 path: update by station + requestId
      const updated = await sql`
        UPDATE firmware_updates
        SET status = ${status}, status_info = ${fwStatusInfo}::jsonb, last_status_at = now(), updated_at = now()
        WHERE station_id = ${stationUuid} AND request_id = ${fwRequestId}
      `;
      if (updated.count === 0) {
        // No existing row (firmware started outside CSMS)
        await sql`
          INSERT INTO firmware_updates (station_id, request_id, firmware_url, status, status_info, initiated_at, last_status_at)
          VALUES (${stationUuid}, ${fwRequestId}, 'unknown', ${status}, ${fwStatusInfo}::jsonb, now(), now())
        `;
      }
    } else {
      // 1.6 path: no requestId, update most recent non-terminal row for this station
      const updated = await sql`
        UPDATE firmware_updates
        SET status = ${status}, status_info = ${fwStatusInfo}::jsonb, last_status_at = now(), updated_at = now()
        WHERE id = (
          SELECT id FROM firmware_updates
          WHERE station_id = ${stationUuid}
            AND (status IS NULL OR status NOT IN ('Installed', 'InstallationFailed', 'InstallVerificationFailed', 'InvalidSignature', 'DownloadFailed'))
          ORDER BY created_at DESC LIMIT 1
        )
      `;
      if (updated.count === 0) {
        await sql`
          INSERT INTO firmware_updates (station_id, firmware_url, status, status_info, initiated_at, last_status_at)
          VALUES (${stationUuid}, 'unknown', ${status}, ${fwStatusInfo}::jsonb, now(), now())
        `;
      }
    }

    // Update firmware campaign station status if linked
    const campaignStatusMap: Record<string, string> = {
      Downloading: 'downloading',
      Downloaded: 'downloaded',
      Installing: 'installing',
      Installed: 'installed',
      DownloadFailed: 'failed',
      InstallationFailed: 'failed',
      InvalidSignature: 'failed',
      InstallVerificationFailed: 'failed',
    };
    const campaignStatus = campaignStatusMap[status];
    if (campaignStatus != null) {
      await sql`
        UPDATE firmware_campaign_stations
        SET status = ${campaignStatus}::firmware_campaign_station_status,
            error_info = CASE WHEN ${campaignStatus} = 'failed' THEN ${status} ELSE error_info END,
            updated_at = now()
        WHERE station_id = ${stationUuid}
          AND status NOT IN ('installed', 'failed')
      `;

      // Check if all stations in the campaign are terminal (installed or failed)
      await sql`
        UPDATE firmware_campaigns
        SET status = 'completed', updated_at = now()
        WHERE id IN (
          SELECT campaign_id FROM firmware_campaign_stations
          WHERE station_id = ${stationUuid}
        )
        AND NOT EXISTS (
          SELECT 1 FROM firmware_campaign_stations fcs
          WHERE fcs.campaign_id = firmware_campaigns.id
            AND fcs.status NOT IN ('installed', 'failed')
        )
        AND status = 'active'
      `;
    }
  });

  safeSubscribe('ocpp.SecurityEventNotification', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const eventName = 'security:' + String(payload.type);
    await sql`
      INSERT INTO connection_logs (station_id, event, metadata)
      VALUES (${stationUuid}, ${eventName}, ${JSON.stringify(payload)})
    `;

    // Compute severity and persist to security_events table
    const secType = (payload.type as string | undefined) ?? '';
    const secTimestamp = (payload.timestamp as string | undefined) ?? new Date().toISOString();
    const techInfo = (payload.techInfo as string | undefined) ?? null;
    const { getSecuritySeverity } = await import('../lib/security-severity.js');
    const severity = getSecuritySeverity(secType);
    await sql`
      INSERT INTO security_events (station_id, type, severity, timestamp, tech_info)
      VALUES (${stationUuid}, ${secType}, ${severity}, ${secTimestamp}, ${techInfo})
    `;

    // Auto-disable station on critical security events
    if (severity === 'critical') {
      const { isAutoDisableOnCriticalEnabled } = await import('@evtivity/database');
      const autoDisable = await isAutoDisableOnCriticalEnabled();
      if (autoDisable) {
        await sql`
          UPDATE charging_stations
          SET availability = 'unavailable', updated_at = now()
          WHERE id = ${stationUuid}
        `;
      }
    }

    const siteId = await resolveSiteId(stationUuid);
    await notifyChange('station.securityEvent', stationUuid, siteId);
  });

  safeSubscribe('ocpp.ReservationStatusUpdate', async (event: DomainEvent) => {
    const payload = event.payload;
    const reservationId = payload.reservationId as number;
    const updateStatus = payload.reservationUpdateStatus as string;

    const statusMap: Record<string, string> = {
      Expired: 'expired',
      Removed: 'cancelled',
    };
    const dbStatus = statusMap[updateStatus];
    if (dbStatus == null) return;

    await sql`
      UPDATE reservations
      SET status = ${dbStatus}, updated_at = now()
      WHERE reservation_id = ${reservationId}
    `;
  });

  // ---- Payment Projections ----

  safeSubscribe('ocpp.NotifySettlement', async (event: DomainEvent) => {
    const payload = event.payload;
    const transactionId = payload.transactionId as string | undefined;
    const settlementAmount = payload.settlementAmount as number | undefined;

    if (transactionId == null || settlementAmount == null) {
      logger.warn(
        { stationId: event.aggregateId, transactionId, settlementAmount },
        'NotifySettlement missing required fields; skipping',
      );
      return;
    }

    const sessionRows = await sql`
      SELECT id, driver_id, station_id FROM charging_sessions WHERE transaction_id = ${transactionId}
    `;
    const session = sessionRows[0];
    if (session == null) return;

    // Convert settlement amount to cents (OCPP sends in major currency units)
    const capturedAmountCents = Math.round(settlementAmount * 100);

    const insertResult = await sql`
      INSERT INTO payment_records (
        session_id, driver_id, payment_source, currency, captured_amount_cents, status
      )
      VALUES (
        ${session.id as string},
        ${session.driver_id as string | null},
        'ocpp_terminal',
        'USD',
        ${capturedAmountCents},
        'captured'
      )
      ON CONFLICT (session_id) DO NOTHING
    `;

    if (insertResult.count === 0) {
      logger.warn(
        { transactionId, sessionId: session.id },
        'Duplicate NotifySettlement ignored; payment already exists for session',
      );
      return;
    }

    await notifyChange('payment.settled', null, null, session.id as string);

    // Driver notification: payment received
    if (session.driver_id != null) {
      const settleSiteName =
        session.station_id != null ? await resolveSiteName(session.station_id as string) : null;
      void dispatchDriverNotification(
        sql,
        'session.PaymentReceived',
        session.driver_id as string,
        {
          siteName: settleSiteName ?? '',
          stationId: event.aggregateId,
          transactionId,
          amountCents: capturedAmountCents,
          currency: 'USD',
        },
        ALL_TEMPLATES_DIRS,
        pubsub,
      );

      // Driver notification: payment complete
      void dispatchDriverNotification(
        sql,
        'payment.Complete',
        session.driver_id as string,
        {
          stationId: event.aggregateId,
          transactionId,
          amountCents: capturedAmountCents,
          currency: 'USD',
        },
        ALL_TEMPLATES_DIRS,
        pubsub,
      );
    }
  });

  // ---- Automated Pre-Auth on Session Start ----

  interface PaymentGateParams {
    sessionId: string;
    transactionId: string;
    driverId: string | null;
    stationDbId: string;
    ocppStationId: string;
    siteId: string | null;
    isRoaming: boolean;
    idToken: string | undefined;
    guestStatus: string | null;
    guestEmail: string | null;
  }

  async function runPaymentGate(params: PaymentGateParams): Promise<void> {
    const {
      sessionId,
      transactionId,
      driverId,
      stationDbId,
      ocppStationId,
      siteId,
      isRoaming,
      idToken,
      guestStatus,
      guestEmail,
    } = params;

    // Case 1: OCPI roaming session -- billing handled by eMSP via CDR
    if (isRoaming) return;

    /** Stops the session by publishing RequestStopTransaction on the ocpp_commands channel. */
    async function stopSession(): Promise<void> {
      try {
        await pubsub.publish(
          'ocpp_commands',
          JSON.stringify({
            commandId: crypto.randomUUID(),
            stationId: ocppStationId,
            action: 'RequestStopTransaction',
            payload: { transactionId },
          }),
        );
      } catch (err) {
        logger.error({ err }, 'Failed to stop session after payment gate failure');
      }
    }

    if (driverId != null) {
      // ---- Driver session ----
      const pmRows = await sql`
          SELECT id, stripe_customer_id, stripe_payment_method_id
          FROM driver_payment_methods
          WHERE driver_id = ${driverId} AND is_default = true
          LIMIT 1
        `;

      if (pmRows.length === 0) {
        // No payment method -- allow only if tariff is free
        const isFree = await isTariffFreeForStation(stationDbId, driverId);
        if (isFree) return;
        logger.warn(
          `Driver ${driverId} has no payment method for non-free session ${transactionId}, stopping`,
        );
        await stopSession();
        try {
          void dispatchDriverNotification(
            sql,
            'payment.MissingPaymentMethod',
            driverId,
            {
              stationId: ocppStationId,
              transactionId,
            },
            ALL_TEMPLATES_DIRS,
            pubsub,
          );
        } catch (notifyErr) {
          logger.error({ err: notifyErr }, 'Failed to notify driver of missing payment method');
        }
        try {
          await pubsub.publish(
            'csms_events',
            JSON.stringify({
              type: 'payment.missingPaymentMethod',
              sessionId,
              transactionId,
            }),
          );
        } catch {
          // Non-critical
        }
        return;
      }

      const pm = pmRows[0];
      if (pm == null) return;

      // Skip payment gate entirely if the station tariff is free
      const isFree = await isTariffFreeForStation(stationDbId, driverId);
      if (isFree) return;

      const stripeCustomerId = pm.stripe_customer_id as string;

      // Load platform currency and pre-auth amount (used by both simulated and real paths)
      const platformSettingsRows = await sql`
          SELECT key, value FROM settings WHERE key IN (
            'stripe.currency',
            'stripe.preAuthAmountCents'
          )
        `;
      const platformMap = new Map<string, unknown>();
      for (const row of platformSettingsRows) {
        platformMap.set(row.key as string, row.value);
      }
      let platformCurrency = (platformMap.get('stripe.currency') as string | undefined) ?? 'USD';
      let platformPreAuthCents =
        (platformMap.get('stripe.preAuthAmountCents') as number | undefined) ?? 5000;

      // Load site-level payment config (overrides + connected account) in one query
      let connectedAccountId: string | null = null;
      let siteConfigId: string | null = null;
      if (siteId != null) {
        const siteConfigRows = await sql`
            SELECT id, currency, pre_auth_amount_cents, stripe_connected_account_id
            FROM site_payment_configs
            WHERE site_id = ${siteId} AND is_enabled = true
          `;
        const sc = siteConfigRows[0];
        if (sc != null) {
          platformCurrency = sc.currency as string;
          platformPreAuthCents = sc.pre_auth_amount_cents as number;
          connectedAccountId = (sc.stripe_connected_account_id as string | null) ?? null;
          siteConfigId = sc.id as string;
        }
      }

      // Guard: skip if a payment record already exists (prevents duplicate pre-auth on race)
      const existingPayment = await sql`
          SELECT id FROM payment_records WHERE session_id = ${sessionId} LIMIT 1
        `;
      if (existingPayment.length > 0) return;

      // Case 2: Simulated payment method -- bypass Stripe
      if (isSimulatedCustomer(stripeCustomerId)) {
        const intentId = `pi_sim_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        const failed = shouldSimulateFailure();

        try {
          if (failed) {
            await sql`
                INSERT INTO payment_records (
                  session_id, driver_id,
                  stripe_payment_intent_id, stripe_customer_id,
                  payment_source, currency, pre_auth_amount_cents, status,
                  failure_reason
                )
                VALUES (
                  ${sessionId},
                  ${driverId},
                  ${intentId},
                  ${stripeCustomerId},
                  'web_portal',
                  ${platformCurrency},
                  ${platformPreAuthCents},
                  'failed',
                  'Simulated pre-auth failure'
                )
                ON CONFLICT (session_id) DO NOTHING
              `;
          } else {
            await sql`
                INSERT INTO payment_records (
                  session_id, driver_id,
                  stripe_payment_intent_id, stripe_customer_id,
                  payment_source, currency, pre_auth_amount_cents, status
                )
                VALUES (
                  ${sessionId},
                  ${driverId},
                  ${intentId},
                  ${stripeCustomerId},
                  'web_portal',
                  ${platformCurrency},
                  ${platformPreAuthCents},
                  'pre_authorized'
                )
                ON CONFLICT (session_id) DO NOTHING
              `;
          }
        } catch (dbErr) {
          logger.error({ err: dbErr }, 'Failed to insert simulated payment record');
          return;
        }

        if (failed) {
          logger.warn(`Simulated pre-auth failure for session ${transactionId}`);
          await stopSession();
          try {
            void dispatchDriverNotification(
              sql,
              'payment.PreAuthFailed',
              driverId,
              {
                stationId: ocppStationId,
                transactionId,
                reason: 'Simulated payment failure',
              },
              ALL_TEMPLATES_DIRS,
              pubsub,
            );
          } catch (notifyErr) {
            logger.error(
              { err: notifyErr },
              'Failed to notify driver of simulated pre-auth failure',
            );
          }
          try {
            await pubsub.publish(
              'csms_events',
              JSON.stringify({
                type: 'payment.preAuthFailed',
                sessionId,
                transactionId,
                reason: 'Simulated payment failure',
              }),
            );
          } catch {
            // Non-critical
          }
        }
        return;
      }

      // Case 3: Real Stripe pre-auth
      const encryptionKey = config.SETTINGS_ENCRYPTION_KEY;

      try {
        // Get Stripe secret key and platform fee (currency/amount already resolved above)
        const stripeSettingsRows = await sql`
            SELECT key, value FROM settings WHERE key IN (
              'stripe.secretKeyEnc',
              'stripe.platformFeePercent'
            )
          `;
        const stripeMap = new Map<string, unknown>();
        for (const row of stripeSettingsRows) {
          stripeMap.set(row.key as string, row.value);
        }
        const secretKeyEnc = stripeMap.get('stripe.secretKeyEnc') as string | null;
        if (secretKeyEnc == null) return;

        const platformFeePercent = Number(stripeMap.get('stripe.platformFeePercent') ?? 0);

        const { decryptString } = await import('@evtivity/lib');
        const secretKey = decryptString(secretKeyEnc, encryptionKey);

        const Stripe = (await import('stripe')).default;
        const stripe = new Stripe(secretKey);

        const piParams: import('stripe').default.PaymentIntentCreateParams = {
          amount: platformPreAuthCents,
          currency: platformCurrency.toLowerCase(),
          customer: pm.stripe_customer_id as string,
          payment_method: pm.stripe_payment_method_id as string,
          capture_method: 'manual',
          confirm: true,
          off_session: true,
        };

        if (connectedAccountId != null) {
          piParams.on_behalf_of = connectedAccountId;
          piParams.transfer_data = { destination: connectedAccountId };
          if (platformFeePercent > 0) {
            piParams.application_fee_amount = Math.round(
              (platformPreAuthCents * platformFeePercent) / 100,
            );
          }
        }

        const paymentIntent = await stripe.paymentIntents.create(piParams);

        await sql`
            INSERT INTO payment_records (
              session_id, driver_id, site_payment_config_id,
              stripe_payment_intent_id, stripe_customer_id,
              payment_source, currency, pre_auth_amount_cents, status
            )
            VALUES (
              ${sessionId},
              ${driverId},
              ${siteConfigId},
              ${paymentIntent.id},
              ${pm.stripe_customer_id as string},
              'web_portal',
              ${platformCurrency},
              ${platformPreAuthCents},
              'pre_authorized'
            )
            ON CONFLICT (session_id) DO NOTHING
          `;
      } catch (err) {
        logger.error({ err }, 'Auto pre-auth failed, stopping session');
        const reason = err instanceof Error ? err.message.slice(0, 500) : 'Unknown pre-auth error';
        try {
          await sql`
              INSERT INTO payment_records (
                session_id, driver_id,
                stripe_customer_id, payment_source, currency,
                status, failure_reason
              )
              VALUES (
                ${sessionId},
                ${driverId},
                ${pm.stripe_customer_id as string},
                'web_portal',
                ${platformCurrency},
                'failed',
                ${reason}
              )
              ON CONFLICT (session_id) DO NOTHING
            `;
        } catch (dbErr) {
          logger.error({ err: dbErr }, 'Failed to record pre-auth failure');
        }

        await stopSession();

        try {
          void dispatchDriverNotification(
            sql,
            'payment.PreAuthFailed',
            driverId,
            {
              stationId: ocppStationId,
              transactionId,
              reason: reason.slice(0, 200),
            },
            ALL_TEMPLATES_DIRS,
            pubsub,
          );
        } catch {
          // Non-critical
        }

        try {
          await pubsub.publish(
            'csms_events',
            JSON.stringify({
              type: 'payment.preAuthFailed',
              sessionId,
              transactionId,
              reason: reason.slice(0, 200),
            }),
          );
        } catch {
          // Non-critical
        }
      }
    } else {
      // ---- Guest or anonymous session ----
      // Token resolution already happened in the first subscriber:
      //   driver_tokens -> ocpi_external_tokens -> guest_sessions
      // guestStatus/guestEmail are pre-resolved from that chain.

      if (guestStatus === 'payment_authorized') {
        // Valid guest session -- pre-auth done at checkout, allow
        return;
      }

      if (guestStatus != null) {
        // Guest session exists but not authorized
        logger.warn(
          `No valid guest session for idToken ${String(idToken).slice(0, 8)}..., stopping session ${transactionId}`,
        );
        await stopSession();
        if (guestEmail != null) {
          try {
            void dispatchSystemNotification(
              sql,
              'payment.PreAuthFailed',
              { email: guestEmail },
              {
                stationId: ocppStationId,
                transactionId,
                reason: 'Payment authorization not found',
              },
              ALL_TEMPLATES_DIRS,
            );
          } catch (notifyErr) {
            logger.error({ err: notifyErr }, 'Failed to notify guest of session stop');
          }
        }
        return;
      }

      // No driver, no roaming, no guest session -- stop unconditionally
      logger.warn(
        `Anonymous session ${transactionId} has no driver, no roaming token, and no guest session, stopping`,
      );
      await stopSession();
    }
  }

  // Payment auto-capture on session end (separate subscriber, no race with session creation)
  safeSubscribe('ocpp.TransactionEvent', async (event: DomainEvent) => {
    const payload = event.payload;
    const eventType = payload.eventType as string;
    const transactionId = payload.transactionId as string;

    if (eventType === 'Ended') {
      // Auto-capture on session end
      const sessionRows = await sql`
        SELECT cs.id, cs.final_cost_cents, cs2.site_id
        FROM charging_sessions cs
        JOIN charging_stations cs2 ON cs2.id = cs.station_id
        WHERE cs.transaction_id = ${transactionId}
      `;
      const session = sessionRows[0];
      if (session == null) return;

      const prRows = await sql`
        SELECT id, stripe_payment_intent_id, driver_id
        FROM payment_records
        WHERE session_id = ${session.id as string} AND status = 'pre_authorized'
        LIMIT 1
      `;
      if (prRows.length === 0) return;

      const pr = prRows[0];
      if (pr == null) return;
      const paymentIntentId = pr.stripe_payment_intent_id as string | null;
      if (paymentIntentId == null) return;

      const prDriverId = pr.driver_id as string | null;
      const finalCostCents = session.final_cost_cents as number | null;

      // Guest sessions: driver_id is null on the payment record.
      // The guest-session-worker handles capture for guest sessions via finalizeGuestPayment().
      // Skip here to avoid double-capture.
      if (prDriverId == null) return;

      // Simulated payment: bypass Stripe
      if (isSimulatedIntent(paymentIntentId)) {
        if (shouldSimulateFailure()) {
          logger.warn(`Simulated capture failure for session ${transactionId}`);
          try {
            await sql`
              UPDATE payment_records
              SET status = 'failed',
                  failure_reason = 'Simulated capture failure',
                  updated_at = now()
              WHERE id = ${pr.id as string}
            `;
          } catch (dbErr) {
            logger.error({ err: dbErr }, 'Failed to mark simulated capture as failed');
          }
          try {
            const amountFormatted = `$${((finalCostCents ?? 0) / 100).toFixed(2)}`;
            void dispatchDriverNotification(
              sql,
              'payment.CaptureFailed',
              prDriverId,
              {
                stationId: event.aggregateId,
                transactionId,
                amountFormatted,
                reason: 'Simulated capture failure',
              },
              ALL_TEMPLATES_DIRS,
              pubsub,
            );
          } catch (notifyErr) {
            logger.error(
              { err: notifyErr },
              'Failed to notify driver of simulated capture failure',
            );
          }
          return;
        }

        // Simulated success
        try {
          if (finalCostCents != null && finalCostCents > 0) {
            await sql`
              UPDATE payment_records
              SET status = 'captured',
                  captured_amount_cents = ${finalCostCents},
                  updated_at = now()
              WHERE id = ${pr.id as string}
            `;
            // Notify driver of successful payment
            void dispatchDriverNotification(
              sql,
              'session.PaymentReceived',
              prDriverId,
              {
                stationId: event.aggregateId,
                transactionId,
                amountCents: finalCostCents,
                currency: 'USD',
              },
              ALL_TEMPLATES_DIRS,
              pubsub,
            );
          } else {
            await sql`
              UPDATE payment_records
              SET status = 'cancelled',
                  captured_amount_cents = 0,
                  updated_at = now()
              WHERE id = ${pr.id as string}
            `;
          }
        } catch (err) {
          logger.error({ err }, 'Failed to update simulated payment record on session end');
        }
        return;
      }

      // Real Stripe capture
      const encryptionKey = config.SETTINGS_ENCRYPTION_KEY;

      try {
        const settingsRows = await sql`
          SELECT value FROM settings WHERE key = 'stripe.secretKeyEnc'
        `;
        const settingsRow = settingsRows[0];
        const secretKeyEnc = (settingsRow?.value as string | null) ?? null;
        if (secretKeyEnc == null) return;

        const { decryptString } = await import('@evtivity/lib');
        const secretKey = decryptString(secretKeyEnc, encryptionKey);
        const Stripe = (await import('stripe')).default;
        const stripe = new Stripe(secretKey);

        if (finalCostCents != null && finalCostCents > 0) {
          await stripe.paymentIntents.capture(paymentIntentId, {
            amount_to_capture: finalCostCents,
          });
          await sql`
            UPDATE payment_records
            SET status = 'captured', captured_amount_cents = ${finalCostCents}, updated_at = now()
            WHERE id = ${pr.id as string}
          `;

          // Driver notification: payment captured via Stripe
          const captureDriverRows = await sql`
            SELECT driver_id FROM payment_records WHERE id = ${pr.id as string}
          `;
          const captureDriver = captureDriverRows[0];
          if (captureDriver?.driver_id != null) {
            const captureSession = await sql`
              SELECT cs2.station_id AS station_ocpp_id, cs.currency, cs.station_id AS station_uuid
              FROM charging_sessions cs
              JOIN charging_stations cs2 ON cs2.id = cs.station_id
              WHERE cs.id = ${session.id as string}
            `;
            const cs = captureSession[0];
            const captureSiteName =
              cs?.station_uuid != null ? await resolveSiteName(cs.station_uuid as string) : null;
            void dispatchDriverNotification(
              sql,
              'session.PaymentReceived',
              captureDriver.driver_id as string,
              {
                siteName: captureSiteName ?? '',
                stationId: cs?.station_ocpp_id as string,
                transactionId,
                amountCents: finalCostCents,
                currency: (cs?.currency as string | null) ?? 'USD',
              },
              ALL_TEMPLATES_DIRS,
              pubsub,
            );
          }
        } else {
          await stripe.paymentIntents.cancel(paymentIntentId);
          await sql`
            UPDATE payment_records
            SET status = 'cancelled', captured_amount_cents = 0, updated_at = now()
            WHERE id = ${pr.id as string}
          `;
        }
      } catch (err) {
        logger.error({ err }, 'Auto capture/cancel failed');
        const captureReason =
          err instanceof Error ? err.message.slice(0, 500) : 'Unknown capture error';
        try {
          await sql`
            UPDATE payment_records
            SET status = 'failed', failure_reason = ${captureReason}, updated_at = now()
            WHERE id = ${pr.id as string}
          `;
        } catch (dbErr) {
          logger.error({ err: dbErr }, 'Failed to record capture failure');
        }

        try {
          const amountFormatted = `$${((finalCostCents ?? 0) / 100).toFixed(2)}`;
          void dispatchDriverNotification(
            sql,
            'payment.CaptureFailed',
            prDriverId,
            {
              stationId: event.aggregateId,
              transactionId,
              amountFormatted,
              reason: captureReason.slice(0, 200),
            },
            ALL_TEMPLATES_DIRS,
            pubsub,
          );
        } catch {
          // Non-critical
        }
      }
    }
  });

  // ---- OCPP Message Logging ----

  safeSubscribe('ocpp.MessageLog', async (event: DomainEvent) => {
    const payload = event.payload;
    const stationId = payload.stationId as string;
    const direction = payload.direction as string;
    const messageType = payload.messageType as number;
    const messageId = payload.messageId as string;
    const action = (payload.action as string | null) ?? null;
    const messagePayload = payload.payload as Record<string, unknown> | undefined;
    const errorCode = (payload.errorCode as string | null) ?? null;
    const errorDescription = (payload.errorDescription as string | null) ?? null;

    // Resolve station UUID (use stationDbId if provided, otherwise look up)
    let stationUuid = payload.stationDbId as string | null;
    if (stationUuid == null) {
      stationUuid = await resolveStationUuid(stationId);
    }
    if (stationUuid == null) return;

    const inserted = await sql`
      INSERT INTO ocpp_message_logs (station_id, direction, message_type, message_id, action, payload, error_code, error_description)
      SELECT ${stationUuid}, ${direction}, ${messageType}, ${messageId}, ${action}, ${JSON.stringify(messagePayload ?? {})}, ${errorCode}, ${errorDescription}
      WHERE EXISTS (SELECT 1 FROM charging_stations WHERE id = ${stationUuid})
    `;
    if (inserted.count === 0) {
      invalidateStationCache(stationId);
      return;
    }

    const siteId = await resolveSiteId(stationUuid);
    await notifyChange('ocpp.message', stationUuid, siteId);
  });

  // --- Display Message Projection ---

  safeSubscribe('ocpp.NotifyDisplayMessages', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const messageInfo = payload.messageInfo as Array<Record<string, unknown>> | undefined;
    if (messageInfo == null || messageInfo.length === 0) return;

    for (const msg of messageInfo) {
      const messageId = msg.id as number;
      const priority = getString(msg, 'priority') ?? 'NormalCycle';
      const messageContent = msg.message as Record<string, unknown> | undefined;
      const content = messageContent != null ? (getString(messageContent, 'content') ?? '') : '';
      const format =
        messageContent != null ? (getString(messageContent, 'format') ?? 'UTF8') : 'UTF8';
      const language = messageContent != null ? getString(messageContent, 'language') : null;
      const state = getString(msg, 'state');
      const startDateTime = getString(msg, 'startDateTime');
      const endDateTime = getString(msg, 'endDateTime');
      const transactionId = getString(msg, 'transactionId');
      const display = msg.display as Record<string, unknown> | undefined;
      const displayEvse = display?.evse as Record<string, unknown> | undefined;
      const evseId = displayEvse?.evseId as number | undefined;

      const dmInserted = await sql`
        INSERT INTO display_messages (station_id, ocpp_message_id, priority, status, state, format, language, content, start_date_time, end_date_time, transaction_id, evse_id)
        SELECT ${stationUuid}, ${messageId}, ${priority}, 'accepted', ${state}, ${format}, ${language}, ${content}, ${startDateTime}, ${endDateTime}, ${transactionId}, ${evseId ?? null}
        WHERE EXISTS (SELECT 1 FROM charging_stations WHERE id = ${stationUuid})
        ON CONFLICT (station_id, ocpp_message_id) DO UPDATE SET
          priority = EXCLUDED.priority,
          content = EXCLUDED.content,
          format = EXCLUDED.format,
          language = EXCLUDED.language,
          state = EXCLUDED.state,
          start_date_time = EXCLUDED.start_date_time,
          end_date_time = EXCLUDED.end_date_time,
          transaction_id = EXCLUDED.transaction_id,
          evse_id = EXCLUDED.evse_id,
          status = 'accepted',
          updated_at = now()
      `;
      if (dmInserted.count === 0) {
        invalidateStationCache(event.aggregateId);
        return;
      }
    }

    const siteId = await resolveSiteId(stationUuid);
    await notifyChange('displayMessage.updated', stationUuid, siteId);
  });

  // --- PnC Certificate Projections ---

  safeSubscribe('pnc.CsrSigned', async (event: DomainEvent) => {
    const stationUuid = await getStationUuid(event);
    if (stationUuid == null) return;

    const payload = event.payload;
    const { handleCsrSigned } = await import('../services/pki/certificate-projections.js');
    await handleCsrSigned(
      sql,
      event.aggregateId,
      stationUuid,
      {
        certificateChain: payload.certificateChain as string,
        certificateType: payload.certificateType as string,
        providerReference: payload.providerReference as string,
      },
      pubsub,
    );

    const siteId = await resolveSiteId(stationUuid);
    await notifyChange('certificate.signed', stationUuid, siteId);
  });

  safeSubscribe('pnc.InstallCertificateResult', async (event: DomainEvent) => {
    const stationUuid = await getStationUuid(event);
    if (stationUuid == null) return;

    const payload = event.payload;
    const { handleInstallCertificateResult } =
      await import('../services/pki/certificate-projections.js');
    await handleInstallCertificateResult(
      sql,
      stationUuid,
      payload.certificate as string,
      payload.certificateType as string,
      payload.status as string,
    );

    const siteId = await resolveSiteId(stationUuid);
    await notifyChange('certificate.signed', stationUuid, siteId);
  });

  // --- Notification dispatch ---

  const notifiableEvents = [
    'station.Connected',
    'station.Disconnected',
    'ocpp.Authorize',
    'ocpp.BootNotification',
    'ocpp.DataTransfer',
    'ocpp.FirmwareStatusNotification',
    'ocpp.Heartbeat',
    'ocpp.MeterValues',
    'ocpp.SecurityEventNotification',
    'ocpp.StatusNotification',
    'ocpp.TransactionEvent',
    'ocpp.NotifyEvent',
  ];

  for (const eventType of notifiableEvents) {
    safeSubscribe(eventType, async (event: DomainEvent) => {
      await dispatchOcppNotification(sql, event);
    });
  }

  // --- Reservation expiry check (every 60s) ---

  const RESERVATION_CHECK_INTERVAL_MS = 60_000;
  const EXPIRY_WARNING_MINUTES = 15;

  async function checkReservationExpiry(): Promise<void> {
    try {
      // Expire active reservations past their expiresAt
      const expired = await sql`
        UPDATE reservations
        SET status = 'expired', updated_at = now()
        WHERE status = 'active' AND expires_at < now()
        RETURNING id, driver_id
      `;

      for (const row of expired) {
        if (row.driver_id != null) {
          void dispatchDriverNotification(
            sql,
            'reservation.Expired',
            row.driver_id as string,
            {
              reservationId: row.id as string,
            },
            ALL_TEMPLATES_DIRS,
            pubsub,
          );
        }
      }

      // Warn about reservations expiring within the warning window
      const warningThreshold = new Date(Date.now() + EXPIRY_WARNING_MINUTES * 60 * 1000);
      const expiringSoon = await sql`
        SELECT id, driver_id, expires_at FROM reservations
        WHERE status = 'active'
          AND expires_at > now()
          AND expires_at <= ${warningThreshold}
      `;

      for (const row of expiringSoon) {
        if (row.driver_id != null) {
          void dispatchDriverNotification(
            sql,
            'reservation.Expiring',
            row.driver_id as string,
            {
              reservationId: row.id as string,
              expiresAt: (row.expires_at as Date).toISOString(),
            },
            ALL_TEMPLATES_DIRS,
            pubsub,
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Reservation expiry check failed');
    }
  }

  if (isPrimary) {
    setInterval(() => {
      void checkReservationExpiry();
    }, RESERVATION_CHECK_INTERVAL_MS);
  }

  // ---- OCPP Operational Data Projections ----

  safeSubscribe('ocpp.NotifyEvent', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const generatedAt = payload.generatedAt as string;
    const seqNo = (payload.seqNo as number | undefined) ?? 0;
    const tbc = (payload.tbc as boolean | undefined) ?? false;
    const eventData = (payload.eventData ?? []) as Array<Record<string, unknown>>;

    const inserted = await sql`
      INSERT INTO station_events (station_id, generated_at, seq_no, tbc, event_data)
      VALUES (${stationUuid}, ${generatedAt}, ${seqNo}, ${tbc}, ${JSON.stringify(eventData)}::jsonb)
      RETURNING id
    `;
    const stationEventId = inserted[0]?.id as number | undefined;

    // Alerting: check for alerting/critical events
    for (const item of eventData) {
      const trigger = (item.trigger as string | undefined) ?? '';
      const severity = (item.severity as number | undefined) ?? 9;
      const component = item.component as Record<string, unknown> | undefined;
      const variable = item.variable as Record<string, unknown> | undefined;
      const componentName = (component?.name as string | undefined) ?? '';
      const variableName = (variable?.name as string | undefined) ?? '';
      const actualValue = (item.actualValue as string | undefined) ?? null;
      const techInfo = (item.techInfo as string | undefined) ?? null;

      // Fire alert for Alerting trigger or severity 0-2 (Danger/Emergency/Safety)
      if (trigger === 'Alerting' || severity <= 2) {
        try {
          // Check if a matching rule exists
          const rules = await sql`
            SELECT id, min_severity FROM event_alert_rules
            WHERE is_enabled = true
              AND component = ${componentName}
              AND variable = ${variableName}
              AND min_severity >= ${severity}
            LIMIT 1
          `;
          const ruleId = (rules[0]?.id as number | undefined) ?? null;

          // Insert alert if rule matched OR severity is critical (0-1)
          if (ruleId != null || severity <= 1) {
            await sql`
              INSERT INTO event_alerts (station_id, station_event_id, rule_id, component, variable, severity, trigger, actual_value, tech_info)
              VALUES (${stationUuid}, ${stationEventId ?? null}, ${ruleId}, ${componentName}, ${variableName}, ${severity}, ${trigger}, ${actualValue}, ${techInfo})
            `;
          }
        } catch {
          // Non-critical: do not break event persistence
        }
      }
    }

    const siteId = await resolveSiteId(stationUuid);
    await notifyChange('station.event', stationUuid, siteId);
  });

  safeSubscribe('ocpp.NotifyMonitoringReport', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const requestId = payload.requestId as number;
    const seqNo = (payload.seqNo as number | undefined) ?? 0;
    const generatedAt = payload.generatedAt as string;
    const tbc = (payload.tbc as boolean | undefined) ?? false;
    const monitor = payload.monitor ?? null;

    await sql`
      INSERT INTO monitoring_reports (station_id, request_id, seq_no, generated_at, tbc, monitor)
      VALUES (${stationUuid}, ${requestId}, ${seqNo}, ${generatedAt}, ${tbc}, ${monitor != null ? JSON.stringify(monitor) : null}::jsonb)
    `;
  });

  safeSubscribe('ocpp.ReportChargingProfiles', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const evseId = (payload.evseId as number | undefined) ?? null;
    const requestId = (payload.requestId as number | undefined) ?? null;
    const chargingLimitSource = (payload.chargingLimitSource as string | undefined) ?? null;
    const tbc = (payload.tbc as boolean | undefined) ?? false;
    const chargingProfile = payload.chargingProfile ?? [];

    // Delete existing station-reported profiles for this station+evse to avoid duplicates on refresh
    await sql`
      DELETE FROM charging_profiles
      WHERE station_id = ${stationUuid} AND source = 'station_reported'
        AND COALESCE(evse_id, -1) = COALESCE(${evseId}::int, -1)
    `;
    await sql`
      INSERT INTO charging_profiles (station_id, source, evse_id, request_id, charging_limit_source, tbc, profile_data, reported_at)
      VALUES (${stationUuid}, 'station_reported', ${evseId}, ${requestId}, ${chargingLimitSource}, ${tbc}, ${JSON.stringify(chargingProfile)}::jsonb, now())
    `;
  });

  safeSubscribe('ocpp.NotifyReport', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const reportData = payload.reportData as Array<Record<string, unknown>> | undefined;
    if (reportData == null || reportData.length === 0) return;

    for (const entry of reportData) {
      const component = entry.component as Record<string, unknown> | undefined;
      if (component == null) continue;
      const componentName = (component.name as string | undefined) ?? '';
      const componentInstance = (component.instance as string | undefined) ?? null;
      const evse = component.evse as Record<string, unknown> | undefined;
      const evseId = evse != null ? ((evse.id as number | undefined) ?? null) : null;
      const connectorId = evse != null ? ((evse.connectorId as number | undefined) ?? null) : null;

      const variable = entry.variable as Record<string, unknown> | undefined;
      if (variable == null) continue;
      const variableName = (variable.name as string | undefined) ?? '';
      const variableInstance = (variable.instance as string | undefined) ?? null;

      const variableAttribute = entry.variableAttribute as
        | Array<Record<string, unknown>>
        | undefined;
      if (variableAttribute == null) continue;

      for (const attr of variableAttribute) {
        const attrType = (attr.type as string | undefined) ?? 'Actual';
        const value = attr.value != null ? String(attr.value as string | number) : null;

        await sql`
          INSERT INTO station_configurations (station_id, component, instance, evse_id, connector_id, variable, variable_instance, value, attribute_type, source)
          VALUES (${stationUuid}, ${componentName}, ${componentInstance}, ${evseId}, ${connectorId}, ${variableName}, ${variableInstance}, ${value}, ${attrType}, 'NotifyReport')
          ON CONFLICT (station_id, component, variable, (COALESCE(evse_id, -1)), (COALESCE(connector_id, -1)), attribute_type)
          DO UPDATE SET value = EXCLUDED.value, source = 'NotifyReport', updated_at = now()
        `;
      }
    }
  });

  safeSubscribe('ocpp.NotifyCustomerInformation', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const requestId = payload.requestId as number;
    const seqNo = (payload.seqNo as number | undefined) ?? 0;
    const generatedAt = (payload.generatedAt as string | undefined) ?? new Date().toISOString();
    const tbc = (payload.tbc as boolean | undefined) ?? false;
    const data = (payload.data as string | undefined) ?? '';

    await sql`
      INSERT INTO customer_information_reports (station_id, request_id, seq_no, generated_at, tbc, data)
      VALUES (${stationUuid}, ${requestId}, ${seqNo}, ${generatedAt}, ${tbc}, ${data})
    `;
  });

  safeSubscribe('ocpp.LogStatusNotification', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const status = (payload.status as string | undefined) ?? '';
    const requestId = (payload.requestId as number | undefined) ?? null;
    const statusInfo = payload.statusInfo != null ? JSON.stringify(payload.statusInfo) : null;

    if (requestId != null) {
      const updated = await sql`
        UPDATE log_uploads
        SET status = ${status}, status_info = ${statusInfo}::jsonb, last_status_at = now(), updated_at = now()
        WHERE station_id = ${stationUuid} AND request_id = ${requestId}
      `;
      if (updated.count === 0) {
        await sql`
          INSERT INTO log_uploads (station_id, request_id, status, status_info, last_status_at)
          VALUES (${stationUuid}, ${requestId}, ${status}, ${statusInfo}::jsonb, now())
        `;
      }
    } else {
      // No requestId: insert new row
      await sql`
        INSERT INTO log_uploads (station_id, status, status_info, last_status_at)
        VALUES (${stationUuid}, ${status}, ${statusInfo}::jsonb, now())
      `;
    }
  });

  // ---- 1.6 DiagnosticsStatusNotification ----

  safeSubscribe('ocpp.DiagnosticsStatus', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const rawStatus = (payload.status as string | undefined) ?? '';

    // Map 1.6 status values to log_upload_status enum
    const STATUS_MAP: Record<string, string> = {
      Idle: 'Idle',
      Uploaded: 'Uploaded',
      UploadFailed: 'UploadFailed',
      Uploading: 'Uploading',
    };
    const status = STATUS_MAP[rawStatus] ?? rawStatus;

    // Update the most recent log_uploads row for this station
    const updated = await sql`
      UPDATE log_uploads
      SET status = ${status}, last_status_at = now(), updated_at = now()
      WHERE id = (
        SELECT id FROM log_uploads
        WHERE station_id = ${stationUuid}
        ORDER BY created_at DESC LIMIT 1
      )
    `;

    if (updated.count === 0) {
      await sql`
        INSERT INTO log_uploads (station_id, log_type, status, last_status_at)
        VALUES (${stationUuid}, 'DiagnosticsLog', ${status}, now())
      `;
    }
  });

  // ---- Command Tracking Projections ----

  safeSubscribe('command.SetChargingProfile', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const request = event.payload.request as Record<string, unknown>;
    const evseId = (request.evseId as number | undefined) ?? null;
    const csProfile = request.csChargingProfiles ?? request.chargingProfile ?? null;

    await sql`
      INSERT INTO charging_profiles (station_id, source, evse_id, profile_data, sent_at)
      VALUES (${stationUuid}, 'csms_set', ${evseId}, ${JSON.stringify(csProfile)}::jsonb, now())
    `;
  });

  safeSubscribe('command.GetVariables', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const response = event.payload.response as Record<string, unknown>;
    const results = response.getVariableResult as Array<Record<string, unknown>> | undefined;
    if (results == null) return;

    for (const result of results) {
      const attrStatus = result.attributeStatus as string | undefined;
      if (attrStatus !== 'Accepted') continue;

      const component = result.component as Record<string, unknown> | undefined;
      if (component == null) continue;
      const componentName = (component.name as string | undefined) ?? '';
      const componentInstance = (component.instance as string | undefined) ?? null;
      const evse = component.evse as Record<string, unknown> | undefined;
      const evseId = evse != null ? ((evse.id as number | undefined) ?? null) : null;
      const connectorId = evse != null ? ((evse.connectorId as number | undefined) ?? null) : null;

      const variable = result.variable as Record<string, unknown> | undefined;
      if (variable == null) continue;
      const variableName = (variable.name as string | undefined) ?? '';
      const variableInstance = (variable.instance as string | undefined) ?? null;

      const attrType = (result.attributeType as string | undefined) ?? 'Actual';
      const value =
        result.attributeValue != null ? String(result.attributeValue as string | number) : null;

      await sql`
        INSERT INTO station_configurations (station_id, component, instance, evse_id, connector_id, variable, variable_instance, value, attribute_type, source)
        VALUES (${stationUuid}, ${componentName}, ${componentInstance}, ${evseId}, ${connectorId}, ${variableName}, ${variableInstance}, ${value}, ${attrType}, 'GetVariables')
        ON CONFLICT (station_id, component, variable, (COALESCE(evse_id, -1)), (COALESCE(connector_id, -1)), attribute_type)
        DO UPDATE SET value = EXCLUDED.value, source = 'GetVariables', updated_at = now()
      `;
    }
  });

  safeSubscribe('command.GetConfiguration', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const response = event.payload.response as Record<string, unknown>;
    const configKeys = response.configurationKey as Array<Record<string, unknown>> | undefined;
    if (configKeys == null) return;

    for (const configKey of configKeys) {
      const key = (configKey.key as string | undefined) ?? '';
      const value = configKey.value != null ? String(configKey.value as string | number) : null;
      if (key === '') continue;

      await sql`
        INSERT INTO station_configurations (station_id, component, variable, value, attribute_type, source)
        VALUES (${stationUuid}, 'OCPP', ${key}, ${value}, 'Actual', 'GetConfiguration')
        ON CONFLICT (station_id, component, variable, (COALESCE(evse_id, -1)), (COALESCE(connector_id, -1)), attribute_type)
        DO UPDATE SET value = EXCLUDED.value, source = 'GetConfiguration', updated_at = now()
      `;
    }
  });

  safeSubscribe('command.UpdateFirmware', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const request = event.payload.request as Record<string, unknown>;
    const requestId = (request.requestId as number | undefined) ?? null;
    // 2.1: firmware.location, 1.6: location
    const firmware = request.firmware as Record<string, unknown> | undefined;
    const firmwareUrl =
      firmware != null
        ? ((firmware.location as string | undefined) ?? '')
        : ((request.location as string | undefined) ?? '');
    const retrieveDateTime =
      firmware != null
        ? ((firmware.retrieveDateTime as string | undefined) ?? null)
        : ((request.retrieveDate as string | undefined) ?? null);

    await sql`
      INSERT INTO firmware_updates (station_id, request_id, firmware_url, retrieve_date_time, initiated_at)
      VALUES (${stationUuid}, ${requestId}, ${firmwareUrl}, ${retrieveDateTime}, now())
    `;
  });

  safeSubscribe('command.GetLog', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const request = event.payload.request as Record<string, unknown>;
    const requestId = (request.requestId as number | undefined) ?? null;
    const logType = (request.logType as string | undefined) ?? null;
    const log = request.log as Record<string, unknown> | undefined;
    const remoteLocation = log != null ? ((log.remoteLocation as string | undefined) ?? '') : null;

    await sql`
      INSERT INTO log_uploads (station_id, request_id, log_type, remote_location, initiated_at)
      VALUES (${stationUuid}, ${requestId}, ${logType}, ${remoteLocation}, now())
    `;
  });

  safeSubscribe('command.GetDiagnostics', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const request = event.payload.request as Record<string, unknown>;
    const location = (request.location as string | undefined) ?? null;

    await sql`
      INSERT INTO log_uploads (station_id, log_type, remote_location, initiated_at)
      VALUES (${stationUuid}, 'DiagnosticsLog', ${location}, now())
    `;
  });

  // ---- EV Charging Needs and Schedules ----

  safeSubscribe('ocpp.NotifyEVChargingNeeds', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const evseId = payload.evseId as number;
    const chargingNeeds = payload.chargingNeeds as Record<string, unknown>;
    const departureTime = (chargingNeeds.departureTime as string | undefined) ?? null;
    const requestedEnergyTransfer =
      (chargingNeeds.requestedEnergyTransfer as string | undefined) ?? null;
    const controlMode = (payload.controlMode as string | undefined) ?? null;
    const maxScheduleTuples = (payload.maxScheduleTuples as number | undefined) ?? null;

    await sql`
      INSERT INTO ev_charging_needs (station_id, evse_id, charging_needs, departure_time, requested_energy_transfer, control_mode, max_schedule_tuples)
      VALUES (${stationUuid}, ${evseId}, ${JSON.stringify(chargingNeeds)}::jsonb, ${departureTime}, ${requestedEnergyTransfer}, ${controlMode}, ${maxScheduleTuples})
      ON CONFLICT (station_id, evse_id)
      DO UPDATE SET charging_needs = EXCLUDED.charging_needs, departure_time = EXCLUDED.departure_time,
        requested_energy_transfer = EXCLUDED.requested_energy_transfer, control_mode = EXCLUDED.control_mode,
        max_schedule_tuples = EXCLUDED.max_schedule_tuples, updated_at = now()
    `;

    const siteId = await resolveSiteId(stationUuid);
    await notifyChange('station.evChargingNeeds', stationUuid, siteId);

    // Compute and send ISO 15118 charging profile
    try {
      const { computeAndSendChargingProfile } =
        await import('../services/charging-profile-computer.js');
      await computeAndSendChargingProfile(sql, pubsub, {
        stationUuid,
        stationOcppId: event.aggregateId,
        evseId,
        chargingNeeds,
        maxScheduleTuples,
      });
    } catch (err) {
      logger.error({ err }, 'ISO 15118 profile computation failed');
    }
  });

  safeSubscribe('ocpp.NotifyEVChargingSchedule', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const evseId = (payload.evseId as number | undefined) ?? 0;
    const timeBase = (payload.timeBase as string | undefined) ?? null;
    const chargingSchedule = payload.chargingSchedule ?? {};

    await sql`
      INSERT INTO ev_charging_schedules (station_id, evse_id, time_base, charging_schedule)
      VALUES (${stationUuid}, ${evseId}, ${timeBase}, ${JSON.stringify(chargingSchedule)}::jsonb)
    `;
  });

  // ---- Offline Command Queue ----

  safeSubscribe('command.Queued', async (event: DomainEvent) => {
    const payload = event.payload;
    const commandId = payload.commandId as string;
    const stationId = payload.stationId as string;
    const action = payload.action as string;
    const cmdPayload = payload.payload as Record<string, unknown>;
    const version = (payload.version as string | undefined) ?? null;

    const ttlHours = await getOfflineCommandTtlHours();

    await sql`
      INSERT INTO offline_command_queue (station_id, command_id, action, payload, version, expires_at)
      VALUES (
        ${stationId}, ${commandId}, ${action},
        ${JSON.stringify(cmdPayload)}::jsonb, ${version},
        now() + ${String(ttlHours) + ' hours'}::interval
      )
      ON CONFLICT (command_id) DO NOTHING
    `;
  });

  // Periodic expiry cleanup for offline command queue (every 5 minutes)
  if (isPrimary) {
    setInterval(
      () => {
        void sql`
        UPDATE offline_command_queue SET status = 'expired'
        WHERE status = 'pending' AND expires_at <= now()
      `.catch(() => {
          // Non-critical cleanup
        });
      },
      5 * 60 * 1000,
    );
  }

  // ---- OCPP 2.1 Stub Persistence ----

  safeSubscribe('ocpp.BatterySwap', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const eventType = (payload.eventType as string | undefined) ?? 'Unknown';
    const transactionId = (payload.transactionId as string | undefined) ?? null;
    const idToken = payload.idToken ?? null;

    await sql`
      INSERT INTO battery_swap_events (station_id, event_type, transaction_id, id_token)
      VALUES (${stationUuid}, ${eventType}, ${transactionId}, ${idToken != null ? JSON.stringify(idToken) : null}::jsonb)
    `;
  });

  safeSubscribe('ocpp.NotifyPeriodicEventStream', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const streamId = (payload.id as number | undefined) ?? 0;
    const data = payload.data ?? [];

    await sql`
      INSERT INTO periodic_event_streams (station_id, stream_id, data)
      VALUES (${stationUuid}, ${streamId}, ${JSON.stringify(data)}::jsonb)
    `;
  });

  safeSubscribe('ocpp.NotifyQRCodeScanned', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const evseId = (payload.evseId as number | undefined) ?? null;
    const timeout = (payload.timeout as number | undefined) ?? null;

    await sql`
      INSERT INTO qr_scan_events (station_id, evse_id, timeout)
      VALUES (${stationUuid}, ${evseId}, ${timeout})
    `;
  });

  safeSubscribe('ocpp.VatNumberValidation', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const vatNumber = (payload.vatNumber as string | undefined) ?? null;
    const evseId = (payload.evseId as number | undefined) ?? null;

    await sql`
      INSERT INTO vat_number_validations (station_id, vat_number, evse_id)
      VALUES (${stationUuid}, ${vatNumber}, ${evseId})
    `;
  });

  safeSubscribe('ocpp.NotifyWebPaymentStarted', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const evseId = (payload.evseId as number | undefined) ?? null;
    const timeout = (payload.timeout as number | undefined) ?? null;

    await sql`
      INSERT INTO web_payment_events (station_id, evse_id, timeout)
      VALUES (${stationUuid}, ${evseId}, ${timeout})
    `;
  });

  safeSubscribe('ocpp.NotifyAllowedEnergyTransfer', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const transactionId = (payload.transactionId as string | undefined) ?? null;
    const allowedEnergyTransfer = payload.allowedEnergyTransfer ?? null;

    await sql`
      INSERT INTO allowed_energy_transfer_events (station_id, transaction_id, allowed_energy_transfer)
      VALUES (${stationUuid}, ${transactionId}, ${allowedEnergyTransfer != null ? JSON.stringify(allowedEnergyTransfer) : null}::jsonb)
    `;
  });

  safeSubscribe('ocpp.NotifyDERAlarm', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const controlType = (payload.controlType as string | undefined) ?? null;
    const ts = (payload.timestamp as string | undefined) ?? null;
    const gridEventFault = payload.gridEventFault ?? null;

    await sql`
      INSERT INTO der_alarm_events (station_id, control_type, timestamp, grid_event_fault)
      VALUES (${stationUuid}, ${controlType}, ${ts}, ${gridEventFault != null ? JSON.stringify(gridEventFault) : null}::jsonb)
    `;
  });

  safeSubscribe('ocpp.NotifyDERStartStop', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const controlType = (payload.controlType as string | undefined) ?? null;
    const started = (payload.started as boolean | undefined) ?? null;
    const ts = (payload.timestamp as string | undefined) ?? null;

    await sql`
      INSERT INTO der_start_stop_events (station_id, control_type, started, timestamp)
      VALUES (${stationUuid}, ${controlType}, ${started}, ${ts})
    `;
  });

  safeSubscribe('ocpp.ReportDERControl', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const requestId = (payload.requestId as number | undefined) ?? null;
    const seqNo = (payload.seqNo as number | undefined) ?? null;
    const tbc = (payload.tbc as boolean | undefined) ?? false;
    const derControl = payload.derControl ?? null;

    await sql`
      INSERT INTO der_control_reports (station_id, request_id, seq_no, tbc, der_control)
      VALUES (${stationUuid}, ${requestId}, ${seqNo}, ${tbc}, ${derControl != null ? JSON.stringify(derControl) : null}::jsonb)
    `;
  });

  // --- Certificate Expiration Monitor ---
  if (isPrimary) {
    void import('../services/pki/expiration-monitor.js').then(({ startExpirationMonitor }) => {
      startExpirationMonitor(sql, pubsub);
    });
  }
}
