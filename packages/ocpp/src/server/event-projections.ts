// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import postgres from 'postgres';
import type { EventBus, DomainEvent, PubSubClient, ConnectionRegistry } from '@evtivity/lib';

// postgres-js `sql.json` takes a strict JSONValue (objects whose values are JSONValue,
// not `unknown`). We hand it OCPP payloads typed loosely as Record<string, unknown>;
// the values are always JSON-serializable at runtime, so we widen via this helper.
type JSONValue = Parameters<postgres.Sql['json']>[0];
const asJson = (v: unknown): JSONValue => v as JSONValue;
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
  writeReservationAudit,
  writeAudit,
  firmwareCampaignAuditLog,
  stationAuditLog,
  isAutoDisableOnCriticalEnabled,
} from '@evtivity/database';
import { getSecuritySeverity } from '../lib/security-severity.js';
import {
  calculateSessionCost,
  calculateSplitSessionCost,
  resolveActiveTariff,
  generateId,
  createLogger,
  calculateCo2AvoidedKg,
  isSimulatedCustomer,
  shouldSimulatePaymentFailure,
  isTariffFree,
  dispatchOneShotStationMessage,
} from '@evtivity/lib';
import type {
  TariffInput,
  TariffRestrictions,
  TariffWithRestrictions,
  TariffSegment,
  StationMessageState,
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
  const sql = postgres(databaseUrl);
  const logger = createLogger('event-projections');

  // Write a `session_failed` reservation audit row when a charging session
  // that was linked to a reservation ends in a non-success state. Covers the
  // four fault paths that bypass the normal TransactionEvent.Ended flow:
  // stale-session sweep, EVConnectTimeout on Started, payment-gate eager
  // cleanup, and the Ended-handler timeout/faulted branch. No-op when the
  // session has no reservation_id. Best-effort; audit failure does not roll
  // back the underlying session state change.
  async function auditLinkedReservationFault(sessionId: string, reason: string): Promise<void> {
    try {
      const rows = await sql<{ reservation_id: string | null }[]>`
        SELECT reservation_id FROM charging_sessions WHERE id = ${sessionId} LIMIT 1
      `;
      const reservationId = rows[0]?.reservation_id ?? null;
      if (reservationId == null) return;
      await writeReservationAudit(
        {
          reservationId,
          action: 'session_failed',
          actor: 'system',
          notes: `session ${sessionId}: ${reason}`,
        },
        undefined,
        logger,
      );
    } catch (err) {
      logger.warn({ err, sessionId }, 'Failed to write session_failed reservation audit');
    }
  }

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
  const txBuffer = new TransactionBuffer({ logger });

  const SESSION_UPDATE_THROTTLE_MS = 15 * 60 * 1000;

  // CostUpdated dispatch throttle per session. Every MeterValues whose cost
  // changes (even by 1 cent) would otherwise publish a CostUpdated command,
  // producing ~6/min per active session. At 2000 sessions that is 12k
  // commands/min, drowning the pub/sub layer and the station&#39;s OCPP queue.
  // Cap to one dispatch per session per 30 seconds; the prior "no-change"
  // guard still skips when cost is identical, so we only throttle the
  // chatter, not real updates.
  const COST_UPDATED_THROTTLE_MS = 30_000;
  const lastCostUpdatedAt = new Map<string, number>();

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
    extra?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const payload = JSON.stringify({
        eventType,
        stationId,
        siteId,
        sessionId: sessionId ?? null,
        ...(extra ?? {}),
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

  function isSimulatedIntent(stripePaymentIntentId: string): boolean {
    return stripePaymentIntentId.startsWith('pi_sim_');
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
    // Resolve the same pricing group the API would (driver > fleet > station >
    // site > default), then load ALL active tariffs in that group plus the
    // configured holidays, and let resolveActiveTariff pick the time-of-day +
    // holiday-appropriate tariff. This matches the API's resolveTariff() so
    // free off-peak windows on a paid default tariff don't get billed.
    const groupRows = await sql`
      WITH driver_group AS (
        SELECT pgd.pricing_group_id AS id, 1 AS priority
        FROM pricing_group_drivers pgd
        WHERE pgd.driver_id = ${driverId ?? ''}
        LIMIT 1
      ),
      fleet_group AS (
        -- A driver can belong to multiple fleets (no unique constraint on
        -- fleet_drivers.driver_id). Order by membership createdAt so the
        -- oldest fleet wins deterministically; without ORDER BY Postgres
        -- returns rows in undefined order and the same driver/station could
        -- resolve to different tariffs across requests. Mirrors the API-side
        -- tariff.service.ts resolveTariffGroup().
        SELECT pgf.pricing_group_id AS id, 2 AS priority
        FROM pricing_group_fleets pgf
        JOIN fleet_drivers fd ON fd.fleet_id = pgf.fleet_id
        WHERE fd.driver_id = ${driverId ?? ''}
        ORDER BY fd.created_at ASC
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
      )
      SELECT id FROM (
        SELECT id, priority FROM driver_group
        UNION ALL SELECT id, priority FROM fleet_group
        UNION ALL SELECT id, priority FROM station_group
        UNION ALL SELECT id, priority FROM site_group
        UNION ALL SELECT id, priority FROM default_group
      ) groups
      ORDER BY priority
      LIMIT 1
    `;
    const groupId = groupRows[0]?.id as string | undefined;
    if (groupId == null) return true;

    const tariffRows = await sql`
      SELECT id, currency, price_per_kwh, price_per_minute, price_per_session,
             idle_fee_price_per_minute, reservation_fee_per_minute, tax_rate,
             restrictions, priority, is_default
      FROM tariffs
      WHERE pricing_group_id = ${groupId} AND is_active = true
    `;
    if (tariffRows.length === 0) return true;

    const holidayRows = await sql`SELECT date FROM pricing_holidays`;
    const holidays = holidayRows.map((r: Record<string, unknown>) => new Date(r.date as string));

    const tariffsForResolver: TariffWithRestrictions[] = tariffRows.map(
      (t: Record<string, unknown>) => ({
        id: t.id as string,
        restrictions: (t.restrictions as TariffRestrictions | null) ?? null,
        priority: Number(t.priority ?? 0),
        isDefault: t.is_default === true,
        currency: (t.currency as string | null) ?? 'USD',
        pricePerKwh: t.price_per_kwh as string | null,
        pricePerMinute: t.price_per_minute as string | null,
        pricePerSession: t.price_per_session as string | null,
        idleFeePricePerMinute: t.idle_fee_price_per_minute as string | null,
        reservationFeePerMinute: t.reservation_fee_per_minute as string | null,
        taxRate: t.tax_rate as string | null,
      }),
    );

    // Resolve in the station's site timezone so off-peak windows fire at the
    // operator's local clock, not UTC.
    const tzRows = await sql<Array<{ timezone: string | null }>>`
      SELECT s.timezone
      FROM charging_stations cs
      LEFT JOIN sites s ON s.id = cs.site_id
      WHERE cs.id = ${stationId}
      LIMIT 1
    `;
    const timezone = tzRows[0]?.timezone ?? undefined;
    const active = resolveActiveTariff(tariffsForResolver, new Date(), holidays, 0, timezone);
    return isTariffFree(active);
  }

  async function resolvePricingGroupId(
    stationUuid: string,
    driverUuid: string | null,
  ): Promise<string | null> {
    // Single round-trip 5-tier resolution: driver > fleet > station > site >
    // default. Each branch is a CTE that emits at most one row with its
    // priority number; the final SELECT orders by priority and returns the
    // winner. Mirrors the same shape used by isTariffFreeForStation() above
    // so both call sites pay one RTT instead of up to five. Called per
    // MeterValues batch per active session, so the savings compound under
    // load (2000 sessions × ~10s cadence × 4 saved RTTs = ~800 fewer RTTs/s).
    //
    // fleet_drivers has no unique constraint on driver_id; a driver can
    // belong to multiple fleets, and the oldest membership wins
    // deterministically. Without ORDER BY the same driver could resolve to
    // different tariffs across requests.
    const rows = await sql`
      WITH driver_group AS (
        SELECT pgd.pricing_group_id AS id, 1 AS priority
        FROM pricing_group_drivers pgd
        WHERE pgd.driver_id = ${driverUuid ?? ''}
        LIMIT 1
      ),
      fleet_group AS (
        SELECT pgf.pricing_group_id AS id, 2 AS priority
        FROM pricing_group_fleets pgf
        JOIN fleet_drivers fd ON fd.fleet_id = pgf.fleet_id
        WHERE fd.driver_id = ${driverUuid ?? ''}
        ORDER BY fd.created_at ASC
        LIMIT 1
      ),
      station_group AS (
        SELECT pgs.pricing_group_id AS id, 3 AS priority
        FROM pricing_group_stations pgs
        WHERE pgs.station_id = ${stationUuid}
        LIMIT 1
      ),
      site_group AS (
        SELECT pgsit.pricing_group_id AS id, 4 AS priority
        FROM pricing_group_sites pgsit
        JOIN charging_stations cs ON cs.site_id = pgsit.site_id
        WHERE cs.id = ${stationUuid}
        LIMIT 1
      ),
      default_group AS (
        SELECT pg.id, 5 AS priority
        FROM pricing_groups pg
        WHERE pg.is_default = true
        LIMIT 1
      )
      SELECT id FROM (
        SELECT id, priority FROM driver_group
        UNION ALL SELECT id, priority FROM fleet_group
        UNION ALL SELECT id, priority FROM station_group
        UNION ALL SELECT id, priority FROM site_group
        UNION ALL SELECT id, priority FROM default_group
      ) groups
      ORDER BY priority
      LIMIT 1
    `;
    return (rows[0]?.id as string | undefined) ?? null;
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
    const tzRows = await sql<Array<{ timezone: string | null }>>`
      SELECT s.timezone
      FROM charging_stations cs
      LEFT JOIN sites s ON s.id = cs.site_id
      WHERE cs.id = ${stationUuid}
      LIMIT 1
    `;
    const timezone = tzRows[0]?.timezone ?? undefined;
    const resolved = resolveActiveTariff(tariffs, new Date(), holidays, 0, timezone);
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
    const remoteAddress = (event.payload as { remoteAddress?: string }).remoteAddress ?? null;

    await sql`
      UPDATE charging_stations
      SET is_online = true, last_heartbeat = now(), updated_at = now(),
          ocpp_protocol = COALESCE(${ocppProtocol}, ocpp_protocol)
      WHERE id = ${stationUuid}
    `;

    const connLog = await sql`
      INSERT INTO connection_logs (station_id, event, protocol, remote_address)
      SELECT ${stationUuid}, 'connected', ${ocppProtocol}, ${remoteAddress}
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
      // Publish all queued commands first, then batch-update their status in
      // one query. The previous loop issued (publish + update) per command
      // sequentially: at 50 commands queued for a station, that was 100
      // serial awaits on reconnect; the batched update collapses N writes
      // into one.
      const sentIds: number[] = [];
      for (const cmd of pendingCommands) {
        const queuedPayload = JSON.stringify({
          commandId: cmd.command_id as string,
          stationId: stationOcppId,
          action: cmd.action as string,
          payload: cmd.payload as Record<string, unknown>,
          version: (cmd.version as string | undefined) ?? undefined,
        });
        await pubsub.publish('ocpp_commands', queuedPayload);
        sentIds.push(cmd.id as number);
      }
      if (sentIds.length > 0) {
        await sql`
          UPDATE offline_command_queue
          SET status = 'sent', sent_at = now()
          WHERE id IN ${sql(sentIds)}
        `;
      }
    } catch {
      // Non-critical: queue drain failure should not block connection handling
    }

    if (ocppProtocol != null && ocppProtocol.startsWith('ocpp2')) {
      try {
        await pubsub.publish(
          'station_message_refresh',
          JSON.stringify({
            stationOcppId,
            internalStationId: stationUuid,
            ocppProtocol,
          }),
        );
      } catch {
        // Best-effort station-message refresh
      }
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

    const remoteAddress = (event.payload as { remoteAddress?: string }).remoteAddress ?? null;
    const connLog = await sql`
      INSERT INTO connection_logs (station_id, event, remote_address)
      SELECT ${stationUuid}, 'disconnected', ${remoteAddress}
      WHERE EXISTS (SELECT 1 FROM charging_stations WHERE id = ${stationUuid})
    `;
    if (connLog.count === 0) {
      invalidateStationCache(event.aggregateId);
      return;
    }

    // Batch the port_status_log inserts for all connectors transitioning to
    // unavailable. A multi-connector station previously triggered N serial
    // inserts per disconnect; one INSERT ... SELECT covers them all. The
    // WHERE filter also skips connectors that were already unavailable so
    // we do not emit no-op transitions (mirrors the dedup logic in the
    // StatusNotification path).
    await sql`
      INSERT INTO port_status_log (station_id, evse_id, connector_id, previous_status, new_status, timestamp)
      SELECT ${stationUuid}, e.evse_id, c.connector_id, c.status, 'unavailable', now()
      FROM connectors c
      INNER JOIN evses e ON c.evse_id = e.id
      WHERE e.station_id = ${stationUuid}
        AND c.status != 'unavailable'
    `;

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
    const vendorName = getString(payload, 'vendorName');

    // Check if station is pending onboarding
    const [current] = await sql`
      SELECT onboarding_status FROM charging_stations WHERE id = ${stationUuid}
    `;

    // Persist the booted vendor string in metadata.bootVendor for diagnostic
    // visibility. The authoritative vendor is `vendor_id` (operator-managed
    // FK to the vendors table); a free-text column would create a divergent
    // second source of truth. Stashing in metadata preserves the
    // self-reported value for "did this station ship under a different
    // vendor than expected" investigations without schema churn.
    if (current?.onboarding_status === 'accepted') {
      await sql`
        UPDATE charging_stations
        SET
          firmware_version = ${firmwareVersion},
          model = ${model},
          serial_number = ${serialNumber},
          iccid = COALESCE(${iccid}, iccid),
          imsi = COALESCE(${imsi}, imsi),
          metadata = CASE
            WHEN ${vendorName}::text IS NULL THEN metadata
            ELSE COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('bootVendor', ${vendorName}::text)
          END,
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
          metadata = CASE
            WHEN ${vendorName}::text IS NULL THEN metadata
            ELSE COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('bootVendor', ${vendorName}::text)
          END,
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

      // Re-apply free-vend OCPP variables on every boot when the site has
      // free-vend enabled. Free-vend depends on station-side config
      // (AuthCtrlr.Enabled=false, TxCtrlr.TxStartPoint=EVConnected for 2.1;
      // analogous keys for 1.6) that some firmware does not persist across
      // reboots. Without this re-push, a station that reboots after free-vend
      // was enabled forces drivers to tap-to-start until the operator
      // manually re-pushes the config template.
      const freeVendRows = await sql`
        SELECT s.free_vend_enabled FROM sites s
        JOIN charging_stations cs ON cs.site_id = s.id
        WHERE cs.id = ${stationUuid}
      `;
      const siteFreeVendEnabled = freeVendRows[0]?.free_vend_enabled === true;
      if (siteFreeVendEnabled) {
        if (protocol === 'ocpp2.1') {
          await publishCmd(
            'SetVariables',
            {
              setVariableData: [
                {
                  component: { name: 'AuthCtrlr' },
                  variable: { name: 'Enabled' },
                  attributeValue: 'false',
                },
                {
                  component: { name: 'TxCtrlr' },
                  variable: { name: 'TxStartPoint' },
                  attributeValue: 'EVConnected',
                },
              ],
            },
            'ocpp2.1',
          );
        } else if (protocol === 'ocpp1.6') {
          // OCPP 1.6 has no standard "disable auth" key. The closest
          // standard keys that ease offline/autostart behavior:
          await publishCmd(
            'ChangeConfiguration',
            { key: 'AllowOfflineTxForUnknownId', value: 'true' },
            'ocpp1.6',
          );
          await publishCmd(
            'ChangeConfiguration',
            { key: 'LocalPreAuthorize', value: 'true' },
            'ocpp1.6',
          );
          await publishCmd(
            'ChangeConfiguration',
            { key: 'LocalAuthorizeOffline', value: 'true' },
            'ocpp1.6',
          );
        }
        logger.info(
          { stationId: stationOcppId, protocol },
          'Re-pushed free-vend OCPP variables on boot',
        );
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

    try {
      const [stationRow] = await sql`
        SELECT ocpp_protocol FROM charging_stations WHERE id = ${stationUuid}
      `;
      const protocol = stationRow?.ocpp_protocol as string | null;
      if (protocol != null && protocol.startsWith('ocpp2')) {
        await pubsub.publish(
          'station_message_refresh',
          JSON.stringify({
            stationOcppId: event.aggregateId,
            internalStationId: stationUuid,
            ocppProtocol: protocol,
          }),
        );
      }
    } catch {
      // Best-effort station-message refresh
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
    let previousDbStatus: string | undefined;

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
      previousDbStatus = previousStatus;

      // Skip the audit row when the status did not actually change. Stations
      // retransmit StatusNotification on flaky links and some firmware sends
      // periodic redundant ones; logging no-op transitions clutters the
      // operator timeline and inflates transition-count metrics.
      if (previousStatus !== dbStatus) {
        await sql`
          INSERT INTO port_status_log (station_id, evse_id, connector_id, previous_status, new_status, timestamp)
          VALUES (${stationUuid}, ${evseIdNum}, ${connectorIdNum}, ${previousStatus ?? null}, ${dbStatus}, now())
        `;
      }

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

    // Trigger station-message refresh on real connector-status transitions for
    // OCPP 2.1 stations. The shared push helper re-evaluates the current
    // connector status and rewrites slot 9000 (Available/Occupied/Reserved
    // share Idle) plus the persistent Faulted (9004) and Unavailable (9005)
    // slots; transaction-state slots (9001-9003) are handled by the
    // TransactionEvent projection. Gate on (a) status actually changed -- real
    // stations sometimes resend the same status on heartbeat ticks -- and
    // (b) the transition is one that can change what the station displays.
    const STATION_MESSAGE_RELEVANT_STATUSES = new Set([
      'Available',
      'Occupied',
      'Reserved',
      'Faulted',
      'Unavailable',
      'Preparing',
      'EVConnected',
      'Finishing',
    ]);
    if (dbStatus !== previousDbStatus && STATION_MESSAGE_RELEVANT_STATUSES.has(ocppStatus)) {
      try {
        const [stationRow] = await sql`
          SELECT ocpp_protocol FROM charging_stations WHERE id = ${stationUuid}
        `;
        const protocol = stationRow?.ocpp_protocol as string | null | undefined;
        if (protocol != null && protocol.startsWith('ocpp2')) {
          await pubsub.publish(
            'station_message_refresh',
            JSON.stringify({
              stationOcppId: event.aggregateId,
              internalStationId: stationUuid,
              ocppProtocol: protocol,
            }),
          );
        }
      } catch {
        // Best-effort station-message refresh
      }
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

    async function publishStationMessageTransaction(
      sessionId: string,
      kind: 'started' | 'updated' | 'ended',
      chargingState: string | null,
    ): Promise<void> {
      try {
        const [stationRow] = await sql`
          SELECT ocpp_protocol FROM charging_stations WHERE id = ${stationUuid}
        `;
        const protocol = stationRow?.ocpp_protocol as string | null | undefined;
        if (protocol == null || !protocol.startsWith('ocpp2')) return;
        await pubsub.publish(
          'station_message_transaction',
          JSON.stringify({
            sessionId,
            internalStationId: stationUuid,
            stationOcppId: stationId,
            ocppProtocol: protocol,
            eventType: kind,
            chargingState,
          }),
        );
      } catch {
        // Best-effort station-message refresh
      }
    }

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
        // OCPP 1.6 StartTransaction carries meterStart; OCPP 2.1 TransactionEvent Started does
        // not. Insert NULL when absent so the MeterValues handler captures the first energy
        // reading as meter_start. Inserting 0 here would defeat that guard and cause
        // energy_delivered_wh to be computed against the station's lifetime register.
        const meterStartVal = payload.meterStart != null ? Number(payload.meterStart) : null;
        // Resolve the roaming-token state BEFORE the INSERT so is_roaming is
        // set atomically with row creation. Any consumer that reads the
        // session row between INSERT and a downstream UPDATE will see the
        // correct value. Driver/free-vend resolution still happens after
        // the insert because it has more side effects (token linkage,
        // payment gate).
        const earlyIdToken = payload.idToken as string | null;
        let initialIsRoaming = false;
        if (earlyIdToken != null) {
          try {
            const roamCheck = await sql`
              SELECT 1 FROM ocpi_external_tokens
              WHERE uid = ${earlyIdToken} AND is_valid = true
              LIMIT 1
            `;
            initialIsRoaming = roamCheck.length > 0;
          } catch {
            // ocpi tables may not exist in test/dev environments; safe default
            initialIsRoaming = false;
          }
        }
        // Atomic insert + capture: ON CONFLICT DO UPDATE with a no-op (touches
        // updated_at) lets RETURNING fire on both the insert and the conflict
        // path, eliminating the race window where a separate SELECT could
        // miss the row if a concurrent process (stale-session cleanup,
        // operator delete) removed it between INSERT and SELECT.
        const inserted = await sql`
          INSERT INTO charging_sessions (id, station_id, evse_id, transaction_id, status, started_at, meter_start, is_roaming)
          VALUES (${newSessionId}, ${stationUuid}, ${txEvseUuid}, ${transactionId}, 'active', ${timestamp}, ${meterStartVal}, ${initialIsRoaming})
          ON CONFLICT (transaction_id) DO UPDATE SET updated_at = now()
          RETURNING id
        `;
        sessionId = getSessionId(inserted);
      }
      if (sessionId != null) {
        // Close stale active sessions on the same EVSE (if any).
        // A new transaction starting means any previous session on this EVSE ended
        // without a proper Ended event (e.g., station rebooted, connection lost).
        const stale = await sql`
          UPDATE charging_sessions
          SET status = 'faulted', stopped_reason = 'StaleSession', ended_at = ${timestamp}, updated_at = now()
          WHERE station_id = ${stationUuid} AND status = 'active'
            AND id != ${sessionId}
            AND evse_id = (SELECT evse_id FROM charging_sessions WHERE id = ${sessionId})
          RETURNING id
        `;
        for (const r of stale) {
          await auditLinkedReservationFault(r['id'] as string, 'faulted: StaleSession');
        }

        // Set connector to 'ev_connected' on transaction start (cable connected).
        // Only applies to OCPP 2.1 where the Started event carries
        // `chargingState: 'EVConnected'`. For OCPP 1.6 the StatusNotification
        // projection already wrote the correct fine-grained status (e.g.
        // 'charging') and this block must not overwrite it.
        // Skip when EVConnectTimeout: the EV was never actually connected.
        if (
          triggerReason !== 'EVConnectTimeout' &&
          (payload.chargingState as string | undefined) === 'EVConnected'
        ) {
          const startEvseRows = await sql`
            SELECT evse_id FROM charging_sessions WHERE id = ${sessionId}
          `;
          const startEvseUuid = startEvseRows[0]?.evse_id as string | null;
          if (startEvseUuid != null) {
            // Preserve operator-set terminal/disabled states. A faulted or
            // unavailable connector should not be reset to ev_connected just
            // because a session started on it; the operator wants the bad
            // state visible until they explicitly clear it.
            await sql`
              UPDATE connectors
              SET status = CASE
                    WHEN status IN ('faulted', 'unavailable') THEN status
                    ELSE 'ev_connected'
                  END,
                  updated_at = now()
              WHERE evse_id = ${startEvseUuid}
            `;
            // Notify portal SSE: chargingState enrichment changes
            // connectors.status without sending a StatusNotification, so the
            // 'session.started' event below is not enough -- the portal SSE
            // forwarder only relays 'station.status'.
            const startStationStatusSiteId = await resolveSiteId(stationUuid);
            await notifyChange('station.status', stationUuid, startStationStatusSiteId);
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
          await auditLinkedReservationFault(sessionId, 'failed: EVConnectTimeout');
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
        // Seed from the DB so a remote-start session (created by the API with
        // is_roaming already set) and a station-initiated session (where the
        // INSERT path resolved the OCPI token eagerly) both produce the
        // correct gate input. Without this, the in-memory flag could diverge
        // from the row a downstream consumer reads.
        const initialRoamRows = await sql`
          SELECT is_roaming FROM charging_sessions WHERE id = ${sessionId}
        `;
        const isRoamingSession = initialRoamRows[0]?.is_roaming === true;
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

          const idTokenValue = payload.idToken as string | null;

          // Always look up the token row when an idToken is present, so the
          // session gets linked to the matching driver_tokens entry even when
          // driver_id was pre-set by the API (e.g. portal-authenticated start).
          // The link is what powers the "Token" row on the session detail.
          let tokenLookup: { id: string; driverId: string | null } | null = null;
          if (idTokenValue != null) {
            const tokenRows = await sql`
              SELECT id, driver_id FROM driver_tokens
              WHERE id_token = ${idTokenValue} AND is_active = true
              LIMIT 1
            `;
            const r = tokenRows[0];
            if (r != null) {
              tokenLookup = {
                id: r.id as string,
                driverId: (r.driver_id as string | null) ?? null,
              };
              await sql`
                UPDATE charging_sessions
                SET token_id = ${tokenLookup.id}, updated_at = now()
                WHERE id = ${sessionId}
              `;
            }
          }

          if (driverUuid == null) {
            // Token resolution chain: driver_tokens -> ocpi_external_tokens -> guest_sessions.
            // The OCPI branch is already resolved eagerly during the session
            // INSERT path and reflected on isRoamingSession; no need to
            // re-query ocpi_external_tokens here.
            if (tokenLookup?.driverId != null) {
              driverUuid = tokenLookup.driverId;
              await sql`
                UPDATE charging_sessions SET driver_id = ${driverUuid}, updated_at = now()
                WHERE id = ${sessionId}
              `;
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

          // Auto-link the driver's most recent vehicle to this session so the
          // portal session detail page shows estimated miles without prompting.
          // The driver can override later via PATCH /v1/portal/sessions/:id/vehicle.
          if (driverUuid != null) {
            const vehicleRows = await sql`
              SELECT vehicle_id FROM charging_sessions
              WHERE driver_id = ${driverUuid}
                AND vehicle_id IS NOT NULL
                AND id != ${sessionId}
              ORDER BY started_at DESC NULLS LAST, created_at DESC
              LIMIT 1
            `;
            const lastVehicleId = vehicleRows[0]?.vehicle_id as string | undefined;
            if (lastVehicleId != null) {
              await sql`
                UPDATE charging_sessions
                SET vehicle_id = ${lastVehicleId}, updated_at = now()
                WHERE id = ${sessionId}
              `;
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
              SELECT id, token_id FROM reservations
              WHERE reservation_id = ${ocppReservationId}
                AND station_id = ${stationUuid}
                AND status = 'active'
              LIMIT 1
            `;
            const reservationUuid = reservationRows[0]?.id as string | undefined;
            const reservationTokenId = reservationRows[0]?.token_id as string | null | undefined;
            if (reservationUuid != null) {
              await sql`
                UPDATE charging_sessions SET reservation_id = ${reservationUuid}, updated_at = now()
                WHERE id = ${sessionId}
              `;
              // Conditional UPDATE -- only one writer flips active→in_use. Audit
              // the transition iff we won the race (RETURNING is empty when
              // the row was already in_use/cancelled/expired).
              const usedRows = await sql`
                UPDATE reservations SET status = 'in_use', updated_at = now()
                WHERE id = ${reservationUuid} AND status = 'active'
                RETURNING id, driver_id
              `;
              if (usedRows.length > 0) {
                await writeReservationAudit({
                  reservationId: reservationUuid,
                  action: 'used',
                  actor: 'system',
                  driverIdBefore: (usedRows[0]?.driver_id as string | null) ?? null,
                  driverIdAfter: (usedRows[0]?.driver_id as string | null) ?? null,
                  statusBefore: 'active',
                  statusAfter: 'in_use',
                  notes: `session ${sessionId}`,
                });
              }

              // If the reservation was bound to a specific token, verify the
              // session was started with that token. We log + persist a metadata
              // marker rather than blocking the session: the OCPP transaction
              // is already underway and tearing it down here would just leave
              // the EV charging without a billable session record.
              if (reservationTokenId != null) {
                const sessionRow = await sql`
                  SELECT token_id FROM charging_sessions WHERE id = ${sessionId} LIMIT 1
                `;
                const actualTokenId =
                  (sessionRow[0]?.token_id as string | null | undefined) ?? null;
                if (actualTokenId !== reservationTokenId) {
                  logger.warn(
                    {
                      sessionId,
                      reservationUuid,
                      expectedTokenId: reservationTokenId,
                      actualTokenId,
                    },
                    'Reservation fulfilled by different token than reserved',
                  );
                  await sql`
                    UPDATE charging_sessions
                    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                      'reservationTokenMismatch', jsonb_build_object(
                        'expected', ${reservationTokenId},
                        'actual', ${actualTokenId}
                      )
                    ),
                    updated_at = now()
                    WHERE id = ${sessionId}
                  `;
                }
              }
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

      // Refresh station display with the in-progress transaction message.
      // Defer to the api-side listener so the renderer + push logic stays
      // in one place and we don't pull the renderer into the OCPP package.
      const startedSessionId = getSessionId(
        await sql`SELECT id FROM charging_sessions WHERE transaction_id = ${transactionId}`,
      );
      if (startedSessionId != null) {
        const startedChargingState = (payload.chargingState as string | undefined) ?? null;
        await publishStationMessageTransaction(startedSessionId, 'started', startedChargingState);
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
                UPDATE connectors
                SET status = CASE
                      WHEN status IN ('faulted', 'unavailable') THEN status
                      ELSE ${connectorStatus}
                    END,
                    updated_at = now()
                WHERE evse_id = ${evseUuid}
              `;
              // Notify portal SSE: chargingState enrichment changes
              // connectors.status without a StatusNotification, so the
              // 'session.updated' event below is not enough -- the portal
              // SSE forwarder only relays 'station.status'.
              const updatedStationStatusSiteId = await resolveSiteId(stationUuid);
              await notifyChange('station.status', stationUuid, updatedStationStatusSiteId);
            }
          }
        }

        const siteId = await resolveSiteId(stationUuid);
        await notifyChange('session.updated', stationUuid, siteId, sessionId);
        await notifyOcpiPush('session', { sessionId });

        // Driver notification: transaction updated (throttled to once per 15 min via DB).
        // Gate on status = 'active' so a stray TransactionEvent.Updated that
        // arrives after the payment gate stopped the session (faulted/failed)
        // does not fire a phantom "session update" notification.
        const throttleResult = await sql`
          UPDATE charging_sessions
          SET last_update_notified_at = now()
          WHERE id = ${sessionId}
            AND driver_id IS NOT NULL
            AND status = 'active'
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

        const updatedChargingState = getString(payload, 'chargingState');
        await publishStationMessageTransaction(sessionId, 'updated', updatedChargingState);
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
      // Preserve a terminal status (faulted/failed) that the payment-gate
      // eager-cleanup already set. The pre-fix UPDATE unconditionally flipped
      // the session back to 'completed' for the MissingPaymentMethod path
      // (no payment_records row -> hasPaymentFailure false), which then let
      // the cost-calc block below apply pricePerSession against an
      // already-stopped session.
      await sql`
        UPDATE charging_sessions
        SET status = CASE
              WHEN status IN ('faulted', 'failed') THEN status
              ELSE ${endStatus}
            END,
            ended_at = ${timestamp},
            stopped_reason = COALESCE(stopped_reason, ${stoppedReason}),
            meter_stop = COALESCE(${meterStopVal}, meter_stop),
            updated_at = now()
        WHERE transaction_id = ${transactionId}
      `;

      const sessionRows = await sql`
        SELECT id, status, tariff_id, current_cost_cents, started_at, ended_at, energy_delivered_wh,
               currency, tariff_price_per_kwh, tariff_price_per_minute, tariff_price_per_session,
               tariff_idle_fee_price_per_minute, tariff_tax_rate,
               idle_started_at, idle_minutes, reservation_id
        FROM charging_sessions WHERE transaction_id = ${transactionId}
      `;
      const sessionRow = sessionRows[0];
      if (sessionRow != null) {
        const sessionId = sessionRow.id as string;

        // OCPP 2.1: chargingState is on transactionInfo of the Ended event (e.g. EVConnected
        // when the cable is still plugged after a remote stop). Mirror the Updated-handler
        // behaviour so the connector badge transitions out of 'charging' even when the
        // station does not send a follow-up StatusNotification.
        const endedChargingState = getString(payload, 'chargingState');
        if (endedChargingState != null) {
          const endedConnectorStatus = CHARGING_STATE_TO_STATUS[endedChargingState];
          if (endedConnectorStatus != null) {
            const sessionEvse = await sql`
              SELECT evse_id FROM charging_sessions WHERE id = ${sessionId}
            `;
            const endedEvseUuid = sessionEvse[0]?.evse_id as string | null;
            if (endedEvseUuid != null) {
              await sql`
                UPDATE connectors
                SET status = CASE
                      WHEN status IN ('faulted', 'unavailable') THEN status
                      ELSE ${endedConnectorStatus}
                    END,
                    updated_at = now()
                WHERE evse_id = ${endedEvseUuid}
              `;
              const endedSiteId = await resolveSiteId(stationUuid);
              await notifyChange('station.status', stationUuid, endedSiteId);
            }
          }
        }

        // After session query, check for timeout with zero energy
        const energyWh = Number(sessionRow.energy_delivered_wh ?? 0);
        const isTimeoutEnd =
          (triggerReason === 'EVConnectTimeout' || stoppedReason === 'Timeout') && energyWh === 0;

        // Read the FRESH status from the row we just queried (post-CASE),
        // not the locally-computed `endStatus` which can be stale. If the
        // session is already faulted/failed (preserved by the CASE guard
        // above), do not overwrite it with a different terminal state.
        const currentSessionStatus = sessionRow.status as string | undefined;
        if (
          isTimeoutEnd &&
          currentSessionStatus !== 'faulted' &&
          currentSessionStatus !== 'failed'
        ) {
          await sql`
            UPDATE charging_sessions SET status = 'failed', updated_at = now()
            WHERE id = ${sessionId}
          `;
        }

        // If this session was linked to a reservation and it ended in a
        // non-success state, write a follow-up audit row so the reservation
        // timeline shows the real outcome instead of leaving the prior `used`
        // transition as the last word. Reservation status stays `in_use` --
        // the driver did attempt to consume the reservation -- but the audit
        // log records why the attempt didn't produce a real charging session.
        if (endStatus === 'faulted' || isTimeoutEnd) {
          const failureReason = hasPaymentFailure
            ? `faulted (payment failure)${stoppedReason != null ? `: ${stoppedReason}` : ''}`
            : `failed (timeout)${stoppedReason != null ? `: ${stoppedReason}` : ''}`;
          await auditLinkedReservationFault(sessionId, failureReason);
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

        // Compute final cost from snapshotted tariff rates. Skip when the
        // session was already faulted/failed by the payment gate (or any
        // other pre-stop path): the driver never authorized payment, so
        // charging them pricePerSession + tax produces a phantom row in
        // Recent Sessions and a misleading $X.XX in the portal even though
        // no Stripe capture ever runs.
        const sessionStatus = sessionRow.status as string;
        const skipCostCalc = sessionStatus === 'faulted' || sessionStatus === 'failed';
        const hasTariffSnapshot = sessionRow.tariff_id != null && sessionRow.currency != null;
        if (hasTariffSnapshot && !skipCostCalc) {
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

          // Close the open tariff segment. idle_minutes is the WHOLE-session
          // accumulator (plus any open idle period at session end). For
          // multi-segment sessions, earlier segments were already closed by
          // the boundary cron with per-segment deltas; assigning the full
          // accumulated idle to the last segment here would double-count
          // the portions already attributed earlier. Subtract what's already
          // on closed segments so this last segment carries only the idle
          // that occurred inside its own window. The final-cost path at line
          // ~2479 overrides per-segment idle when computing total cost, so
          // this fix protects per-segment audit data and any downstream
          // line-item code that reads segments verbatim.
          const closedIdleAggRows = await sql<Array<{ total: string }>>`
            SELECT COALESCE(SUM(idle_minutes), 0)::text AS total
            FROM session_tariff_segments
            WHERE session_id = ${sessionId} AND ended_at IS NOT NULL
          `;
          const closedIdleSum = Number(closedIdleAggRows[0]?.total ?? 0);
          const segmentIdleMinutes = Math.max(0, idleMinutes - closedIdleSum);
          const endedAtIso = endedAt.toISOString();
          await sql`
            UPDATE session_tariff_segments
            SET ended_at = ${endedAtIso},
                energy_wh_end = ${energyWh},
                duration_minutes = EXTRACT(EPOCH FROM (${endedAtIso}::timestamptz - started_at)) / 60,
                idle_minutes = ${segmentIdleMinutes}
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
            // Skip the calc on edge cases (zero/negative energy on faulted
            // sessions, missing intensity factor) - a negative co2_avoided
            // value would otherwise polute dashboards.
            if (sessionEnergyWh > 0 && Number.isFinite(intensity) && intensity > 0) {
              const co2Avoided = calculateCo2AvoidedKg(sessionEnergyWh, intensity);
              // Idempotency guard: TransactionEvent Ended can fire more than
              // once for a session (station retry, projection retry); the
              // co2 value must not be overwritten if it was already
              // computed against the same intensity factor.
              await sql`
                UPDATE charging_sessions SET co2_avoided_kg = ${co2Avoided}, updated_at = now()
                WHERE id = ${sessionId} AND co2_avoided_kg IS NULL
              `;
            }
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

        // Driver notification: transaction completed (skip when the session
        // didn't actually complete successfully). The earlier hasPaymentFailure
        // check only covered Stripe-decline cases (a payment_records row with
        // status='failed') and missed the MissingPaymentMethod path, which
        // never inserts a payment record - so drivers who tapped without a PM
        // received a phantom "session is complete" + "session receipt" pair
        // alongside the correct payment-required notification.
        const endedDriverRows =
          await sql`SELECT driver_id, energy_delivered_wh, final_cost_cents, currency, started_at, ended_at, status FROM charging_sessions WHERE id = ${sessionId}`;
        const endedSession = endedDriverRows[0];
        const endedSessionStatus = endedSession?.status as string | undefined;
        const isTerminalSuccess =
          endedSessionStatus !== 'faulted' && endedSessionStatus !== 'failed';
        if (
          endedSession != null &&
          endedSession.driver_id != null &&
          !hasPaymentFailure &&
          isTerminalSuccess
        ) {
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

        await publishStationMessageTransaction(sessionRow.id as string, 'ended', null);

        // Free the per-session CostUpdated throttle entry now that the
        // session is over. Without this the Map grows unbounded over the
        // process lifetime.
        lastCostUpdatedAt.delete(sessionRow.id as string);
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
            ${signedMeterValue != null ? sql.json(asJson(signedMeterValue)) : null},
            ${source}
          WHERE EXISTS (SELECT 1 FROM charging_stations WHERE id = ${stationUuid})
          ON CONFLICT (session_id, evse_id, timestamp, measurand, phase, location) DO NOTHING
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
              ${signedMeterValue != null ? sql.json(asJson(signedMeterValue)) : null},
              ${source}
            )
            ON CONFLICT (session_id, evse_id, timestamp, measurand, phase, location) DO NOTHING
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

      // Send CostUpdated to station when cost changes (OCPP 2.1 only).
      // Throttled per session via lastCostUpdatedAt to keep dispatch volume
      // bounded under high MeterValues cadence.
      if (previousCostCents !== totalCents) {
        const now = Date.now();
        const lastSentAt = lastCostUpdatedAt.get(sessionId) ?? 0;
        if (now - lastSentAt >= COST_UPDATED_THROTTLE_MS) {
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
              lastCostUpdatedAt.set(sessionId, now);
            } catch {
              // Non-critical: CostUpdated failure should not block meter value processing
            }
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
    const fwStatusInfo = payload.statusInfo != null ? sql.json(asJson(payload.statusInfo)) : null;

    // Update the firmware_updates row AND capture its campaign_id atomically
    // via RETURNING. Doing the campaign lookup as a separate SELECT after the
    // UPDATE is racy for the OCPP 1.6 path -- the same WHERE clause that
    // selects the in-flight non-terminal row excludes it once it flips to a
    // terminal status like "Installed", so the lookup misses and the campaign
    // update is silently skipped.
    let linkedCampaignId: string | null = null;
    if (fwRequestId != null) {
      // 2.1 path: single upsert keyed by (station, requestId) so two concurrent
      // status notifications cannot race a UPDATE-miss + dual INSERT into a
      // unique-constraint crash. firmware_url is only set on insert (left alone
      // on conflict) so an orphan placeholder does not overwrite the real URL
      // recorded by the command.UpdateFirmware projection.
      const upserted = await sql<Array<{ campaign_id: string | null }>>`
        INSERT INTO firmware_updates (station_id, request_id, firmware_url, status, status_info, initiated_at, last_status_at)
        VALUES (${stationUuid}, ${fwRequestId}, 'unknown', ${status}, ${fwStatusInfo}, now(), now())
        ON CONFLICT (station_id, request_id) WHERE request_id IS NOT NULL DO UPDATE
        SET status = EXCLUDED.status,
            status_info = EXCLUDED.status_info,
            last_status_at = now(),
            updated_at = now()
        RETURNING campaign_id
      `;
      linkedCampaignId = upserted[0]?.campaign_id ?? null;
    } else {
      // 1.6 path: no requestId, update most recent non-terminal row for this station
      const updated = await sql<Array<{ campaign_id: string | null }>>`
        UPDATE firmware_updates
        SET status = ${status}, status_info = ${fwStatusInfo}, last_status_at = now(), updated_at = now()
        WHERE id = (
          SELECT id FROM firmware_updates
          WHERE station_id = ${stationUuid}
            AND (status IS NULL OR status NOT IN ('Installed', 'InstallationFailed', 'InstallVerificationFailed', 'InvalidSignature', 'DownloadFailed'))
          ORDER BY created_at DESC LIMIT 1
        )
        RETURNING campaign_id
      `;
      if (updated.length === 0) {
        await sql`
          INSERT INTO firmware_updates (station_id, firmware_url, status, status_info, initiated_at, last_status_at)
          VALUES (${stationUuid}, 'unknown', ${status}, ${fwStatusInfo}, now(), now())
        `;
      } else {
        linkedCampaignId = updated[0]?.campaign_id ?? null;
      }
    }

    // Update firmware campaign station status if the row we just updated was
    // linked to a campaign. Scoping by campaign_id (resolved via the RETURNING
    // above, not a separate lookup) prevents an unrelated active campaign from
    // being prematurely flipped to "completed" by status reports from this
    // station.
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
      if (linkedCampaignId != null) {
        await sql`
          UPDATE firmware_campaign_stations
          SET status = ${campaignStatus}::firmware_campaign_station_status,
              error_info = CASE WHEN ${campaignStatus} = 'failed' THEN ${status} ELSE error_info END,
              updated_at = now()
          WHERE station_id = ${stationUuid}
            AND campaign_id = ${linkedCampaignId}
            AND status NOT IN ('installed', 'failed')
        `;

        // Auto-complete the campaign only when every targeted station is
        // terminal. Returning the row also tells us whether the status flip
        // actually happened, so we can publish an SSE event.
        const completed = await sql`
          UPDATE firmware_campaigns
          SET status = 'completed', updated_at = now()
          WHERE id = ${linkedCampaignId}
            AND status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM firmware_campaign_stations fcs
              WHERE fcs.campaign_id = ${linkedCampaignId}
                AND fcs.status NOT IN ('installed', 'failed')
            )
          RETURNING id
        `;

        // Notify the UI so the campaign detail header refreshes immediately.
        // Always publish on a station-status change, plus a separate
        // event when the campaign itself flipped to completed.
        await notifyChange('firmwareCampaign.stationUpdated', stationUuid, null, null, {
          campaignId: linkedCampaignId,
        });
        if (completed.count > 0) {
          await notifyChange('firmwareCampaign.completed', stationUuid, null, null, {
            campaignId: linkedCampaignId,
          });
          // Audit the auto-complete transition so operators can see when (and
          // by what signal) the campaign closed. Manual cancel writes audit at
          // the route layer; without this entry the completion is invisible to
          // the audit trail.
          await writeAudit(
            { table: firmwareCampaignAuditLog, idColumn: 'campaign_id' },
            {
              entityId: linkedCampaignId,
              entityIdSnapshot: linkedCampaignId,
              action: 'completed',
              actor: 'ocpp',
              actorLabel: 'FirmwareStatusNotification auto-complete',
              before: { status: 'active' },
              after: { status: 'completed' },
            },
          );
        }
      }
    }
  });

  safeSubscribe('ocpp.SecurityEventNotification', async (event: DomainEvent) => {
    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    const payload = event.payload;
    const secType = (payload.type as string | undefined) ?? '';
    const secTimestamp = (payload.timestamp as string | undefined) ?? new Date().toISOString();
    const techInfo = (payload.techInfo as string | undefined) ?? null;
    const severity = getSecuritySeverity(secType);
    // `security_events` is the single source of truth for OCPP-reported
    // security events. The prior duplicate write to `connection_logs` with a
    // `security:` prefix was never read by the Security tab (its filter
    // excluded that prefix) so it was dead data; the unified UNION in
    // `/security-logs` reads from this table directly.
    await sql`
      INSERT INTO security_events (station_id, type, severity, timestamp, tech_info)
      VALUES (${stationUuid}, ${secType}, ${severity}, ${secTimestamp}, ${techInfo})
    `;

    // Auto-disable station on critical security events
    if (severity === 'critical') {
      const autoDisable = await isAutoDisableOnCriticalEnabled();
      if (autoDisable) {
        // CTE captures the prior availability so the audit row records the
        // actual previous state, not a guess. RETURNING on the UPDATE alone
        // would give the post-update value. Per-aggregate event queue
        // (safeSubscribe) means no other write to this station's
        // availability is in flight, so the SELECT + UPDATE pair is race-free
        // even without an explicit transaction.
        const flipped = await sql<Array<{ prior_availability: string }>>`
          WITH prior AS (
            SELECT availability FROM charging_stations
            WHERE id = ${stationUuid} AND availability != 'unavailable'
          ),
          upd AS (
            UPDATE charging_stations
            SET availability = 'unavailable', updated_at = now()
            WHERE id = ${stationUuid} AND availability != 'unavailable'
            RETURNING id
          )
          SELECT prior.availability AS prior_availability FROM prior
          WHERE EXISTS (SELECT 1 FROM upd)
        `;
        const priorAvailability = flipped[0]?.prior_availability;
        if (priorAvailability != null) {
          // Record the system-initiated availability flip so the History tab
          // has a forensic trail and operators can correlate the disable
          // with the triggering security event. `writeAudit` is fail-open
          // (logs and continues) so a stray audit error never blocks the
          // OCPP response path that already returned.
          await writeAudit(
            { table: stationAuditLog, idColumn: 'station_id' },
            {
              entityId: stationUuid,
              entityIdSnapshot: stationUuid,
              action: 'updated',
              actor: 'system',
              actorLabel: `security-critical:${secType}`,
              before: { availability: priorAvailability },
              after: { availability: 'unavailable' },
              notes: `Auto-disabled by critical SecurityEventNotification: ${secType}`,
            },
            undefined,
            logger,
          );
        }
      }
    }

    const siteId = await resolveSiteId(stationUuid);
    await notifyChange('station.securityEvent', stationUuid, siteId);
  });

  safeSubscribe('ocpp.ReservationStatusUpdate', async (event: DomainEvent) => {
    const payload = event.payload;
    const reservationOcppId = payload.reservationId as number;
    const updateStatus = payload.reservationUpdateStatus as string;

    if (updateStatus === 'Expired') {
      // Expired reservations stay on the dedicated 'expired' status path,
      // which has its own no-show fee handling in the worker. Conditional
      // UPDATE so we only audit on the actual transition.
      const expired = await sql<Array<{ id: string; driver_id: string | null }>>`
        UPDATE reservations
        SET status = 'expired', updated_at = now()
        WHERE reservation_id = ${reservationOcppId}
          AND status IN ('active', 'scheduled', 'in_use')
        RETURNING id, driver_id
      `;
      const expiredRow = expired[0];
      if (expiredRow != null) {
        await writeReservationAudit(
          {
            reservationId: expiredRow.id,
            action: 'expired',
            actor: 'system',
            driverIdBefore: expiredRow.driver_id,
            driverIdAfter: expiredRow.driver_id,
            statusAfter: 'expired',
            notes: 'station-reported expiry',
          },
          undefined,
          logger,
        );
      }
      return;
    }

    if (updateStatus === 'Removed') {
      // Station-initiated removal (operator pressed cancel on the station,
      // physical fault, etc.). Treat as a system cancel: write metadata,
      // never charge a fee. Scope the UPDATE to the reporting station to
      // avoid touching a stale row at a different station with the same
      // OCPP reservation id (no DB-level uniqueness across stations).
      const stationUuid = await resolveStationUuid(event.aggregateId);
      if (stationUuid == null) return;

      const cancelled = await sql<Array<{ id: string; driver_id: string | null }>>`
        UPDATE reservations
        SET status = 'cancelled',
            cancelled_by = 'system',
            cancel_reason = 'system_cleanup'::reservation_cancel_reason,
            cancellation_fee_cents = 0,
            updated_at = now()
        WHERE reservation_id = ${reservationOcppId}
          AND station_id = ${stationUuid}
          AND status IN ('active', 'scheduled')
        RETURNING id, driver_id
      `;

      const cancelledRow = cancelled[0];
      if (cancelledRow != null) {
        await writeReservationAudit(
          {
            reservationId: cancelledRow.id,
            action: 'cancelled',
            actor: 'system',
            driverIdBefore: cancelledRow.driver_id,
            driverIdAfter: cancelledRow.driver_id,
            statusAfter: 'cancelled',
            notes: 'station-reported removal',
          },
          undefined,
          logger,
        );
      }

      const driverId = cancelled[0]?.driver_id ?? null;
      if (driverId != null) {
        try {
          await dispatchDriverNotification(
            sql,
            'reservation.Cancelled',
            driverId,
            {
              reservationId: reservationOcppId,
              stationId: event.aggregateId,
              cancellationFeeFormatted: '',
            },
            ALL_TEMPLATES_DIRS,
            pubsub,
          );
        } catch (err) {
          logger.warn(
            { err, driverId, reservationOcppId },
            'Failed to dispatch station-removed driver notification',
          );
        }
      }
    }
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

    /**
     * Stops the session by publishing RequestStopTransaction. For
     * payment-failure reasons (PaymentFailed, MissingPaymentMethod) we ALSO
     * eagerly mark the DB row faulted so the operator UI clears the connector
     * even if the station ignores the stop or the message is lost. This is
     * the ghost-session prevention path: a card declined at the gate must not
     * leave a stranded `active` session that no event can ever close.
     *
     * Anonymous and guest-not-authorized stops only publish the OCPP command;
     * the natural TransactionEvent.Ended that follows handles the DB
     * transition. Eager cleanup for those would race the legitimate Ended
     * handler.
     */
    async function stopSession(
      reason:
        | 'PaymentFailed'
        | 'MissingPaymentMethod'
        | 'GuestPaymentNotAuthorized'
        | 'AnonymousSession',
    ): Promise<void> {
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
        logger.error({ err }, 'Failed to publish RequestStopTransaction');
      }

      // Push a one-shot driver-facing message to the station screen so the
      // physical UX matches the email/SMS notification fan-out. The template
      // body is operator-editable in Settings -> Integration -> Station
      // Messages, rendered with the standard StationMessageContext, and
      // dispatched via dispatchOneShotStationMessage so any future
      // event-driven station message can reuse the same path.
      const stateByReason: Record<typeof reason, StationMessageState> = {
        PaymentFailed: 'payment_failed',
        MissingPaymentMethod: 'payment_required',
        GuestPaymentNotAuthorized: 'guest_unauthorized',
        AnonymousSession: 'unauthorized',
      };
      try {
        const settingRows = await sql`
          SELECT key, value FROM settings
          WHERE key IN ('company.name', 'company.supportPhone', 'stationMessage.eventMessageTtlSeconds')
        `;
        const settingsMap = new Map<string, unknown>();
        for (const row of settingRows) {
          settingsMap.set(row['key'] as string, row['value']);
        }
        const companyName = (settingsMap.get('company.name') as string | undefined) ?? 'EVtivity';
        const supportPhone = settingsMap.get('company.supportPhone') as string | undefined;
        const ttlSetting = settingsMap.get('stationMessage.eventMessageTtlSeconds');
        const ttlSeconds = typeof ttlSetting === 'number' && ttlSetting > 0 ? ttlSetting : 30;
        await dispatchOneShotStationMessage(
          pubsub,
          sql,
          {
            stationOcppId: ocppStationId,
            stationDbId,
            state: stateByReason[reason],
            context: {
              companyName,
              stationOcppId: ocppStationId,
              ...(supportPhone != null && supportPhone !== '' ? { supportPhone } : {}),
            },
          },
          {
            ttlSeconds,
            // Defensive in-process clear for OCPP 1.6 (no native endDateTime)
            // and 2.1 firmwares that ignore endDateTime. Same window so the
            // operator can tune one knob.
            autoClearMs: ttlSeconds * 1000,
          },
        );
      } catch (err) {
        logger.warn({ err, reason }, 'Failed to publish payment-failure display message');
      }

      const eagerCleanup = reason === 'PaymentFailed' || reason === 'MissingPaymentMethod';
      if (!eagerCleanup) return;

      try {
        // Zero out cost columns: the driver never authorized payment so we
        // must not display or persist a session-fee charge. Without this,
        // the cost calc on the Ended event (or MeterValues if a stray one
        // arrives) applies pricePerSession + tax and the portal Recent
        // Sessions list shows a phantom $0.81 next to a 0 kWh row.
        const eager = await sql`
          UPDATE charging_sessions
          SET status = 'faulted',
              stopped_reason = ${reason},
              ended_at = now(),
              final_cost_cents = 0,
              current_cost_cents = 0,
              updated_at = now()
          WHERE id = ${sessionId} AND status = 'active'
          RETURNING id
        `;
        await sql`
          UPDATE session_tariff_segments
          SET ended_at = now(),
              duration_minutes = EXTRACT(EPOCH FROM (now() - started_at)) / 60
          WHERE session_id = ${sessionId} AND ended_at IS NULL
        `;
        if (eager.length > 0) {
          await auditLinkedReservationFault(sessionId, `faulted: ${reason}`);
        }
      } catch (err) {
        logger.error({ err, sessionId, reason }, 'Failed to mark session faulted');
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
        await stopSession('MissingPaymentMethod');
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

      // Platform settings and site-level overrides are independent reads -
      // fetch them in parallel so the pre-auth gate doesn't pay both round-trips
      // serially on every charging start.
      const [platformSettingsRows, siteConfigRows] = await Promise.all([
        sql`
          SELECT key, value FROM settings WHERE key IN (
            'stripe.currency',
            'stripe.preAuthAmountCents'
          )
        `,
        siteId != null
          ? sql`
              SELECT id, currency, pre_auth_amount_cents, stripe_connected_account_id
              FROM site_payment_configs
              WHERE site_id = ${siteId} AND is_enabled = true
            `
          : Promise.resolve([] as Array<Record<string, unknown>>),
      ]);
      const platformMap = new Map<string, unknown>();
      for (const row of platformSettingsRows) {
        platformMap.set(row.key as string, row.value);
      }
      let platformCurrency = (platformMap.get('stripe.currency') as string | undefined) ?? 'USD';
      let platformPreAuthCents =
        (platformMap.get('stripe.preAuthAmountCents') as number | undefined) ?? 5000;

      let connectedAccountId: string | null = null;
      let siteConfigId: string | null = null;
      const sc = siteConfigRows[0];
      if (sc != null) {
        platformCurrency = sc.currency as string;
        platformPreAuthCents = sc.pre_auth_amount_cents as number;
        connectedAccountId = (sc.stripe_connected_account_id as string | null) ?? null;
        siteConfigId = sc.id as string;
      }

      // Currency consistency: the session was snapshotted with the tariff's
      // currency at session start. The pre-auth (and later capture) will use
      // platformCurrency from the Stripe config. If they differ, every cents
      // value is in the wrong denomination -- a $1.50 charge gets billed as
      // €1.50 (Stripe doesn't auto-convert). Fail the session loudly here so
      // the operator sees the misconfiguration before any money moves.
      const sessionCurrencyRows = await sql`
          SELECT currency FROM charging_sessions WHERE id = ${sessionId} LIMIT 1
        `;
      const sessionCurrency =
        (sessionCurrencyRows[0]?.currency as string | undefined) ?? platformCurrency;
      if (sessionCurrency.toUpperCase() !== platformCurrency.toUpperCase()) {
        // Operator-only diagnostics: log the actual currencies so the
        // misconfiguration is visible in observability. The driver-facing
        // notification stays generic -- no payment-provider names, no internal
        // currency codes, just "payment configuration issue, contact support".
        logger.error(
          { sessionId, sessionCurrency, stripeCurrency: platformCurrency, siteId },
          'Currency mismatch: tariff currency differs from Stripe config currency; faulting session',
        );
        await stopSession('PaymentFailed');
        try {
          void dispatchDriverNotification(
            sql,
            'payment.PreAuthFailed',
            driverId,
            {
              stationId: ocppStationId,
              transactionId,
              reason: 'Payment configuration issue. Please contact support.',
            },
            ALL_TEMPLATES_DIRS,
            pubsub,
          );
        } catch (notifyErr) {
          logger.error({ err: notifyErr }, 'Failed to notify driver of currency mismatch');
        }
        return;
      }

      // Guard: skip if a payment record already exists (prevents duplicate pre-auth on race)
      const existingPayment = await sql`
          SELECT id FROM payment_records WHERE session_id = ${sessionId} LIMIT 1
        `;
      if (existingPayment.length > 0) return;

      // Case 2: Simulated payment method -- bypass Stripe
      if (isSimulatedCustomer(stripeCustomerId)) {
        const intentId = `pi_sim_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        const failed = shouldSimulatePaymentFailure();

        try {
          if (failed) {
            await sql`
                INSERT INTO payment_records (
                  session_id, driver_id,
                  stripe_payment_intent_id, stripe_customer_id, stripe_payment_method_id,
                  payment_source, currency, pre_auth_amount_cents, status,
                  failure_reason
                )
                VALUES (
                  ${sessionId},
                  ${driverId},
                  ${intentId},
                  ${stripeCustomerId},
                  ${pm.stripe_payment_method_id as string},
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
                  stripe_payment_intent_id, stripe_customer_id, stripe_payment_method_id,
                  payment_source, currency, pre_auth_amount_cents, status
                )
                VALUES (
                  ${sessionId},
                  ${driverId},
                  ${intentId},
                  ${stripeCustomerId},
                  ${pm.stripe_payment_method_id as string},
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
          await stopSession('PaymentFailed');
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

        const paymentIntent = await stripe.paymentIntents.create(piParams, {
          idempotencyKey: `preauth_${sessionId}`,
        });

        await sql`
            INSERT INTO payment_records (
              session_id, driver_id, site_payment_config_id,
              stripe_payment_intent_id, stripe_customer_id, stripe_payment_method_id,
              payment_source, currency, pre_auth_amount_cents, status
            )
            VALUES (
              ${sessionId},
              ${driverId},
              ${siteConfigId},
              ${paymentIntent.id},
              ${pm.stripe_customer_id as string},
              ${pm.stripe_payment_method_id as string},
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
                stripe_customer_id, stripe_payment_method_id,
                payment_source, currency, status, failure_reason
              )
              VALUES (
                ${sessionId},
                ${driverId},
                ${pm.stripe_customer_id as string},
                ${pm.stripe_payment_method_id as string},
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

        await stopSession('PaymentFailed');

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
        await stopSession('GuestPaymentNotAuthorized');
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
      await stopSession('AnonymousSession');
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
        if (shouldSimulatePaymentFailure()) {
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
          // Fetch session/station context up front so the top-up path knows
          // which currency to use.
          const captureSession = await sql`
            SELECT cs2.station_id AS station_ocpp_id, cs.currency, cs.station_id AS station_uuid
            FROM charging_sessions cs
            JOIN charging_stations cs2 ON cs2.id = cs.station_id
            WHERE cs.id = ${session.id as string}
          `;
          const cs = captureSession[0];
          const sessionCurrency = (cs?.currency as string | null) ?? 'USD';

          const preAuthAmount = (pr.pre_auth_amount_cents as number | null) ?? finalCostCents;
          const captureAmount = Math.min(finalCostCents, preAuthAmount);

          // Always capture the pre-auth fully (or finalCost if smaller). When
          // finalCost > preauth we then create a second PaymentIntent for the
          // delta and confirm+capture it off-session. Stripe rejects
          // amount_to_capture > original_amount, so we cannot just expand the
          // first intent.
          await stripe.paymentIntents.capture(
            paymentIntentId,
            { amount_to_capture: captureAmount },
            { idempotencyKey: `capture_${pr.id as string}` },
          );

          let totalCaptured = captureAmount;
          let topUpFailureReason: string | null = null;
          let topUpIntentId: string | null = null;

          if (finalCostCents > preAuthAmount) {
            const deltaCents = finalCostCents - preAuthAmount;
            try {
              // Retrieve the original intent to learn the customer + payment
              // method so we can charge the delta against the same card.
              const origIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
              const customerId =
                typeof origIntent.customer === 'string'
                  ? origIntent.customer
                  : origIntent.customer?.id;
              const pmId =
                typeof origIntent.payment_method === 'string'
                  ? origIntent.payment_method
                  : origIntent.payment_method?.id;
              if (customerId == null || pmId == null) {
                throw new Error('Original PaymentIntent missing customer or payment_method');
              }

              const topUpParams: Record<string, unknown> = {
                amount: deltaCents,
                currency: sessionCurrency.toLowerCase(),
                customer: customerId,
                payment_method: pmId,
                confirm: true,
                off_session: true,
                capture_method: 'automatic',
                description: `Top-up for session ${session.id as string}`,
              };
              if (origIntent.on_behalf_of != null) {
                topUpParams['on_behalf_of'] = origIntent.on_behalf_of;
                topUpParams['transfer_data'] = {
                  destination:
                    typeof origIntent.on_behalf_of === 'string'
                      ? origIntent.on_behalf_of
                      : origIntent.on_behalf_of.id,
                };
                // Carry the same platform-fee rate onto the top-up. Without
                // this the entire delta flows to the connected account and
                // the platform earns nothing on the overage portion.
                if (
                  origIntent.application_fee_amount != null &&
                  origIntent.application_fee_amount > 0 &&
                  origIntent.amount > 0
                ) {
                  const feeRate = origIntent.application_fee_amount / origIntent.amount;
                  topUpParams['application_fee_amount'] = Math.round(deltaCents * feeRate);
                }
              }
              const topUp = await stripe.paymentIntents.create(
                topUpParams as unknown as import('stripe').default.PaymentIntentCreateParams,
                { idempotencyKey: `topup_${pr.id as string}` },
              );
              topUpIntentId = topUp.id;
              totalCaptured = preAuthAmount + deltaCents;
            } catch (topUpErr) {
              topUpFailureReason =
                topUpErr instanceof Error
                  ? `Top-up declined: ${topUpErr.message.slice(0, 350)}; shortfall ${String(deltaCents)}c`
                  : `Top-up failed; shortfall ${String(deltaCents)}c`;
              logger.warn(
                { err: topUpErr, paymentRecordId: pr.id, deltaCents },
                'Top-up PaymentIntent failed; pre-auth was captured but delta uncollected',
              );
            }
          }

          await sql`
            UPDATE payment_records
            SET status = 'captured',
                captured_amount_cents = ${totalCaptured},
                failure_reason = ${topUpFailureReason},
                metadata = CASE
                  WHEN ${topUpIntentId}::text IS NULL THEN metadata
                  ELSE jsonb_set(COALESCE(metadata, '{}'::jsonb), '{topUpIntentId}', to_jsonb(${topUpIntentId}::text))
                END,
                updated_at = now()
            WHERE id = ${pr.id as string}
          `;

          // Driver notification: payment captured via Stripe
          const captureDriverRows = await sql`
            SELECT driver_id FROM payment_records WHERE id = ${pr.id as string}
          `;
          const captureDriver = captureDriverRows[0];
          if (captureDriver?.driver_id != null) {
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
                amountCents: totalCaptured,
                currency: sessionCurrency,
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
      SELECT ${stationUuid}, ${direction}, ${messageType}, ${messageId}, ${action}, ${sql.json(asJson(messagePayload ?? {}))}, ${errorCode}, ${errorDescription}
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
      VALUES (${stationUuid}, ${generatedAt}, ${seqNo}, ${tbc}, ${sql.json(asJson(eventData))})
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
      VALUES (${stationUuid}, ${requestId}, ${seqNo}, ${generatedAt}, ${tbc}, ${monitor != null ? sql.json(asJson(monitor)) : null})
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

    // GetChargingProfiles can produce multiple ReportChargingProfiles
    // messages, each carrying one or more profiles. The first message of a
    // new request supersedes the prior report; subsequent messages of the
    // same request must accumulate. Filter the delete by requestId so we
    // only purge rows from PRIOR refresh cycles, not the current one.
    await sql`
      DELETE FROM charging_profiles
      WHERE station_id = ${stationUuid} AND source = 'station_reported'
        AND COALESCE(evse_id, -1) = COALESCE(${evseId}::int, -1)
        AND COALESCE(request_id, -1) <> COALESCE(${requestId}::int, -1)
    `;
    await sql`
      INSERT INTO charging_profiles (station_id, source, evse_id, request_id, charging_limit_source, tbc, profile_data, reported_at)
      VALUES (${stationUuid}, 'station_reported', ${evseId}, ${requestId}, ${chargingLimitSource}, ${tbc}, ${sql.json(asJson(chargingProfile))}, now())
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
        const value =
          typeof attr.value === 'string' ||
          typeof attr.value === 'number' ||
          typeof attr.value === 'boolean'
            ? String(attr.value)
            : null;

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
    const statusInfo = payload.statusInfo != null ? sql.json(asJson(payload.statusInfo)) : null;

    if (requestId != null) {
      const updated = await sql`
        UPDATE log_uploads
        SET status = ${status}, status_info = ${statusInfo}, last_status_at = now(), updated_at = now()
        WHERE station_id = ${stationUuid} AND request_id = ${requestId}
      `;
      if (updated.count === 0) {
        await sql`
          INSERT INTO log_uploads (station_id, request_id, status, status_info, last_status_at)
          VALUES (${stationUuid}, ${requestId}, ${status}, ${statusInfo}, now())
        `;
      }
    } else {
      // No requestId: insert new row
      await sql`
        INSERT INTO log_uploads (station_id, status, status_info, last_status_at)
        VALUES (${stationUuid}, ${status}, ${statusInfo}, now())
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

    // The command listener publishes this event with the station's response
    // included. Only persist (and dedupe) when the station Accepted the profile;
    // otherwise the on-station state is unchanged and we'd be lying about it.
    const response = event.payload.response as { status?: string } | undefined;
    if (response?.status !== 'Accepted') return;

    const request = event.payload.request as Record<string, unknown>;
    const evseId = (request.evseId as number | undefined) ?? null;
    const csProfile = (request.csChargingProfiles ?? request.chargingProfile ?? null) as Record<
      string,
      unknown
    > | null;

    // OCPP profile.id is the per-station unique key. Re-pushing a profile with
    // the same id replaces the on-station profile, so mirror that semantics in
    // the DB by deleting any prior csms_set row with the same id first.
    const profileIdValue = csProfile != null ? (csProfile['id'] as number | undefined) : undefined;
    if (profileIdValue != null) {
      await sql`
        DELETE FROM charging_profiles
        WHERE station_id = ${stationUuid}
          AND source = 'csms_set'
          AND profile_data ->> 'id' ~ '^-?[0-9]+$'
          AND (profile_data->>'id')::int = ${profileIdValue}
      `;
    }

    await sql`
      INSERT INTO charging_profiles (station_id, source, evse_id, profile_data, sent_at)
      VALUES (${stationUuid}, 'csms_set', ${evseId}, ${sql.json(asJson(csProfile))}, now())
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
        typeof result.attributeValue === 'string' ||
        typeof result.attributeValue === 'number' ||
        typeof result.attributeValue === 'boolean'
          ? String(result.attributeValue)
          : null;

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
      const value =
        typeof configKey.value === 'string' ||
        typeof configKey.value === 'number' ||
        typeof configKey.value === 'boolean'
          ? String(configKey.value)
          : null;
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

    // Upsert by (station_id, request_id) so a pre-inserted row from a firmware
    // campaign (which carries campaign_id) is not duplicated. The pre-insert
    // already contains the firmware_url and retrieve_date_time, so the UPDATE
    // branch is a no-op for campaign-driven dispatches.
    //
    // Atomic via the partial unique index uniq_firmware_updates_station_request
    // (migration 0015) so concurrent dispatches and the API pre-insert cannot
    // double-insert. campaign_id is intentionally NOT touched on conflict --
    // the pre-insert is the source of truth for that linkage.
    if (requestId != null) {
      await sql`
        INSERT INTO firmware_updates (station_id, request_id, firmware_url, retrieve_date_time, initiated_at)
        VALUES (${stationUuid}, ${requestId}, ${firmwareUrl}, ${retrieveDateTime}, now())
        ON CONFLICT (station_id, request_id) WHERE request_id IS NOT NULL
        DO UPDATE SET
          firmware_url = EXCLUDED.firmware_url,
          retrieve_date_time = EXCLUDED.retrieve_date_time,
          updated_at = now()
      `;
    } else {
      await sql`
        INSERT INTO firmware_updates (station_id, request_id, firmware_url, retrieve_date_time, initiated_at)
        VALUES (${stationUuid}, ${requestId}, ${firmwareUrl}, ${retrieveDateTime}, now())
      `;
    }
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

  // command.ReserveNow: roll back the reservation when the station did not
  // accept the request. Scheduled reservations are dispatched fire-and-forget
  // by the worker (no response wait), so without this projection a station
  // reply of `Occupied` (EVSE busy at activation time), `Faulted`, `Rejected`,
  // or `Unavailable` would leave the DB row showing `active` even though no
  // reservation exists on the station. The immediate-start path in
  // packages/api/src/routes/reservations.ts already handles its own response
  // synchronously, but it's a no-op for that path because by the time this
  // projection runs the row will already be `cancelled` (the WHERE clause
  // filters to `active`/`scheduled` only).
  safeSubscribe('command.ReserveNow', async (event: DomainEvent) => {
    const request = event.payload.request as Record<string, unknown>;
    const response = event.payload.response as Record<string, unknown> | undefined;
    const status = response != null ? (response['status'] as string | undefined) : undefined;
    if (status == null || status === 'Accepted') return;

    // Worker builds the payload in OCPP 2.1 shape (`id`, `idToken`,
    // `expiryDateTime`, `evseId?`); CommandListener translates to 1.6 on the
    // wire but the event payload preserves the pre-translation form, so `id`
    // is always the OCPP reservation id.
    const reservationOcppId =
      typeof request['id'] === 'number'
        ? request['id']
        : typeof request['reservationId'] === 'number'
          ? request['reservationId']
          : null;
    if (reservationOcppId == null) return;

    const stationUuid = await resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    // System-path cancellation: write the cancelled_by/cancel_reason metadata
    // and force the cancellation fee to 0. The cancel_reason values must
    // match the reservation_cancel_reason enum in the schema. RETURNING
    // gives us the driver_id so we can dispatch the cancellation
    // notification -- otherwise the driver sees the reservation silently
    // disappear from the portal.
    const cancelReason =
      status === 'Occupied' ? 'station_rejected_occupied' : 'station_rejected_other';
    const cancelled = await sql<Array<{ driver_id: string | null }>>`
      UPDATE reservations
      SET status = 'cancelled',
          cancelled_by = 'system',
          cancel_reason = ${cancelReason}::reservation_cancel_reason,
          cancellation_fee_cents = 0,
          updated_at = now()
      WHERE reservation_id = ${reservationOcppId}
        AND station_id = ${stationUuid}
        AND status IN ('active', 'scheduled')
      RETURNING driver_id
    `;
    logger.warn(
      { stationId: event.aggregateId, reservationOcppId, status, cancelReason },
      `Station rejected ReserveNow with status: ${status}; reservation cancelled`,
    );
    const driverId = cancelled[0]?.driver_id ?? null;
    if (driverId != null) {
      try {
        await dispatchDriverNotification(
          sql,
          'reservation.Cancelled',
          driverId,
          {
            reservationId: reservationOcppId,
            stationId: event.aggregateId,
            cancellationFeeFormatted: '',
          },
          ALL_TEMPLATES_DIRS,
          pubsub,
        );
      } catch (err) {
        logger.warn(
          { err, driverId, reservationOcppId },
          'Failed to dispatch system-cancel driver notification',
        );
      }
    }
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
      VALUES (${stationUuid}, ${evseId}, ${sql.json(asJson(chargingNeeds))}, ${departureTime}, ${requestedEnergyTransfer}, ${controlMode}, ${maxScheduleTuples})
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
      VALUES (${stationUuid}, ${evseId}, ${timeBase}, ${sql.json(asJson(chargingSchedule))})
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
        ${sql.json(asJson(cmdPayload))}, ${version},
        now() + ${String(ttlHours) + ' hours'}::interval
      )
      ON CONFLICT (command_id) DO NOTHING
    `;
  });

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
      VALUES (${stationUuid}, ${eventType}, ${transactionId}, ${idToken != null ? sql.json(asJson(idToken)) : null})
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
      VALUES (${stationUuid}, ${streamId}, ${sql.json(asJson(data))})
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
      VALUES (${stationUuid}, ${transactionId}, ${allowedEnergyTransfer != null ? sql.json(asJson(allowedEnergyTransfer)) : null})
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
      VALUES (${stationUuid}, ${controlType}, ${ts}, ${gridEventFault != null ? sql.json(asJson(gridEventFault)) : null})
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
      VALUES (${stationUuid}, ${requestId}, ${seqNo}, ${tbc}, ${derControl != null ? sql.json(asJson(derControl)) : null})
    `;
  });
}
