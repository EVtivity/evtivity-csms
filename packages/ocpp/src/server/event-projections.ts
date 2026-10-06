// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import postgres from 'postgres';
import type { EventBus, DomainEvent, PubSubClient, ConnectionRegistry } from '@evtivity/lib';

// postgres-js `sql.json` takes a strict JSONValue (objects whose values are JSONValue,
// not `unknown`). We hand it OCPP payloads typed loosely as Record<string, unknown>;
// the values are always JSON-serializable at runtime, so we widen via this helper.
type JSONValue = Parameters<postgres.Sql['json']>[0];
const asJson = (v: unknown): JSONValue => v as JSONValue;
import {
  client,
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
  isSiteFreeVendEnabledByStation,
  getElectricityRatePeriodsForSite,
  getCompanyCurrency,
  getCompanyPriceDisplay,
  applyConnectorStatus,
  applyEvseChargingState,
  clearStationFirmwareInstalling,
  setStationDisabled,
  setStationFirmwareState,
  setStationReportedStatus,
  startStatusOrderingEpoch,
  getCompanyTaxBasis,
  snapshotSessionTariff,
  resolveStationTariff,
  priceSessionAt,
  storeRunningCost,
  storeFinalCost,
  closeOpenSegment,
  openSegmentTariffId,
  switchTariffSegment,
  sessionIdleMinutesAt,
  faultUnbilledSession,
  pgConstraintName,
  pgErrorCode,
  PG_FOREIGN_KEY_VIOLATION,
} from '@evtivity/database';
import type { TariffPriceSnapshot } from '@evtivity/database';
import {
  authorizeSessionHold,
  classifySessionPayment,
  recordTerminalSettlement,
  settleSessionPayment,
} from '@evtivity/payments';
import { getSecuritySeverity } from '../lib/security-severity.js';
import { paymentContext } from '../lib/payments.js';
import { upsertStationConfiguration } from './station-configurations.js';
import { requestCsmsSessionEnd, SESSION_ENDED_BY_CSMS } from './csms-session-end.js';
import {
  generateId,
  createLogger,
  calculateCo2AvoidedKg,
  isTariffFree,
  dispatchOneShotStationMessage,
  FREE_VEND_OCPP_21_VARIABLES,
  FREE_VEND_OCPP_16_KEYS,
  resolveElectricityRate,
  calculateElectricityCostCents,
  notificationMoney,
  notificationUnitPrice,
  notificationTaxRate,
  costIncludesTax,
  priceForDisplay,
  resolvePriceDisplay,
  reconcileCostBreakdown,
  resolveTaxBasis,
} from '@evtivity/lib';
import type { StationMessageState } from '@evtivity/lib';
import { publishOcppCommand } from '@evtivity/lib';
import {
  dispatchOcppNotification,
  dispatchDriverNotification,
  dispatchSystemNotification,
  ALL_TEMPLATES_DIRS,
} from './notification-dispatcher.js';
import { TransactionBuffer } from './transaction-buffer.js';
import { projectionLane, projectionQueueFor, sessionPricedKey } from './projection-queue.js';
import { PROJECTION_RETRY_DEFAULTS, runProjectionWithRetry } from './projection-retry.js';
import type { ProjectionAttempt } from './projection-retry.js';
import { isUnbilledTimeoutEnd } from './session-cost.js';
import { SERVER_SHUTDOWN_DISCONNECT_REASON } from './graceful-shutdown.js';
import {
  DEFAULT_LOCATION,
  DEFAULT_MEASURAND,
  applyMultiplier,
  energyToWh,
  overallValue,
} from './meter-units.js';
import type { PhaseSample } from './meter-units.js';

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

// OCPP 2.1 ConnectorType variable values (Connector component) to the
// canonical UI labels used in connectors.connector_type. Values not in this
// map are passed through unchanged so vendor-specific plug names remain
// visible to operators on the connectors tab and stations list.
const OCPP_CONNECTOR_TYPE_MAP: Record<string, string> = {
  cCCS1: 'CCS1',
  cCCS2: 'CCS2',
  cType1: 'Type1',
  cType2: 'Type2',
  cChaoJi: 'CHAdeMO',
  'cG105-2019': 'CHAdeMO',
  cTesla: 'NACS',
  'cGBT-AC': 'GBT',
  'cGBT-DC': 'GBT',
};

function mapOcppConnectorType(value: string): string {
  return OCPP_CONNECTOR_TYPE_MAP[value] ?? value;
}

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
  pubsub: PubSubClient,
  options?: ProjectionOptions,
): void {
  const registry = options?.registry ?? null;
  const instanceId = options?.instanceId ?? null;
  const sql = client;
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

  // Per-station debounce for maintenance re-assert publishes. 30s: long enough
  // to collapse a flapping connection or a fleet-wide reconnect wave into one
  // fan-out job per station, short enough that a genuine reboot-and-rejoin
  // still gets re-asserted promptly.
  const REASSERT_DEBOUNCE_MS = 30_000;
  const reassertDebounceStore = new Map<string, number>();
  const reassertDebounce = {
    get(key: string): true | undefined {
      const expiresAt = reassertDebounceStore.get(key);
      if (expiresAt == null) return undefined;
      if (Date.now() > expiresAt) {
        reassertDebounceStore.delete(key);
        return undefined;
      }
      return true;
    },
    set(key: string): void {
      if (reassertDebounceStore.size >= CACHE_MAX_SIZE && !reassertDebounceStore.has(key)) {
        const firstKey = reassertDebounceStore.keys().next().value;
        if (firstKey != null) reassertDebounceStore.delete(firstKey);
      }
      reassertDebounceStore.set(key, Date.now() + REASSERT_DEBOUNCE_MS);
    },
  };

  // Per-station debounce for the boot-time OCPP config push. A reconnect
  // storm (server restart, crash loop) re-boots the whole fleet within
  // seconds; re-pushing 5-7 config commands per station each time multiplies
  // the storm. A station that legitimately reboots twice inside the window
  // skips the second push; the free-vend enforcement is multi-layered
  // (authorize handler + payment gate), so the worst case is tap-to-start
  // until the next push, not a billing hole.
  const BOOT_CONFIG_DEBOUNCE_MS = 10 * 60_000;
  const bootConfigDebounceStore = new Map<string, number>();
  function bootConfigRecentlyPushed(stationOcppId: string): boolean {
    const expiresAt = bootConfigDebounceStore.get(stationOcppId);
    if (expiresAt != null && Date.now() <= expiresAt) return true;
    if (expiresAt != null) bootConfigDebounceStore.delete(stationOcppId);
    return false;
  }
  function markBootConfigPushed(stationOcppId: string): void {
    if (
      bootConfigDebounceStore.size >= CACHE_MAX_SIZE &&
      !bootConfigDebounceStore.has(stationOcppId)
    ) {
      const firstKey = bootConfigDebounceStore.keys().next().value;
      if (firstKey != null) bootConfigDebounceStore.delete(firstKey);
    }
    bootConfigDebounceStore.set(stationOcppId, Date.now() + BOOT_CONFIG_DEBOUNCE_MS);
  }

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
  // Each lane (a station, or a transaction as station plus transactionId, since
  // a transactionId is unique per station only) gets a sequential promise chain
  // (projection-queue.ts, shared with handlers that wait for projected state).
  const projectionQueue = projectionQueueFor(eventBus);
  // How long a transaction projection waits for the station lane to create an
  // EVSE the station just reported (see the Started insert).
  const EVSE_LANE_WAIT_MS = 5000;

  function enqueueForStation(id: string, work: () => Promise<void>): Promise<void> {
    return projectionQueue.enqueue(id, work);
  }

  // `retryOnConnectionError`: the projection runs again (projection-retry.ts)
  // when it failed because the database connection was lost, as in a reconnect
  // storm after an OCPP restart. Only for handlers that are safe to run again
  // from the start: idempotent statements, and `attempt.once` / `attempt.memo`
  // for the steps that are not. The retry runs inside the queued work, so later
  // events of the lane wait for it and keep their order.
  function safeSubscribe(
    eventType: string,
    handler: (event: DomainEvent, attempt: ProjectionAttempt) => Promise<void>,
    options: { retryOnConnectionError?: boolean } = {},
  ): void {
    const retryOptions =
      options.retryOnConnectionError === true
        ? PROJECTION_RETRY_DEFAULTS
        : { ...PROJECTION_RETRY_DEFAULTS, maxAttempts: 1 };
    eventBus.subscribe(eventType, (event: DomainEvent) => {
      const stationId =
        typeof event.payload.stationId === 'string' ? event.payload.stationId : event.aggregateId;
      return enqueueForStation(projectionLane(event), async () => {
        let attempts = 1;
        try {
          await runProjectionWithRetry((attempt) => handler(event, attempt), {
            ...retryOptions,
            onRetry: ({ attempt, delayMs, err }) => {
              attempts = attempt + 1;
              logger.warn(
                {
                  eventType,
                  stationId,
                  attempt,
                  delayMs,
                  errorCode: pgErrorCode(err),
                  error: err instanceof Error ? err.message : String(err),
                },
                'Event projection lost its database connection; retrying',
              );
            },
          });
        } catch (err) {
          const stationOcppId =
            typeof event.payload.stationId === 'string'
              ? event.payload.stationId
              : event.aggregateType === 'ChargingStation'
                ? event.aggregateId
                : null;
          if (await failedOnDeletedStation(err, stationOcppId)) {
            logger.debug(
              {
                eventType,
                aggregateId: event.aggregateId,
                stationId,
                errorCode: pgErrorCode(err),
                constraint: pgConstraintName(err),
              },
              'Event projection skipped: the station no longer exists',
            );
            return;
          }
          logger.error(
            {
              eventType,
              aggregateId: event.aggregateId,
              stationId,
              attempts,
              errorCode: pgErrorCode(err),
              error: err instanceof Error ? err.message : String(err),
            },
            'Event projection failed',
          );
        }
      });
    });
  }

  // A station deleted while it is connected (an operator or a test cleanup
  // deleting the row) still has events in its projection lane: the message log
  // of its last messages, its disconnect. Their INSERTs then fail with a foreign
  // key violation. The WHERE EXISTS guards cannot prevent all of them: the guard
  // reads a snapshot that still holds the station while the DELETE runs, and the
  // foreign key check then waits for the DELETE and fails once it commits. Such
  // a failure is expected only when the station is gone; a foreign key
  // violation for a station that exists is a bug and is logged as one.
  async function failedOnDeletedStation(
    err: unknown,
    stationOcppId: string | null,
  ): Promise<boolean> {
    if (stationOcppId == null || pgErrorCode(err) !== PG_FOREIGN_KEY_VIOLATION) return false;
    try {
      const rows = await sql`SELECT 1 FROM charging_stations WHERE station_id = ${stationOcppId}`;
      if (rows.length > 0) return false;
    } catch (lookupErr) {
      logger.warn(
        { err: lookupErr, stationId: stationOcppId },
        'Station lookup after a failed projection failed',
      );
      return false;
    }
    // Later events of the station must not reuse its cached database id.
    invalidateStationCache(stationOcppId);
    return true;
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
    idleAt: string,
  ): Promise<void> {
    // The station reported the vehicle idle (2.1 chargingState, 1.6 status).
    // One statement marks the session idle (keeping a period already open) and
    // claims the period by copying its start into idle_notified_at; only the
    // claiming call gets a row and notifies. So two events of one period
    // (ChargingStateChanged then CostLimitReached, repeated SuspendedEV) notify
    // once, a meter reading cannot end the period between the mark and the
    // claim (the meter fallbacks never clear a claimed period), and a later
    // period has a new idle_started_at and notifies again.
    // The idle fee and tax rate that apply now: the open tariff segment's
    // snapshot (split billing), else the session's.
    const idleSession = await sql`
      WITH claimed AS (
        UPDATE charging_sessions
        SET idle_started_at = COALESCE(idle_started_at, ${idleAt}::timestamptz),
            idle_notified_at = COALESCE(idle_started_at, ${idleAt}::timestamptz),
            updated_at = now()
        WHERE id = ${sessionId} AND status = 'active'
          AND idle_notified_at IS DISTINCT FROM COALESCE(idle_started_at, ${idleAt}::timestamptz)
        RETURNING id, idle_started_at
      )
      SELECT cs.driver_id, claimed.idle_started_at,
             CASE WHEN seg.price_snapshot THEN seg.idle_fee_price_per_minute
                  ELSE cs.tariff_idle_fee_price_per_minute END AS idle_fee_price_per_minute,
             CASE WHEN seg.price_snapshot THEN seg.tax_rate
                  ELSE cs.tariff_tax_rate END AS tax_rate,
             cs.tax_basis, d.price_display, UPPER(cs.currency) AS currency
      FROM charging_sessions cs
      JOIN claimed ON claimed.id = cs.id
      LEFT JOIN drivers d ON d.id = cs.driver_id
      LEFT JOIN LATERAL (
        SELECT price_snapshot, idle_fee_price_per_minute, tax_rate
        FROM session_tariff_segments
        WHERE session_id = cs.id AND ended_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1
      ) seg ON true
      WHERE cs.id = ${sessionId}
    `;
    const idleRow = idleSession[0];
    if (idleRow == null) return;

    const stationUuid = await resolveStationUuid(stationId);
    const gracePeriodMinutes = await getIdlingGracePeriodMinutes();
    const idleFeeRate = idleRow.idle_fee_price_per_minute as string | null;
    const idleSiteName = stationUuid != null ? await resolveSiteName(stationUuid) : null;

    // The idle fee is shown as the driver chose in the portal, else as the
    // company setting says. Guests have no choice and follow the setting.
    const priceDisplay = resolvePriceDisplay(idleRow.price_display, await getCompanyPriceDisplay());
    const idleFee = idleFeeRate != null ? Number(idleFeeRate) : 0;
    const taxRate = idleRow.tax_rate != null ? Number(idleRow.tax_rate) : 0;
    const taxBasis = resolveTaxBasis(idleRow.tax_basis);

    const templateVars = {
      siteName: idleSiteName ?? '',
      stationId,
      transactionId,
      idleStartedAt: idleRow.idle_started_at as string,
      gracePeriodMinutes,
      // The rate as stored, in the session's tax basis. Empty when there is no idle fee (null or 0), so
      // templates that test {{#if idleFeePricePerMinute}} skip the fee text:
      // the string '0' or '0.00' is truthy in Handlebars.
      idleFeePricePerMinute: idleFee > 0 && idleFeeRate != null ? idleFeeRate : '',
      // Empty when there is no idle fee, so templates can test it with #if.
      idleFeeFormatted:
        idleFee > 0
          ? notificationUnitPrice(
              priceForDisplay(idleFee, taxRate, priceDisplay, taxBasis),
              idleRow.currency as string,
            )
          : '',
      idleFeeIncludesTax: priceDisplay === 'gross',
      taxRatePercent: taxRate > 0 ? notificationTaxRate(taxRate) : '',
      currency: idleRow.currency as string,
    };

    if (idleRow.driver_id != null) {
      void eventBus.track(
        dispatchDriverNotification(
          sql,
          'session.IdlingStarted',
          idleRow.driver_id as string,
          templateVars,
          ALL_TEMPLATES_DIRS,
          pubsub,
        ),
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
        void eventBus.track(
          dispatchSystemNotification(
            sql,
            'session.IdlingStarted',
            { email: guestRow.guest_email as string },
            templateVars,
            ALL_TEMPLATES_DIRS,
          ),
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
    } catch (err) {
      logger.debug({ err, eventType, stationId }, 'SSE notification publish failed; continuing');
    }
  }

  // Asks the api to re-render the station screen of an OCPP 2.x transaction.
  async function publishStationMessageTransaction(
    screen: { stationUuid: string; stationId: string; protocol: string | null },
    sessionId: string,
    kind: 'started' | 'updated' | 'ended',
    chargingState: string | null,
  ): Promise<void> {
    if (screen.protocol == null || !screen.protocol.startsWith('ocpp2')) return;
    try {
      await pubsub.publish(
        'station_message_transaction',
        JSON.stringify({
          sessionId,
          internalStationId: screen.stationUuid,
          stationOcppId: screen.stationId,
          ocppProtocol: screen.protocol,
          eventType: kind,
          chargingState,
        }),
      );
    } catch (err) {
      logger.debug(
        { err, sessionId, kind },
        'Station-message transaction publish failed; continuing',
      );
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
    } catch (err) {
      logger.debug({ err, type }, 'OCPI push publish failed; continuing');
    }
  }

  // A session started with a partner's (eMSP's) token is our CPO session for
  // that partner. The link row in ocpi_roaming_sessions is what the OCPI
  // server serves on GET /cpo/sessions, pushes to the partner, and resolves
  // STOP_SESSION and CDRs with. The OCPI Session id is the charging session
  // id: OCPI needs it unique for the CPO, and a transactionId is unique per
  // station only (links written before 0.1.38 keep their transaction id).
  // Written here, before the push is published, so a lost push still leaves
  // the session visible to the partner's next pull. ON CONFLICT keeps it to
  // one link per session when Started is processed twice.
  async function linkCpoRoamingSession(sessionId: string, idToken: string): Promise<void> {
    try {
      await sql`
        INSERT INTO ocpi_roaming_sessions
          (partner_id, ocpi_session_id, charging_session_id, token_uid, status, currency)
        SELECT t.partner_id, ${sessionId}, ${sessionId}, t.uid, 'ACTIVE', cs.currency
        FROM ocpi_external_tokens t
        JOIN charging_sessions cs ON cs.id = ${sessionId}
        WHERE t.uid = ${idToken} AND t.is_valid = true
        ORDER BY t.updated_at DESC
        LIMIT 1
        ON CONFLICT (charging_session_id) WHERE charging_session_id IS NOT NULL DO NOTHING
      `;
    } catch (err) {
      logger.warn({ err, sessionId }, 'OCPI roaming session link failed; continuing');
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
    // Only a found EVSE is cached. The station lane creates an EVSE from its first
    // StatusNotification, and a TransactionEvent or MeterValues on the transaction
    // lane can be projected before that row exists. Caching the miss would leave
    // every session started on that EVSE within the TTL without its EVSE.
    if (uuid != null) evseUuidCache.set(cacheKey, uuid);
    return uuid;
  }

  // The session a transaction-scoped meter reading belongs to, with its EVSE.
  // A transactionId is unique per station, so it decides alone and matches any status (a
  // reading can arrive after the session ended or faulted). An unknown
  // transactionId returns null so the caller buffers it until Started arrives,
  // instead of guessing another session on the station.
  async function resolveMeterValueSession(
    stationUuid: string,
    evseUuid: string | null,
    transactionId: string | undefined,
  ): Promise<{ id: string; evseUuid: string | null } | null> {
    const rows =
      transactionId != null
        ? await sql`
            SELECT id, evse_id FROM charging_sessions
            WHERE station_id = ${stationUuid} AND transaction_id = ${transactionId}
            LIMIT 1
          `
        : evseUuid != null
          ? await sql`
              SELECT id, evse_id FROM charging_sessions
              WHERE evse_id = ${evseUuid} AND status = 'active'
              ORDER BY started_at DESC
              LIMIT 1
            `
          : [];
    const row = rows[0];
    if (row == null) return null;
    return { id: row.id as string, evseUuid: (row.evse_id as string | null) ?? null };
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
  // ---- Payment simulation helpers (used in Started/Ended handlers) ----

  // Retried on a lost connection: the UPDATE is idempotent, and each log INSERT
  // is one statement run once per event.
  safeSubscribe(
    'station.Connected',
    async (event: DomainEvent, attempt: ProjectionAttempt) => {
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

      const connLog = await attempt.once(
        'connection-log',
        () => sql`
          INSERT INTO connection_logs (station_id, event, protocol, remote_address)
          SELECT ${stationUuid}, 'connected', ${ocppProtocol}, ${remoteAddress}
          WHERE EXISTS (SELECT 1 FROM charging_stations WHERE id = ${stationUuid})
        `,
      );
      if (connLog.count === 0) {
        invalidateStationCache(event.aggregateId);
        return;
      }

      // One row per EVSE in one statement, so a retry never logs a part twice.
      await attempt.once(
        'port-status-log',
        () => sql`
          INSERT INTO port_status_log (station_id, evse_id, previous_status, new_status, timestamp)
          SELECT ${stationUuid}, evse_id, 'unavailable', 'available', now()
          FROM evses WHERE station_id = ${stationUuid}
        `,
      );

      const siteId = await resolveSiteId(stationUuid);
      await notifyChange('station.status', stationUuid, siteId);
      if (siteId != null) {
        await notifyOcpiPush('location', { siteId });
      }
    },
    { retryOnConnectionError: true },
  );

  // The station may now receive CSMS calls (BootNotification Accepted, or its
  // first message after a reconnect without a reboot).
  safeSubscribe('station.Ready', async (event: DomainEvent) => {
    const stationUuid = await getStationUuid(event);
    if (stationUuid == null) return;
    const ocppProtocol = (event.payload as { ocppProtocol?: string }).ocppProtocol ?? null;

    // Drain offline command queue for this station
    const stationOcppId = event.aggregateId;
    try {
      // Only the newest queued screen message per display message id and cost
      // update per transaction still matters; older ones would show stale content.
      await sql`
        WITH keyed AS (
          SELECT id, action, created_at,
            CASE action
              WHEN 'SetDisplayMessage' THEN payload -> 'message' ->> 'id'
              WHEN 'ClearDisplayMessage' THEN payload ->> 'id'
              WHEN 'CostUpdated' THEN payload ->> 'transactionId'
            END AS target
          FROM offline_command_queue
          WHERE station_id = ${stationOcppId} AND status = 'pending'
            AND action IN ('SetDisplayMessage', 'ClearDisplayMessage', 'CostUpdated')
        ),
        ranked AS (
          SELECT id, row_number() OVER (
            PARTITION BY action, target ORDER BY created_at DESC, id DESC
          ) AS rn
          FROM keyed
          WHERE target IS NOT NULL
        )
        UPDATE offline_command_queue q
        SET status = 'expired', failed_reason = 'Superseded by a newer queued command'
        FROM ranked
        WHERE q.id = ranked.id AND ranked.rn > 1
      `;
      const pendingCommands = await sql`
        SELECT id, command_id, action, payload, version
        FROM offline_command_queue
        WHERE station_id = ${stationOcppId} AND status = 'pending' AND expires_at > now()
        ORDER BY created_at ASC
      `;
      // Publish all queued commands, collect successful IDs, then batch-update
      // their status in one query. Per-command try/catch ensures a transient
      // publish failure on one command doesn't leave previously-published ones
      // unmarked-as-sent (which would cause duplicate dispatch on next reconnect).
      const sentIds: number[] = [];
      for (const cmd of pendingCommands) {
        try {
          await publishOcppCommand(pubsub, {
            commandId: cmd.command_id as string,
            stationId: stationOcppId,
            action: cmd.action as string,
            payload: cmd.payload as Record<string, unknown>,
            version: cmd.version as string | null,
          });
          sentIds.push(cmd.id as number);
        } catch (publishErr) {
          logger.warn(
            { err: publishErr, stationOcppId, commandId: cmd.command_id },
            'Offline queue drain: publish failed for command; leaving pending for next drain',
          );
        }
      }
      if (sentIds.length > 0) {
        await sql`
          UPDATE offline_command_queue
          SET status = 'sent', sent_at = now()
          WHERE id IN ${sql(sentIds)}
        `;
      }
    } catch (err) {
      logger.debug({ err, stationOcppId }, 'Offline command queue drain failed; continuing');
    }

    // Both versions: OCPP 1.6 stations get the Idle screen through the
    // vendor DataTransfer (station-message.service.ts).
    if (ocppProtocol != null) {
      try {
        await pubsub.publish(
          'station_message_refresh',
          JSON.stringify({
            stationOcppId,
            internalStationId: stationUuid,
            ocppProtocol,
          }),
        );
      } catch (err) {
        logger.debug({ err, stationOcppId }, 'Station-message refresh publish failed; continuing');
      }
    }

    // Re-assert active maintenance. A station that was offline during the
    // maintenance fan-out (or rebooted and lost state) reconnects reporting
    // Available; without this it stays operative for the rest of the window.
    // The worker bridge picks this up and re-sends ChangeAvailability
    // (Inoperative) plus the maintenance display message for this station.
    // Debounced per station: a flapping connection (or a fleet-wide reconnect
    // wave) would otherwise enqueue one fan-out job per reconnect.
    try {
      const lastPublished = reassertDebounce.get(stationUuid);
      if (lastPublished == null) {
        const maintRows = await sql`
          SELECT me.id, me.site_id
          FROM maintenance_events me
          JOIN charging_stations cs ON cs.site_id = me.site_id
          WHERE cs.id = ${stationUuid}
            AND me.status = 'active'
            AND me.planned_start_at < now() AND me.planned_end_at > now()
            AND (me.affected_station_ids IS NULL
                 OR me.affected_station_ids = '{}'::text[]
                 OR ${stationUuid} = ANY(me.affected_station_ids))
          LIMIT 1
        `;
        const activeEvent = maintRows[0];
        if (activeEvent != null) {
          reassertDebounce.set(stationUuid);
          await pubsub.publish(
            'maintenance_fanout',
            JSON.stringify({
              eventId: activeEvent.id as string,
              siteId: activeEvent.site_id as string,
              phase: 'reassert',
              stationDbIds: [stationUuid],
              nonce: Date.now().toString(36),
            }),
          );
        }
      }
    } catch (err) {
      logger.warn({ err, stationOcppId }, 'Maintenance re-assert publish failed; continuing');
    }
  });

  // Retried on a lost connection: the UPDATE is idempotent, each log INSERT is
  // one statement run once per event, and the reservation notifications are
  // the last step and never throw.
  safeSubscribe(
    'station.Disconnected',
    async (event: DomainEvent, attempt: ProjectionAttempt) => {
      const stationUuid = await resolveStationUuid(event.aggregateId);
      if (stationUuid == null) return;

      // A station that already reconnected to another OCPP instance (rolling
      // deploy, load balancer) is still online: only the old connection closed.
      if (registry != null && instanceId != null) {
        try {
          const owner = await registry.getInstanceId(event.aggregateId);
          if (owner != null && owner !== instanceId) {
            logger.info(
              { stationId: event.aggregateId, instanceId, owner },
              'Station is connected to another OCPP instance; not marking it offline',
            );
            return;
          }
        } catch (err) {
          logger.warn(
            { err, stationId: event.aggregateId },
            'Connection registry lookup failed on disconnect; marking the station offline',
          );
        }
      }

      await sql`
      UPDATE charging_stations
      SET is_online = false, updated_at = now()
      WHERE id = ${stationUuid}
    `;

      const { remoteAddress = null, reason = null } = event.payload as {
        remoteAddress?: string;
        reason?: string;
      };
      // A socket this instance closed while stopping (rolling deploy): the station
      // is offline until it reconnects to another instance, but it did not fail.
      const serverShutdown = reason === SERVER_SHUTDOWN_DISCONNECT_REASON;
      const connLog = await attempt.once(
        'connection-log',
        () => sql`
      INSERT INTO connection_logs (station_id, event, remote_address, metadata)
      SELECT ${stationUuid}, 'disconnected', ${remoteAddress},
        ${serverShutdown ? sql.json({ reason }) : null}
      WHERE EXISTS (SELECT 1 FROM charging_stations WHERE id = ${stationUuid})
    `,
      );
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
      await attempt.once(
        'port-status-log',
        () => sql`
      INSERT INTO port_status_log (station_id, evse_id, connector_id, previous_status, new_status, timestamp)
      SELECT ${stationUuid}, e.evse_id, c.connector_id, c.status, 'unavailable', now()
      FROM connectors c
      INNER JOIN evses e ON c.evse_id = e.id
      WHERE e.station_id = ${stationUuid}
        AND c.status != 'unavailable'
    `,
      );

      const siteId = await resolveSiteId(stationUuid);
      await notifyChange('station.status', stationUuid, siteId);
      if (siteId != null) {
        await notifyOcpiPush('location', { siteId });
      }

      // Notify drivers with active or in_use reservations on the disconnected
      // station. Not on a server shutdown: the station did not fault and
      // reconnects within seconds, so every deploy would email those drivers.
      if (serverShutdown) return;
      const stationOcppId = event.aggregateId;
      try {
        const affectedReservations = await sql`
        SELECT id, driver_id FROM reservations
        WHERE station_id = ${stationUuid}
          AND status IN ('active', 'in_use')
      `;
        for (const reservation of affectedReservations) {
          if (reservation.driver_id == null) continue;
          void eventBus.track(
            dispatchDriverNotification(
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
            }),
          );
        }
      } catch (err) {
        logger.error({ err }, 'failed to query reservations for station fault notification');
      }
    },
    { retryOnConnectionError: true },
  );

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
          is_online = true,
          updated_at = now()
        WHERE id = ${stationUuid}
      `;
      // A reboot starts a new status ordering epoch: the station's clock may
      // have moved back, and its post-boot reports carry the current state.
      await startStatusOrderingEpoch(sql, stationUuid);
      // Availability comes from its inputs, so a disable or fault survives the
      // reboot. A reboot ends a firmware install, so one still marked
      // installing is cleared; a failed install stays until the operator enables.
      await clearStationFirmwareInstalling(sql, stationUuid);
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

    // Refresh display-message slots before the config push: the push block
    // below early-returns when debounced and must stay the LAST block in this
    // handler.
    try {
      const [msgStationRow] = await sql`
        SELECT ocpp_protocol FROM charging_stations WHERE id = ${stationUuid}
      `;
      const msgProtocol = msgStationRow?.ocpp_protocol as string | null;
      if (msgProtocol != null) {
        await pubsub.publish(
          'station_message_refresh',
          JSON.stringify({
            stationOcppId: event.aggregateId,
            internalStationId: stationUuid,
            ocppProtocol: msgProtocol,
          }),
        );
      }
    } catch (err) {
      logger.debug({ err }, 'Station-message refresh publish failed; continuing');
    }

    // Push OCPP configuration to station after boot
    try {
      if (bootConfigRecentlyPushed(event.aggregateId)) {
        logger.debug({ stationId: event.aggregateId }, 'Boot config push skipped: pushed recently');
        return;
      }
      markBootConfigPushed(event.aggregateId);
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
        publishOcppCommand(pubsub, { stationId: stationOcppId, action, payload, version });

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
      const siteFreeVendEnabled = await isSiteFreeVendEnabledByStation(stationOcppId);
      if (siteFreeVendEnabled) {
        if (protocol === 'ocpp2.1') {
          await publishCmd(
            'SetVariables',
            {
              setVariableData: FREE_VEND_OCPP_21_VARIABLES.map((v) => ({
                component: { name: v.component },
                variable: { name: v.variable },
                attributeValue: v.value,
              })),
            },
            'ocpp2.1',
          );
        } else if (protocol === 'ocpp1.6') {
          // OCPP 1.6 has no standard "disable auth" key. The closest
          // standard keys that ease offline/autostart behavior:
          for (const cfg of FREE_VEND_OCPP_16_KEYS) {
            await publishCmd('ChangeConfiguration', { key: cfg.key, value: cfg.value }, 'ocpp1.6');
          }
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
  });

  // Retried on a lost connection: the UPDATE and the registry refresh are idempotent.
  safeSubscribe(
    'ocpp.Heartbeat',
    async (event: DomainEvent) => {
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
        } catch (err) {
          logger.debug(
            { err, instanceId, aggregateId: event.aggregateId },
            'Registry refresh failed on heartbeat; continuing',
          );
        }
      }
    },
    { retryOnConnectionError: true },
  );

  // Retried on a lost connection. The status write is guarded by the report
  // timestamp (an equal timestamp applies again with the same result), and its
  // first result is kept so the follow-ups see the real previous status. The
  // command publishes run once; the 1.6 idle statements are guarded (the idle
  // notification is claimed in its UPDATE); the station-watch check is last
  // and never throws.
  safeSubscribe(
    'ocpp.StatusNotification',
    async (event: DomainEvent, attempt: ProjectionAttempt) => {
      const payload = event.payload;
      const stationUuid = await resolveStationUuid(event.aggregateId);
      if (stationUuid == null) return;

      const evseIdNum = payload.evseId as number;
      const connectorIdNum = payload.connectorId as number;
      const ocppStatus = payload.connectorStatus as string;
      const dbStatus = OCPP_STATUS_MAP[ocppStatus] ?? 'unavailable';
      // The station's own timestamp orders status reports; null when a 1.6
      // station sent none (see statusReportedAt in station-status.ts).
      const reportedTimestamp = typeof payload.timestamp === 'string' ? payload.timestamp : null;

      // EVSE 0 is the station itself (OCPP 1.6 connector 0, OCPP 2.x evseId 0 or
      // NotifyEvent ChargingStation), never a plug: record it on the station
      // instead of creating an EVSE 0 / connector 0 row.
      if (evseIdNum === 0) {
        const reported =
          dbStatus === 'faulted'
            ? 'faulted'
            : dbStatus === 'unavailable'
              ? 'unavailable'
              : 'available';
        const stationChange = await attempt.memo('station-status', () =>
          setStationReportedStatus(sql, stationUuid, reported, reportedTimestamp),
        );
        if (!stationChange.applied) {
          logger.info(
            { stationId: event.aggregateId, status: ocppStatus, timestamp: reportedTimestamp },
            'Ignored a station status older than the stored one',
          );
          return;
        }
        const stationSiteId = await resolveSiteId(stationUuid);
        await notifyChange('station.status', stationUuid, stationSiteId);
        if (stationSiteId != null) {
          await notifyOcpiPush('location', { siteId: stationSiteId });
        }
        return;
      }

      const applied = await attempt.memo('connector-status', () =>
        applyConnectorStatus(sql, {
          stationUuid,
          evseId: evseIdNum,
          connectorId: connectorIdNum,
          status: dbStatus,
          timestamp: reportedTimestamp,
        }),
      );
      if (!applied.stationExists) {
        invalidateStationCache(event.aggregateId);
        return;
      }
      // An older report than the stored one (offline replay, another projection
      // lane or pod) changed nothing, so none of the follow-ups below apply.
      if (!applied.applied) {
        logger.info(
          {
            stationId: event.aggregateId,
            evseId: evseIdNum,
            connectorId: connectorIdNum,
            status: ocppStatus,
            timestamp: reportedTimestamp,
          },
          'Ignored a connector status older than the stored one',
        );
        return;
      }
      const resolvedEvseUuid = applied.evseUuid;
      const previousDbStatus = applied.previousStatus;
      const didAutoCreateConnector = applied.autoCreated;

      const siteId = await resolveSiteId(stationUuid);
      await notifyChange('station.status', stationUuid, siteId);
      if (siteId != null) {
        await notifyOcpiPush('location', { siteId });
      }

      // We just learned about a new EVSE/connector by auto-discovery. The
      // 'Unknown' default in connectors.connector_type lets the listing
      // surface the row, but the spec-defined way to learn the real plug
      // shape is to ask the station for its device-model report. OCPP 2.1's
      // GetBaseReport(ConfigurationInventory) returns a NotifyReport that
      // includes Connector.ConnectorType variables, which the NotifyReport
      // projection above writes into connectors.connector_type (guarded so
      // it only overwrites 'Unknown', never an operator pick). OCPP 1.6 has
      // no equivalent, so skip there.
      if (didAutoCreateConnector) {
        await attempt.once('get-base-report', async () => {
          try {
            const [stationRow] = await sql`
          SELECT ocpp_protocol FROM charging_stations WHERE id = ${stationUuid}
        `;
            const ocppProtocol = stationRow?.['ocpp_protocol'] as string | undefined;
            if (ocppProtocol === 'ocpp2.1') {
              // event.aggregateId is the station's OCPP string id (set by the
              // StatusNotification handler), so we can publish directly without
              // another DB lookup.
              await publishOcppCommand(pubsub, {
                stationId: event.aggregateId,
                action: 'GetBaseReport',
                payload: {
                  requestId: Math.floor(Math.random() * 2_000_000_000),
                  reportBase: 'ConfigurationInventory',
                },
                version: 'ocpp2.1',
              });
            }
          } catch (err) {
            logger.warn(
              { err, stationUuid },
              'auto-discovery GetBaseReport(ConfigurationInventory) publish failed',
            );
          }
        });
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
        await attempt.once('station-message-refresh', async () => {
          try {
            const [stationRow] = await sql`
          SELECT ocpp_protocol FROM charging_stations WHERE id = ${stationUuid}
        `;
            const protocol = stationRow?.ocpp_protocol as string | null | undefined;
            if (protocol != null) {
              await pubsub.publish(
                'station_message_refresh',
                JSON.stringify({
                  stationOcppId: event.aggregateId,
                  internalStationId: stationUuid,
                  ocppProtocol: protocol,
                }),
              );
            }
          } catch (err) {
            logger.debug(
              { err, stationId: event.aggregateId },
              'Station-message refresh publish failed; continuing',
            );
          }
        });
      }

      // OCPP 1.6 StatusNotification idle detection fallback.
      // OCPP 1.6 sends fine-grained statuses (SuspendedEV, SuspendedEVSE, Finishing, Charging).
      // OCPP 2.1 only sends coarse statuses (Available, Occupied, Reserved, Unavailable, Faulted).
      // If we see a 1.6-specific status, use it for idle detection on active sessions
      // that do not already have idle_started_at set by a higher-priority signal.
      const IDLE_STATUSES_1_6 = new Set(['SuspendedEV', 'SuspendedEVSE', 'Finishing']);
      const RESUME_STATUSES_1_6 = new Set(['Charging', 'Preparing']);

      if (IDLE_STATUSES_1_6.has(ocppStatus)) {
        const statusTimestamp =
          (payload.timestamp as string | undefined) ?? new Date().toISOString();
        await sql`
        UPDATE charging_sessions
        SET idle_started_at = ${statusTimestamp}, updated_at = now()
        WHERE station_id = ${stationUuid} AND status = 'active' AND idle_started_at IS NULL
          AND evse_id = ${resolvedEvseUuid}
      `;

        // Dispatch idling notification for the active session on this EVSE
        // (it re-marks the period if a meter reading ended it in between).
        const activeSession = await sql`
        SELECT id, transaction_id FROM charging_sessions
        WHERE station_id = ${stationUuid} AND status = 'active'
          AND evse_id = ${resolvedEvseUuid}
      `;
        const sess = activeSession[0];
        if (sess != null) {
          await dispatchIdlingNotification(
            sess.id as string,
            event.aggregateId,
            sess.transaction_id as string,
            statusTimestamp,
          );
        }
      } else if (RESUME_STATUSES_1_6.has(ocppStatus)) {
        const statusTimestamp =
          (payload.timestamp as string | undefined) ?? new Date().toISOString();
        await sql`
        UPDATE charging_sessions
        SET idle_minutes = idle_minutes + EXTRACT(EPOCH FROM (${statusTimestamp}::timestamptz - idle_started_at)) / 60,
            idle_started_at = NULL,
            updated_at = now()
        WHERE station_id = ${stationUuid} AND status = 'active' AND idle_started_at IS NOT NULL
          AND evse_id = ${resolvedEvseUuid}
      `;
      }

      // Station-watch alert: a connector just became available. When it is the
      // ONLY available connector at the station (full -> free edge), a driver is
      // watching, and the site is not under maintenance, publish so the worker
      // notifies the watchers. One combined indexed query, run only on this rare
      // available-edge (never on every StatusNotification). Kept last in the
      // handler so its query never reorders the writes above. Fail-open.
      if (dbStatus === 'available' && previousDbStatus !== 'available') {
        try {
          const edgeRows = await sql`
          SELECT
            (SELECT count(*) FROM connectors c
               JOIN evses e ON e.id = c.evse_id
               WHERE e.station_id = ${stationUuid} AND c.status = 'available') AS available_count,
            EXISTS (
              SELECT 1 FROM station_watches w
              WHERE w.station_id = ${stationUuid} AND w.expires_at > now()
            ) AS has_watchers,
            EXISTS (
              SELECT 1 FROM maintenance_events m
              WHERE m.status = 'active'
                AND m.site_id = (SELECT site_id FROM charging_stations WHERE id = ${stationUuid})
                AND (
                  m.affected_station_ids IS NULL
                  OR array_length(m.affected_station_ids, 1) IS NULL
                  OR ${stationUuid} = ANY (m.affected_station_ids)
                )
            ) AS under_maintenance
        `;
          const edge = edgeRows[0];
          if (
            edge != null &&
            Number(edge.available_count) === 1 &&
            edge.has_watchers === true &&
            edge.under_maintenance === false
          ) {
            await pubsub.publish(
              'station_watch_available',
              JSON.stringify({ stationId: event.aggregateId }),
            );
          }
        } catch (err) {
          logger.warn({ err, stationUuid }, 'Station-watch edge check failed');
        }
      }
    },
    { retryOnConnectionError: true },
  );

  async function projectTransactionEvent(event: DomainEvent): Promise<void> {
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

    const screenStationUuid = stationUuid;
    async function publishTransactionScreen(
      sessionId: string,
      kind: 'started' | 'updated' | 'ended',
      chargingState: string | null,
    ): Promise<void> {
      try {
        const [stationRow] = await sql`
          SELECT ocpp_protocol FROM charging_stations WHERE id = ${screenStationUuid}
        `;
        const protocol = (stationRow?.ocpp_protocol as string | null | undefined) ?? null;
        await publishStationMessageTransaction(
          { stationUuid: screenStationUuid, stationId, protocol },
          sessionId,
          kind,
          chargingState,
        );
      } catch (err) {
        logger.debug({ err, sessionId, kind }, 'Station protocol lookup failed; continuing');
      }
    }

    if (eventType === 'Started') {
      // For remote starts, link back to the session created by the portal/API
      // instead of creating a duplicate.
      // The connector the station reports for the transaction (1.6 connectorId,
      // 2.1 evse.connectorId). When it is missing or matches no connector, an
      // EVSE with a single connector uses that one. Applied in the insert and
      // the remote-start link.
      const reportedConnector =
        typeof payload.connectorId === 'number' ? payload.connectorId : null;
      let sessionId: string | null = null;
      if (triggerReason === 'RemoteStart') {
        // Atomic pick-and-link in one statement so concurrent Started events
        // (different transactionIds, parallel projection queues) cannot both
        // claim the same pending row. Without FOR UPDATE SKIP LOCKED, two
        // simultaneous portal starts on the same station would both UPDATE
        // the same row and the second would orphan the first's linkage.
        // Only a transactionId new for the station links a session: a Started
        // the station sends again (a resend after a lost response, E13.FR.02,
        // or an offline replay, E04.FR.02) is the same transaction and falls
        // through to the insert, whose ON CONFLICT returns the session already
        // holding it. Only a remote start still waiting for its transaction
        // (no transaction_events row) is linked, so a session never moves to
        // another transaction.
        const linked = await sql`
          WITH target AS (
            SELECT pending.id FROM charging_sessions pending
            WHERE pending.station_id = ${stationUuid}
              AND pending.remote_start_id IS NOT NULL
              AND pending.status = 'active'
              AND NOT EXISTS (
                SELECT 1 FROM transaction_events te WHERE te.session_id = pending.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM charging_sessions holder
                WHERE holder.station_id = ${stationUuid}
                  AND holder.transaction_id = ${transactionId}
              )
            ORDER BY pending.started_at DESC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          )
          UPDATE charging_sessions cs
          SET transaction_id = ${transactionId},
              connector_id = COALESCE(cs.connector_id, (
                SELECT c.id FROM connectors c
                WHERE c.evse_id = cs.evse_id
                  AND (c.connector_id = ${reportedConnector}
                    OR (SELECT count(*) FROM connectors c2 WHERE c2.evse_id = cs.evse_id) = 1)
                LIMIT 1
              )),
              updated_at = now()
          FROM target
          WHERE cs.id = target.id
          RETURNING cs.id
        `;
        if (linked[0] != null) {
          sessionId = linked[0].id as string;
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
        let txEvseUuid = await resolveEvseUuid(stationUuid, ocppEvseId);
        if (txEvseUuid == null && ocppEvseId > 0 && projectionLane(event) !== stationId) {
          // The EVSE is created by the projection of the station's first
          // StatusNotification, which runs on the station lane, while this
          // event runs on the transaction lane. A new station that reports the
          // EVSE and starts a transaction right after would get a session
          // without its EVSE and connector, which nothing fills in later. The
          // station sent that StatusNotification before this event, so its
          // projection is already queued: wait for the station lane (bounded)
          // and look again. An event already on the station lane never waits
          // for its own lane.
          await projectionQueue.settled([stationId], EVSE_LANE_WAIT_MS);
          txEvseUuid = await resolveEvseUuid(stationUuid, ocppEvseId, true);
        }
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
          } catch (err) {
            logger.debug(
              { err, idToken: earlyIdToken },
              'OCPI external-token lookup failed; defaulting to non-roaming',
            );
            initialIsRoaming = false;
          }
        }
        // Atomic insert + capture: ON CONFLICT DO UPDATE with a no-op (touches
        // updated_at) lets RETURNING fire on both the insert and the conflict
        // path, eliminating the race window where a separate SELECT could
        // miss the row if a concurrent process (stale-session cleanup,
        // operator delete) removed it between INSERT and SELECT.
        // The session is billed in the company currency at its start.
        const initialCurrency = await getCompanyCurrency();
        const inserted = await sql`
          INSERT INTO charging_sessions (id, station_id, evse_id, connector_id, transaction_id, status, started_at, meter_start, is_roaming, currency)
          VALUES (${newSessionId}, ${stationUuid}, ${txEvseUuid}, (
            SELECT c.id FROM connectors c
            WHERE c.evse_id = ${txEvseUuid}
              AND (c.connector_id = ${reportedConnector}
                OR (SELECT count(*) FROM connectors c2 WHERE c2.evse_id = ${txEvseUuid}) = 1)
            LIMIT 1
          ), ${transactionId}, 'active', ${timestamp}, ${meterStartVal}, ${initialIsRoaming}, ${initialCurrency})
          ON CONFLICT (station_id, transaction_id) DO UPDATE SET updated_at = now()
          RETURNING id
        `;
        sessionId = getSessionId(inserted);
      }
      if (sessionId != null) {
        // Close stale active sessions on the same EVSE (if any).
        // A new transaction starting means any previous session on this EVSE ended
        // without a proper Ended event (e.g., station rebooted, connection lost).
        // Such a session is ended the normal way, as completed with its
        // final cost, settlement, and receipt (owner decision 2026-10-04):
        // requestCsmsSessionEnd claims it while it is still active (P5) and
        // queues a CSMS end behind this event.
        const stale = await sql`
          SELECT id FROM charging_sessions
          WHERE station_id = ${stationUuid} AND status = 'active'
            AND id != ${sessionId}
            AND evse_id = (SELECT evse_id FROM charging_sessions WHERE id = ${sessionId})
        `;
        for (const r of stale) {
          const staleId = r['id'] as string;
          try {
            await requestCsmsSessionEnd(sql, eventBus, staleId, 'Superseded');
          } catch (err: unknown) {
            logger.error({ err, sessionId: staleId }, 'Failed to end a superseded session');
          }
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
            await applyEvseChargingState(sql, startEvseUuid, 'ev_connected', timestamp);
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
        const isFreeVend = await isSiteFreeVendEnabledByStation(stationId);

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
        let tokenLookup: {
          id: string;
          driverId: string | null;
          prepaidBalanceCents: number | null;
        } | null = null;
        // The tariff snapshotted on the session (null: no tariff applies).
        let sessionTariff: TariffPriceSnapshot | null = null;

        if (isFreeVend) {
          // Mark session as free-vend and skip driver resolution + payment
          // gate. driver_id is preserved as-is: if the portal start endpoint
          // (authenticated or guest) inserted the row with a driverId, that
          // is a legitimate "who initiated this session" record and the
          // portal's per-driver session queries depend on it. Truly
          // anonymous free-vend starts (RFID-less plug-in) already have
          // driver_id IS NULL from the INSERT path.
          await sql`
            UPDATE charging_sessions
            SET free_vend = true, updated_at = now()
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
          if (idTokenValue != null) {
            const tokenRows = await sql`
              SELECT id, driver_id, prepaid_balance_cents FROM driver_tokens
              WHERE id_token = ${idTokenValue} AND is_active = true
              LIMIT 1
            `;
            const r = tokenRows[0];
            if (r != null) {
              tokenLookup = {
                id: r.id as string,
                driverId: (r.driver_id as string | null) ?? null,
                prepaidBalanceCents:
                  r.prepaid_balance_cents != null ? Number(r.prepaid_balance_cents) : null,
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
                SELECT status, guest_email, pre_auth_amount_cents, provider_payment_id
                FROM guest_sessions
                WHERE session_token = ${idTokenValue}
                LIMIT 1
              `;
              const guest = guestRows[0];
              if (guest != null) {
                guestStatus = guest.status as string;
                guestEmail = (guest.guest_email as string | null) ?? null;
                // The guest's card authorization is the ceiling for the cost
                // (OCPP 2.1 C25 step 9): a guest has no saved card for a
                // top-up. Stamped now, before the first running cost, so the
                // cost assembly never bills more than the hold (P4).
                const holdCents = guest.pre_auth_amount_cents as number | null;
                if (
                  holdCents != null &&
                  guest.provider_payment_id != null &&
                  (guestStatus === 'payment_authorized' || guestStatus === 'charging')
                ) {
                  await sql`
                    UPDATE charging_sessions
                    SET cost_ceiling_cents = ${holdCents}, updated_at = now()
                    WHERE id = ${sessionId}
                  `;
                }
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

          // Resolve the tariff for this station and snapshot its prices and the
          // company tax basis on the session, with the first tariff segment.
          // The session is priced from these snapshots only (issue #33). The
          // payment gate decides free or paid from this same tariff.
          sessionTariff = await resolveStationTariff({ stationUuid, driverUuid }, sql);
          if (sessionTariff != null) {
            await snapshotSessionTariff(
              sql,
              sessionId,
              sessionTariff,
              await getCompanyTaxBasis(),
              timestamp,
            );
          }
        }

        // Link reservation to session if reservationId present
        let linkedReservationId: string | null = null;
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
              linkedReservationId = reservationUuid;
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
                await notifyChange('reservation.changed', stationUuid, null, sessionId);
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
          } catch (err) {
            logger.debug(
              { err, sessionId },
              'Reservation linking failed; continuing session creation',
            );
          }
        }

        // The session has its tariff snapshot and reservation: the 2.1 handler
        // can answer the Started event with the running cost (OCTT TC_E_109).
        projectionQueue.signal(sessionPricedKey(stationId, transactionId));

        const siteId = await resolveSiteId(stationUuid);
        await notifyChange('session.started', stationUuid, siteId, sessionId);
        const roamingIdToken = payload.idToken as string | null | undefined;
        if (isRoamingSession && roamingIdToken != null) {
          await linkCpoRoamingSession(sessionId, roamingIdToken);
        }
        await notifyOcpiPush('session', { sessionId });

        // Notify guest session service for linking. Runs for both free-vend
        // and paid sessions: the guest portal polls /v1/portal/guest/status
        // and stays on "Starting charging" until guest_sessions.charging_session_id
        // is set, which only happens when this event fires and is handled
        // by linkGuestSession() in @evtivity/api.
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
          } catch (err) {
            logger.debug({ err, sessionId }, 'Guest session SSE publish failed; continuing');
          }
        }

        if (!isFreeVend) {
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
            prepaidBalanceCents: tokenLookup?.prepaidBalanceCents ?? null,
            reserved: linkedReservationId != null,
            sessionTariff,
          });
        }

        // A driver who starts charging at a station they were watching no
        // longer needs the "now free" alert (they can start on a startable but
        // not-yet-available connector, which never fires the watch). Clears only
        // the starting driver's own watch; other drivers watching this station
        // keep theirs. The null-driver subquery matches no rows, so guest/
        // anonymous starts are a no-op. Kept last in the Started block so it
        // never reorders the writes above. Fail-open.
        try {
          await sql`
            DELETE FROM station_watches
            WHERE station_id = ${stationUuid}
              AND driver_id = (SELECT driver_id FROM charging_sessions WHERE id = ${sessionId})
          `;
        } catch (err) {
          logger.warn({ err, stationUuid }, 'Station-watch clear-on-start failed');
        }
      }

      // Drain buffered out-of-order events for this transaction
      const buffered = txBuffer.drain(stationId, transactionId);
      for (const bufferedEvent of buffered) {
        void eventBus.publish(bufferedEvent);
      }

      // Refresh station display with the in-progress transaction message.
      // Defer to the api-side listener so the renderer + push logic stays
      // in one place and we don't pull the renderer into the OCPP package.
      if (sessionId != null) {
        const startedChargingState = (payload.chargingState as string | undefined) ?? null;
        await publishTransactionScreen(sessionId, 'started', startedChargingState);
      }
    } else if (eventType === 'Updated') {
      const updatedRows = await sql`
        SELECT id, evse_id FROM charging_sessions
        WHERE station_id = ${stationUuid} AND transaction_id = ${transactionId}
      `;
      const updatedRow = updatedRows[0];
      const sessionId = updatedRow != null ? (updatedRow.id as string) : null;
      const sessionEvseUuid = updatedRow != null ? (updatedRow.evse_id as string | null) : null;
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

            // Dispatch idling notification to driver or guest (claims the period)
            await dispatchIdlingNotification(sessionId, stationId, transactionId, timestamp);
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

        // Update connector status from chargingState (OCPP 2.1 enrichment).
        // Portal SSE forwarder only relays 'station.status', so the
        // 'session.updated' notify below isn't enough -- we publish here too.
        if (chargingState != null) {
          const connectorStatus = CHARGING_STATE_TO_STATUS[chargingState];
          if (connectorStatus != null && sessionEvseUuid != null) {
            await applyEvseChargingState(sql, sessionEvseUuid, connectorStatus, timestamp);
            const updatedStationStatusSiteId = await resolveSiteId(stationUuid);
            await notifyChange('station.status', stationUuid, updatedStationStatusSiteId);
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
          RETURNING driver_id, energy_delivered_wh, current_cost_cents, started_at,
                    tariff_tax_rate, UPPER(currency) AS currency
        `;
        if (throttleResult.length > 0 && throttleResult[0] != null) {
          const updatedSession = throttleResult[0];
          const startedAtDate = new Date(updatedSession.started_at as string);
          const durationMinutes = Math.round((Date.now() - startedAtDate.getTime()) / 60000);
          const updatedSiteName = await resolveSiteName(stationUuid);
          void eventBus.track(
            dispatchDriverNotification(
              sql,
              'session.Updated',
              updatedSession.driver_id as string,
              {
                siteName: updatedSiteName ?? '',
                stationId,
                transactionId,
                energyDeliveredWh: updatedSession.energy_delivered_wh as number,
                currentCostCents: updatedSession.current_cost_cents as number,
                costFormatted: notificationMoney(
                  (updatedSession.current_cost_cents as number | null) ?? 0,
                  updatedSession.currency as string,
                ),
                // Templates label the cost "incl. tax" only when it contains tax.
                costIncludesTax: costIncludesTax(
                  updatedSession.current_cost_cents as number | null,
                  updatedSession.tariff_tax_rate as string | null,
                ),
                currency: updatedSession.currency as string,
                durationMinutes,
              },
              ALL_TEMPLATES_DIRS,
              pubsub,
            ),
          );
        }

        const updatedChargingState = getString(payload, 'chargingState');
        await publishTransactionScreen(sessionId, 'updated', updatedChargingState);
      } else {
        txBuffer.add(stationId, transactionId, event);
      }
    } else if (eventType === 'Ended') {
      const stoppedReason = getString(payload, 'stoppedReason');

      // Check if this session was stopped due to a payment failure (pre-auth or missing payment method)
      const failedPaymentRows = await sql`
        SELECT id FROM payment_records
        WHERE session_id = (
          SELECT id FROM charging_sessions
          WHERE station_id = ${stationUuid} AND transaction_id = ${transactionId}
        )
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
      //
      // OCPP 1.6 StopTransaction carries the final register reading. Energy
      // is otherwise only derived from periodic MeterValues, which lag behind
      // the stop (a 60s sample interval leaves up to a minute uncounted), so
      // use meterStop - meterStart as the final energy. Never lower the value
      // already derived from meter readings (e.g. a station reporting 0).
      await sql`
        UPDATE charging_sessions
        SET status = CASE
              WHEN status IN ('faulted', 'failed') THEN status
              ELSE ${endStatus}
            END,
            ended_at = ${timestamp},
            stopped_reason = COALESCE(stopped_reason, ${stoppedReason}),
            meter_stop = COALESCE(${meterStopVal}, meter_stop),
            energy_delivered_wh = CASE
              WHEN ${meterStopVal}::numeric IS NOT NULL AND meter_start IS NOT NULL
                AND ${meterStopVal}::numeric >= meter_start
              THEN GREATEST(COALESCE(energy_delivered_wh, 0), ${meterStopVal}::numeric - meter_start)
              ELSE energy_delivered_wh
            END,
            updated_at = now()
        WHERE station_id = ${stationUuid} AND transaction_id = ${transactionId}
      `;

      const sessionRows = await sql`
        SELECT id, evse_id, status, tariff_id, current_cost_cents, started_at, ended_at,
               energy_delivered_wh, currency, tariff_tax_rate, idle_started_at, idle_minutes,
               reservation_id
        FROM charging_sessions
        WHERE station_id = ${stationUuid} AND transaction_id = ${transactionId}
      `;
      const sessionRow = sessionRows[0];
      if (sessionRow != null) {
        const sessionId = sessionRow.id as string;
        const endedEvseUuid = sessionRow.evse_id as string | null;

        // OCPP 2.1: chargingState is on transactionInfo of the Ended event (e.g. EVConnected
        // when the cable is still plugged after a remote stop). Mirror the Updated-handler
        // behaviour so the connector badge transitions out of 'charging' even when the
        // station does not send a follow-up StatusNotification.
        const endedChargingState = getString(payload, 'chargingState');
        if (endedChargingState != null) {
          const endedConnectorStatus = CHARGING_STATE_TO_STATUS[endedChargingState];
          if (endedConnectorStatus != null && endedEvseUuid != null) {
            await applyEvseChargingState(sql, endedEvseUuid, endedConnectorStatus, timestamp);
            const endedSiteId = await resolveSiteId(stationUuid);
            await notifyChange('station.status', stationUuid, endedSiteId);
          }
        }

        // The EV never connected (EVConnectTimeout, no energy): the session
        // fails and is not billed (C20.FR.02/03). A faulted or failed status
        // the CASE guard preserved stays (P5). The cost is zeroed eagerly so
        // the settlement below cancels the hold, and `sessionStatus` carries
        // the status this update wrote: `sessionRow` was read before it.
        const isTimeoutEnd = isUnbilledTimeoutEnd({
          triggerReason,
          stoppedReason,
          energyWh: Number(sessionRow.energy_delivered_wh ?? 0),
        });
        let sessionStatus = sessionRow.status as string;
        if (isTimeoutEnd) {
          await sql`
            UPDATE charging_sessions
            SET status = CASE WHEN status IN ('faulted', 'failed') THEN status ELSE 'failed' END,
                final_cost_cents = 0,
                current_cost_cents = 0,
                updated_at = now()
            WHERE id = ${sessionId}
          `;
          if (sessionStatus !== 'faulted') sessionStatus = 'failed';
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
        // other pre-stop path), or failed by the timeout end above: the
        // driver is not charged, so pricePerSession + tax would be a phantom
        // cost in Recent Sessions and the portal, and a capture of the hold.
        const skipCostCalc = sessionStatus === 'faulted' || sessionStatus === 'failed';
        const hasTariffSnapshot = sessionRow.tariff_id != null;
        if (hasTariffSnapshot && !skipCostCalc) {
          const endedAt = new Date(sessionRow.ended_at as string);
          const energyWh = Number(sessionRow.energy_delivered_wh ?? 0);
          const idleMinutes = sessionIdleMinutesAt(
            {
              idleStartedAt:
                sessionRow.idle_started_at != null
                  ? new Date(sessionRow.idle_started_at as string)
                  : null,
              idleMinutes: Number(sessionRow.idle_minutes ?? 0),
            },
            endedAt,
          );

          // Close the open tariff segment with the idle not yet attributed to
          // closed segments.
          await closeOpenSegment(sql, sessionId, endedAt, energyWh, idleMinutes);

          // The one cost assembly prices the session from its snapshots. The
          // OCPP 2.1 handler priced it the same way and returned the result to
          // the station as totalCost (I03.FR.02); that amount is what is
          // charged, so the session and the station display agree. Should the
          // two ever differ, the breakdown is reconciled to the responded amount.
          const breakdown = await priceSessionAt(sql, sessionId, endedAt, energyWh);
          if (breakdown != null) {
            const respondedCostCents = payload.finalCostCents;
            const responded =
              typeof respondedCostCents === 'number' &&
              Number.isInteger(respondedCostCents) &&
              respondedCostCents >= 0
                ? respondedCostCents
                : null;
            if (responded != null && responded !== breakdown.grossCents) {
              logger.warn(
                { sessionId, respondedCostCents: responded, pricedCents: breakdown.grossCents },
                'Final cost differs from the totalCost sent to the station; charging the sent amount',
              );
            }
            await storeFinalCost(
              sql,
              sessionId,
              responded != null
                ? reconcileCostBreakdown(
                    breakdown,
                    responded,
                    Number(sessionRow.tariff_tax_rate ?? 0),
                  )
                : breakdown,
            );
          }
        }

        // Carbon footprint calculation. LEFT JOIN so we can distinguish
        // "site has no carbon region set" (silent skip, common default
        // state) from "site references a carbon region with no matching
        // factor row" (data anomaly worth logging - typo'd region_code
        // or a factor row deleted out-of-band).
        try {
          const carbonRows = await sql`
            SELECT s.carbon_region_code, cif.carbon_intensity_kg_per_kwh
            FROM charging_stations cs
            JOIN sites s ON s.id = cs.site_id
            LEFT JOIN carbon_intensity_factors cif ON cif.region_code = s.carbon_region_code
            WHERE cs.id = ${stationUuid}
          `;
          const carbonRow = carbonRows[0];
          const regionCode = carbonRow?.['carbon_region_code'] as string | null | undefined;
          const intensityRaw = carbonRow?.['carbon_intensity_kg_per_kwh'] as
            | string
            | number
            | null
            | undefined;
          if (regionCode != null && intensityRaw == null) {
            logger.warn(
              { sessionId, stationUuid, regionCode },
              'Carbon intensity factor missing for region; CO2 calculation skipped',
            );
          } else if (intensityRaw != null) {
            const intensity = Number(intensityRaw);
            const sessionEnergyWh = Number(sessionRow.energy_delivered_wh ?? 0);
            if (sessionEnergyWh > 0 && Number.isFinite(intensity) && intensity > 0) {
              // calculateCo2AvoidedKg clamps to >= 0 so dirty grids never
              // produce a negative "avoided" value.
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

        // Electricity cost (operator's wholesale cost). Forward-only: computed
        // once at session end against the site's TOU rate periods, never
        // backfilled. Fail-open: a missing rate config or any error leaves the
        // column null and never blocks session completion.
        if (siteId != null) {
          try {
            const periods = await getElectricityRatePeriodsForSite(siteId);
            if (periods.length > 0) {
              const [ctxRow] = await sql`
                SELECT cs.ended_at, s.timezone
                FROM charging_sessions cs
                JOIN sites s ON s.id = ${siteId}
                WHERE cs.id = ${sessionId}
              `;
              const timezone = (ctxRow?.['timezone'] as string | null) ?? undefined;
              const endedAtValue = ctxRow?.['ended_at'] as string | Date | null | undefined;
              const ratedAt = endedAtValue != null ? new Date(endedAtValue) : new Date();
              const rate = resolveElectricityRate(periods, ratedAt, timezone);
              const sessionEnergyWh = Number(sessionRow.energy_delivered_wh ?? 0);
              if (rate != null && sessionEnergyWh > 0) {
                const electricityCostCents = calculateElectricityCostCents(
                  sessionEnergyWh,
                  rate.ratePerKwh,
                );
                await sql`
                  UPDATE charging_sessions
                  SET electricity_cost_cents = ${electricityCostCents}, updated_at = now()
                  WHERE id = ${sessionId} AND electricity_cost_cents IS NULL
                `;
              }
            }
          } catch (electricityErr: unknown) {
            logger.warn({ err: electricityErr, sessionId }, 'electricity cost calculation failed');
          }
        }

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
          await notifyChange('reservation.changed', stationUuid, siteId, sessionId);
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
        } catch (err) {
          logger.debug({ err, sessionId }, 'Transaction-ended SSE publish failed; continuing');
        }

        // Driver notification: transaction completed (skip when the session
        // didn't actually complete successfully). The earlier hasPaymentFailure
        // check only covered Stripe-decline cases (a payment_records row with
        // status='failed') and missed the MissingPaymentMethod path, which
        // never inserts a payment record - so drivers who tapped without a PM
        // received a phantom "session is complete" + "session receipt" pair
        // alongside the correct payment-required notification.
        const endedDriverRows = await sql`
          SELECT driver_id, energy_delivered_wh, final_cost_cents, started_at, ended_at, status,
                 tariff_tax_rate, UPPER(currency) AS currency
          FROM charging_sessions WHERE id = ${sessionId}`;
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
          void eventBus.track(
            dispatchDriverNotification(
              sql,
              'session.Completed',
              endedSession.driver_id as string,
              {
                siteName: endedSiteName ?? '',
                stationId,
                transactionId,
                energyDeliveredWh: endedSession.energy_delivered_wh as number,
                finalCostCents: endedSession.final_cost_cents as number,
                costFormatted: notificationMoney(
                  (endedSession.final_cost_cents as number | null) ?? 0,
                  endedSession.currency as string,
                ),
                costIncludesTax: costIncludesTax(
                  endedSession.final_cost_cents as number | null,
                  endedSession.tariff_tax_rate as string | null,
                ),
                currency: endedSession.currency as string,
                durationMinutes,
                startedAt: endedSession.started_at as string,
                endedAt: endedSession.ended_at as string,
              },
              ALL_TEMPLATES_DIRS,
              pubsub,
            ),
          );

          // Session receipt notification
          void eventBus.track(
            dispatchDriverNotification(
              sql,
              'session.Receipt',
              endedSession.driver_id as string,
              {
                siteName: endedSiteName ?? '',
                stationId,
                transactionId,
                energyDeliveredWh: endedSession.energy_delivered_wh as number,
                finalCostCents: endedSession.final_cost_cents as number,
                costFormatted: notificationMoney(
                  (endedSession.final_cost_cents as number | null) ?? 0,
                  endedSession.currency as string,
                ),
                costIncludesTax: costIncludesTax(
                  endedSession.final_cost_cents as number | null,
                  endedSession.tariff_tax_rate as string | null,
                ),
                currency: endedSession.currency as string,
                durationMinutes,
                startedAt: endedSession.started_at as string,
                endedAt: endedSession.ended_at as string,
              },
              ALL_TEMPLATES_DIRS,
              pubsub,
            ),
          );
        }

        // The station does not know a session the CSMS ended (superseded or
        // ghost), and may be in a new transaction: its screen is left alone.
        if (event.eventType !== SESSION_ENDED_BY_CSMS) {
          await publishTransactionScreen(sessionRow.id as string, 'ended', null);
        }

        // Free the per-session CostUpdated throttle entry now that the
        // session is over. Without this the Map grows unbounded over the
        // process lifetime.
        lastCostUpdatedAt.delete(sessionRow.id as string);
      } else {
        txBuffer.add(stationId, transactionId, event);
      }
    }
  }

  safeSubscribe('ocpp.TransactionEvent', projectTransactionEvent);

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

    const reportedEvseUuid = await resolveEvseUuid(stationUuid, ocppEvseId);
    // Link meter values to a session when they came from a TransactionEvent or
    // when the MeterValues message includes a transactionId (OCPP 1.6 always does this).
    const isTransactionScoped = source === 'TransactionEvent' || transactionId != null;
    const session = isTransactionScoped
      ? await resolveMeterValueSession(stationUuid, reportedEvseUuid, transactionId)
      : null;
    const sessionId = session?.id ?? null;

    if (sessionId == null && transactionId != null && isTransactionScoped) {
      txBuffer.add(stationId, transactionId, event);
      return;
    }

    // A 2.1 station names the EVSE only in the first TransactionEvent, so take it
    // from the session.
    const evseUuid = session?.evseUuid ?? reportedEvseUuid;
    // Session updates below target the matched session only, so a late reading
    // for an ended session never lands on a newer session on the same EVSE.
    // Without a match, a reading on a known EVSE updates that EVSE's active
    // session. A station-wide reading (EVSE 0, 1.6 connector 0, or a 2.1
    // event without an EVSE) belongs to no session and is only stored.
    const appliesToSession = sessionId != null || evseUuid != null;

    const meterValues = payload.meterValues as Array<Record<string, unknown>> | undefined;
    if (meterValues == null) return;

    for (const mv of meterValues) {
      const mvTimestamp = mv.timestamp as string;
      const sampledValues = mv.sampledValue as Array<Record<string, unknown>> | undefined;
      if (sampledValues == null) continue;
      const energySamples: PhaseSample[] = [];
      const powerSamples: PhaseSample[] = [];

      for (const sv of sampledValues) {
        const measurand = getString(sv, 'measurand') ?? DEFAULT_MEASURAND;
        // 2.1: sv.unitOfMeasure.unit, 1.6: sv.unit
        const unitOfMeasure = sv.unitOfMeasure as Record<string, unknown> | undefined;
        const unit =
          unitOfMeasure != null ? getString(unitOfMeasure, 'unit') : getString(sv, 'unit');
        // 2.1 only. Stored values carry the multiplier applied, so every reader of
        // meter_values sees the value in `unit` without knowing the multiplier.
        const multiplier =
          typeof unitOfMeasure?.multiplier === 'number' ? unitOfMeasure.multiplier : 0;
        const value = applyMultiplier(Number(sv.value), multiplier);
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
            ${value},
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
              ${value},
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

        // Session energy and idle state use the overall Outlet value of each
        // MeterValue, collected here and applied once after the loop, so
        // per-phase or Inlet samples never overwrite them.
        if ((location ?? DEFAULT_LOCATION) === DEFAULT_LOCATION) {
          if (measurand === DEFAULT_MEASURAND) {
            // Session energy and meter_start are in Wh; a kWh register is converted.
            const wh = energyToWh(value, unit);
            if (wh == null) {
              logger.warn(
                { stationId, unit, value: sv.value },
                'Energy register reading with an unsupported unit; session energy not updated',
              );
            } else {
              energySamples.push({ value: wh, phase });
            }
          } else if (measurand === 'Power.Active.Import') {
            powerSamples.push({ value, phase });
          }
        }
      }

      // Update energy_delivered_wh on the session when we get an energy reading.
      // Energy registers are cumulative, so we compute: currentValue - meterStart.
      // If meterStart is not yet set (OCPP 2.1 sessions), capture the first reading as meterStart.
      // Transaction-scoped readings (TransactionEvent, 1.6 MeterValues with transactionId)
      // update their own session while it is active. Standalone 2.1 MeterValues on an
      // EVSE update the active session on that EVSE.
      const meterValue = overallValue(energySamples);
      if (appliesToSession && meterValue != null) {
        // Capture previous energy and meter_start for flat-reading idle detection
        const prevRows = await sql`
          SELECT energy_delivered_wh, meter_start FROM charging_sessions
          WHERE station_id = ${stationUuid} AND status = 'active'
            AND (id = ${sessionId} OR (${sessionId}::text IS NULL AND evse_id = ${evseUuid}))
        `;
        const prevEnergyWh = Number(prevRows[0]?.energy_delivered_wh ?? -1);
        const existingMeterStart = prevRows[0]?.meter_start as string | null | undefined;

        // Set meter_start from the first energy reading if not already set (OCPP 2.1 path)
        await sql`
          UPDATE charging_sessions
          SET meter_start = ${Math.round(meterValue)}, updated_at = now()
          WHERE station_id = ${stationUuid} AND status = 'active'
            AND (id = ${sessionId} OR (${sessionId}::text IS NULL AND evse_id = ${evseUuid}))
            AND meter_start IS NULL
        `;
        // Compute energy as delta: currentReading - meterStart (clamp to 0 if meter resets).
        // The cast is required: untyped, Postgres infers integer from meter_start and rejects decimals.
        await sql`
          UPDATE charging_sessions
          SET energy_delivered_wh = GREATEST(0, ${meterValue}::numeric - meter_start), updated_at = now()
          WHERE station_id = ${stationUuid} AND status = 'active'
            AND (id = ${sessionId} OR (${sessionId}::text IS NULL AND evse_id = ${evseUuid}))
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
                AND (id = ${sessionId} OR (${sessionId}::text IS NULL AND evse_id = ${evseUuid}))
            `;
          } else {
            // Energy increased: accumulate idle time and clear idle_started_at,
            // unless a station signal confirmed this idle period (see below).
            await sql`
              UPDATE charging_sessions
              SET idle_minutes = idle_minutes + EXTRACT(EPOCH FROM (${mvTimestamp}::timestamptz - idle_started_at)) / 60,
                  idle_started_at = NULL,
                  updated_at = now()
              WHERE station_id = ${stationUuid} AND status = 'active' AND idle_started_at IS NOT NULL
                AND idle_notified_at IS DISTINCT FROM idle_started_at
                AND (id = ${sessionId} OR (${sessionId}::text IS NULL AND evse_id = ${evseUuid}))
            `;
          }
        }
      }

      // Power-based idle detection (fallback for OCPP 1.6 and stations without chargingState)
      // Only transaction-scoped readings should update session idle state.
      const powerValue = overallValue(powerSamples);
      if (appliesToSession && isTransactionScoped && powerValue != null) {
        if (powerValue === 0) {
          // No power flowing: mark idle start if not already set
          await sql`
            UPDATE charging_sessions
            SET idle_started_at = ${mvTimestamp}, updated_at = now()
            WHERE station_id = ${stationUuid} AND status = 'active' AND idle_started_at IS NULL
              AND (id = ${sessionId} OR (${sessionId}::text IS NULL AND evse_id = ${evseUuid}))
          `;
        } else {
          // Power resumed: accumulate idle time and clear idle_started_at.
          // The meter fallbacks only end an idle period they started: once the
          // station itself reported it (2.1 chargingState, 1.6 SuspendedEV
          // status), dispatchIdlingNotification claimed it (idle_notified_at =
          // idle_started_at), and only the station's own Charging ends it. A
          // reading carried by the same TransactionEvent as a SuspendedEVSE would
          // otherwise end the period and the next event would open a second one
          // with a second notification.
          await sql`
            UPDATE charging_sessions
            SET idle_minutes = idle_minutes + EXTRACT(EPOCH FROM (${mvTimestamp}::timestamptz - idle_started_at)) / 60,
                idle_started_at = NULL,
                updated_at = now()
            WHERE station_id = ${stationUuid} AND status = 'active' AND idle_started_at IS NOT NULL
              AND idle_notified_at IS DISTINCT FROM idle_started_at
              AND (id = ${sessionId} OR (${sessionId}::text IS NULL AND evse_id = ${evseUuid}))
          `;
        }
      }
    }

    // Notify for all MeterValues (both standalone and transaction-scoped).
    // Cost recalculation and session updates follow below when active sessions exist.

    // Update the running cost of active sessions for this station from their
    // price snapshots. JOIN to charging_stations so the CostUpdated dispatch
    // path below has the transactionId and ocpp_protocol without a second SQL
    // round-trip per cost-change event.
    const activeSessions = appliesToSession
      ? await sql`
          SELECT cs.id, cs.transaction_id, cs.tariff_id, cs.driver_id,
                 cs.energy_delivered_wh, cs.current_cost_cents, cs.cost_ceiling_cents,
                 cs.idle_started_at, cs.idle_minutes, st.ocpp_protocol,
                 dt.prepaid_balance_cents
          FROM charging_sessions cs
          JOIN charging_stations st ON st.id = cs.station_id
          LEFT JOIN driver_tokens dt ON dt.id = cs.token_id
          WHERE cs.station_id = ${stationUuid} AND cs.status = 'active' AND cs.tariff_id IS NOT NULL
            AND (cs.id = ${sessionId} OR (${sessionId}::text IS NULL AND cs.evse_id = ${evseUuid}))
        `
      : [];

    const splitBillingEnabled = await isSplitBillingEnabled();
    for (const session of activeSessions) {
      const sessionId = session.id as string;
      const now = new Date();
      const energyWh = Number(session.energy_delivered_wh ?? 0);

      // Split billing: when the tariff that applies now differs from the one
      // of the open segment, close that segment and open one priced from the
      // new tariff. The session keeps the tariff snapshot it started with.
      // The session's energy so far selects an energy-threshold tariff once
      // the threshold is crossed.
      if (splitBillingEnabled) {
        const currentTariff = await resolveStationTariff(
          {
            stationUuid,
            driverUuid: session.driver_id as string | null,
            at: now,
            sessionEnergyKwh: energyWh / 1000,
          },
          sql,
        );
        const openTariffId =
          (await openSegmentTariffId(sql, sessionId)) ?? (session.tariff_id as string);
        if (currentTariff != null && currentTariff.id !== openTariffId) {
          await switchTariffSegment(sql, {
            sessionId,
            tariff: currentTariff,
            at: now,
            energyWh,
            sessionIdleMinutes: sessionIdleMinutesAt(
              {
                idleStartedAt:
                  session.idle_started_at != null
                    ? new Date(session.idle_started_at as string)
                    : null,
                idleMinutes: Number(session.idle_minutes ?? 0),
              },
              now,
            ),
          });
        }
      }

      // The running cost, from the one cost assembly the final cost uses
      // (segments, idle grace, and the reservation holding fee).
      const breakdown = await priceSessionAt(sql, sessionId, now, energyWh);
      if (breakdown == null) continue;
      const totalCents = breakdown.grossCents;
      const previousCostCents = session.current_cost_cents as number | null;

      if (!(await storeRunningCost(sql, sessionId, breakdown))) continue;

      // The TransactionEvent projection renders the screen before this cost is
      // stored, so render it again with the new energy and cost.
      if (previousCostCents !== totalCents) {
        await publishStationMessageTransaction(
          { stationUuid, stationId, protocol: session.ocpp_protocol as string | null },
          sessionId,
          'updated',
          null,
        );
      }

      // Prepaid token on OCPP 1.6: the station gets no transactionLimit, so the
      // CSMS stops the transaction once the running cost reaches the credit.
      // OCPP 2.1 stations enforce transactionLimit.maxCost themselves (C17).
      const prepaidBalance = session.prepaid_balance_cents as number | null | undefined;
      const prepaidTxId = session.transaction_id as string | null;
      if (
        session.ocpp_protocol === 'ocpp1.6' &&
        prepaidBalance != null &&
        prepaidTxId != null &&
        totalCents >= prepaidBalance
      ) {
        logger.info(
          { sessionId, totalCents, prepaidBalanceCents: prepaidBalance },
          'Prepaid credit used up, stopping the OCPP 1.6 transaction',
        );
        await stopSessionForPayment(
          {
            sessionId,
            transactionId: prepaidTxId,
            ocppStationId: stationId,
            stationDbId: stationUuid,
          },
          'PrepaidCreditExhausted',
        );
      }

      // Guest card hold: the authorization is the ceiling for the cost (C25),
      // and the cost assembly bills at most cost_ceiling_cents, so energy past
      // it is not paid for. OCPP 1.6 has no transaction limit: the CSMS stops
      // the transaction once the cost reaches the hold. An OCPP 2.1 station got
      // the hold as transactionLimit.maxCost and suspends itself (E16.FR.05),
      // keeping the transaction open until the driver unplugs; the CSMS stops
      // it only when a later reading finds the hold already reached and the
      // station never reported CostLimitReached (it ignores the limit, P11).
      const ceilingCents = session.cost_ceiling_cents as number | null;
      if (ceilingCents != null && prepaidTxId != null && totalCents >= ceilingCents) {
        const stopNow =
          session.ocpp_protocol === 'ocpp1.6' ||
          (previousCostCents != null &&
            previousCostCents >= ceilingCents &&
            !(await costLimitReported(sessionId)));
        if (stopNow) {
          logger.info(
            {
              sessionId,
              ceilingCents,
              pricedCents: breakdown.pricedGrossCents ?? totalCents,
              protocol: session.ocpp_protocol as string | null,
            },
            'Guest hold reached, stopping the transaction',
          );
          await stopSessionForPayment(
            {
              sessionId,
              transactionId: prepaidTxId,
              ocppStationId: stationId,
              stationDbId: stationUuid,
            },
            'GuestHoldExhausted',
          );
        }
      }

      // Send CostUpdated to station when cost changes (OCPP 2.1 only).
      // Throttled per session via lastCostUpdatedAt to keep dispatch volume
      // bounded under high MeterValues cadence.
      if (previousCostCents !== totalCents) {
        const nowMs = now.getTime();
        const lastSentAt = lastCostUpdatedAt.get(sessionId) ?? 0;
        if (nowMs - lastSentAt >= COST_UPDATED_THROTTLE_MS) {
          const txId = session.transaction_id as string | null;
          const protocol = session.ocpp_protocol as string | null;
          if (txId != null && protocol === 'ocpp2.1') {
            try {
              await publishOcppCommand(pubsub, {
                stationId,
                action: 'CostUpdated',
                payload: {
                  totalCost: totalCents / 100,
                  transactionId: txId,
                },
              });
              lastCostUpdatedAt.set(sessionId, nowMs);
            } catch (err) {
              logger.debug(
                { err, sessionId },
                'CostUpdated command publish failed; continuing meter processing',
              );
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

    // A firmware install takes the station out of service while it runs and
    // faults it when it fails, until the next install or an operator enable.
    // Idle and DownloadFailed mean no install is running, so they end one that
    // never reported its outcome but keep a failed one.
    let fwChange: { availabilityChanged: boolean } | null = null;
    if (status === 'Installing') {
      fwChange = await setStationFirmwareState(sql, stationUuid, 'installing');
    } else if (
      status === 'InstallationFailed' ||
      status === 'InvalidSignature' ||
      status === 'InstallVerificationFailed'
    ) {
      fwChange = await setStationFirmwareState(sql, stationUuid, 'failed');
    } else if (status === 'Installed') {
      fwChange = await setStationFirmwareState(sql, stationUuid, null);
    } else if (status === 'Idle' || status === 'DownloadFailed') {
      fwChange = await clearStationFirmwareInstalling(sql, stationUuid);
    }
    if (fwChange?.availabilityChanged === true) {
      await notifyChange('station.status', stationUuid, await resolveSiteId(stationUuid));
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
        const [prior] = await sql`
          SELECT availability, disabled_reason FROM charging_stations WHERE id = ${stationUuid}
        `;
        const priorAvailability =
          prior != null && prior.disabled_reason == null
            ? (prior.availability as string)
            : undefined;
        if (priorAvailability != null) {
          const disableChange = await setStationDisabled(sql, stationUuid, 'security');
          if (disableChange.availabilityChanged) {
            await notifyChange('station.status', stationUuid, await resolveSiteId(stationUuid));
          }
          // Tell the station too, as an operator disable does. No version: the
          // command listener translates it for 1.6 (ChangeAvailability on
          // connector 0). Fail-open: the disable is already stored.
          try {
            await publishOcppCommand(pubsub, {
              stationId: event.aggregateId,
              action: 'ChangeAvailability',
              payload: { operationalStatus: 'Inoperative' },
            });
          } catch (err) {
            logger.warn({ err, stationUuid }, 'ChangeAvailability after security disable failed');
          }
        }
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
        await notifyChange('reservation.changed', null, null);
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
        await notifyChange('reservation.changed', stationUuid, null);
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
      SELECT cs.id, cs.driver_id, cs.station_id, UPPER(cs.currency) AS currency
      FROM charging_sessions cs
      JOIN charging_stations st ON st.id = cs.station_id
      WHERE st.station_id = ${event.aggregateId} AND cs.transaction_id = ${transactionId}
    `;
    const session = sessionRows[0];
    if (session == null) return;

    // Convert settlement amount to cents (OCPP sends in major currency units)
    const capturedAmountCents = Math.round(settlementAmount * 100);

    const recorded = await recordTerminalSettlement({
      sessionId: session.id as string,
      driverId: (session.driver_id as string | null) ?? null,
      currency: session.currency as string,
      capturedCents: capturedAmountCents,
    });

    if (!recorded) {
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
      void eventBus.track(
        dispatchDriverNotification(
          sql,
          'session.PaymentReceived',
          session.driver_id as string,
          {
            siteName: settleSiteName ?? '',
            stationId: event.aggregateId,
            transactionId,
            amountCents: capturedAmountCents,
            amountFormatted: notificationMoney(capturedAmountCents, session.currency as string),
            currency: session.currency as string,
          },
          ALL_TEMPLATES_DIRS,
          pubsub,
        ),
      );

      // Driver notification: payment complete
      void eventBus.track(
        dispatchDriverNotification(
          sql,
          'payment.Complete',
          session.driver_id as string,
          {
            stationId: event.aggregateId,
            transactionId,
            amountCents: capturedAmountCents,
            amountFormatted: notificationMoney(capturedAmountCents, session.currency as string),
            currency: session.currency as string,
          },
          ALL_TEMPLATES_DIRS,
          pubsub,
        ),
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
    /** Balance of the session's prepaid token; null when the token is not prepaid. */
    prepaidBalanceCents: number | null;
    /** True when the session started from a reservation (its holding fee is billed). */
    reserved: boolean;
    /** The tariff snapshotted on the session at Started (null: no tariff applies). */
    sessionTariff: TariffPriceSnapshot | null;
  }

  interface StopTarget {
    sessionId: string;
    transactionId: string;
    ocppStationId: string;
    stationDbId: string;
  }

  type PaymentStopReason =
    | 'PaymentFailed'
    | 'MissingPaymentMethod'
    | 'GuestPaymentNotAuthorized'
    | 'AnonymousSession'
    | 'PrepaidCreditExhausted'
    | 'GuestHoldExhausted';

  /** True when the station reported reaching the cost limit of the session (E16.FR.05). */
  async function costLimitReported(sessionId: string): Promise<boolean> {
    const rows = await sql`
      SELECT 1 FROM transaction_events
      WHERE session_id = ${sessionId} AND trigger_reason = 'CostLimitReached'
      LIMIT 1
    `;
    return rows.length > 0;
  }

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
   *
   * PrepaidCreditExhausted and GuestHoldExhausted record stopped_reason
   * first and publish only when they claimed the session, so repeated
   * MeterValues send one stop.
   */
  async function stopSessionForPayment(
    target: StopTarget,
    reason: PaymentStopReason,
  ): Promise<void> {
    const { sessionId, transactionId, ocppStationId, stationDbId } = target;

    // A prepaid session out of credit (OCPP 1.6 has no transactionLimit) or a
    // guest session at its hold: mark the stop request on the session before
    // publishing, once. The session stays active until the station ends the
    // transaction, which keeps this stopped_reason (COALESCE) and settles.
    if (reason === 'PrepaidCreditExhausted' || reason === 'GuestHoldExhausted') {
      try {
        const claimed = await sql`
          UPDATE charging_sessions
          SET stopped_reason = ${reason}, updated_at = now()
          WHERE id = ${sessionId} AND status = 'active' AND stopped_reason IS NULL
          RETURNING id
        `;
        if (claimed.length === 0) return;
      } catch (err) {
        logger.error({ err, sessionId }, 'Failed to record the payment stop of the session');
        return;
      }
    }

    try {
      await publishOcppCommand(pubsub, {
        stationId: ocppStationId,
        action: 'RequestStopTransaction',
        payload: { transactionId },
      });
    } catch (err) {
      logger.error({ err }, 'Failed to publish RequestStopTransaction');
    }

    // Push a one-shot driver-facing message to the station screen so the
    // physical UX matches the email/SMS notification fan-out. The template
    // body is operator-editable in Settings -> Integration -> Station
    // Messages, rendered with the standard StationMessageContext, and
    // dispatched via dispatchOneShotStationMessage so any future
    // event-driven station message can reuse the same path.
    const stateByReason: Record<PaymentStopReason, StationMessageState | null> = {
      PaymentFailed: 'payment_failed',
      MissingPaymentMethod: 'payment_required',
      GuestPaymentNotAuthorized: 'guest_unauthorized',
      AnonymousSession: 'unauthorized',
      // No station message template exists for an exhausted prepaid credit
      // or guest hold.
      PrepaidCreditExhausted: null,
      GuestHoldExhausted: null,
    };
    const messageState = stateByReason[reason];
    if (messageState != null) {
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
            state: messageState,
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
    }

    const eagerCleanup = reason === 'PaymentFailed' || reason === 'MissingPaymentMethod';
    if (!eagerCleanup) return;

    try {
      // Zero out cost columns: the driver never authorized payment so we
      // must not display or persist a session-fee charge. Without this,
      // the cost calc on the Ended event (or MeterValues if a stray one
      // arrives) applies pricePerSession + tax and the portal Recent
      // Sessions list shows a phantom $0.81 next to a 0 kWh row.
      const faulted = await faultUnbilledSession(sql, {
        sessionId,
        reason,
        endedAt: new Date(),
      });
      await sql`
        UPDATE session_tariff_segments
        SET ended_at = now(),
            duration_minutes = EXTRACT(EPOCH FROM (now() - started_at)) / 60
        WHERE session_id = ${sessionId} AND ended_at IS NULL
      `;
      if (faulted) {
        await auditLinkedReservationFault(sessionId, `faulted: ${reason}`);
      }
    } catch (err) {
      logger.error({ err, sessionId, reason }, 'Failed to mark session faulted');
    }
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
      prepaidBalanceCents,
      reserved,
      sessionTariff,
    } = params;

    // The session is billed at the tariff snapshotted on Started, so the gate
    // decides from that same tariff (no tariff: free). The reservation holding
    // fee makes the session paid only when it started from a reservation.
    const tariffIsFree = isTariffFree(sessionTariff, { reserved });

    // How the session is paid (one definition with the settlement on Ended).
    // Free vend never reaches the gate (the Started handler skips it).
    const mode = classifySessionPayment({
      isRoaming,
      freeVend: false,
      prepaid: prepaidBalanceCents != null,
      driverId,
      guestSession: guestStatus != null,
    });

    // Roaming: billing handled by the eMSP via the CDR.
    if (mode === 'roaming' || mode === 'free_vend') return;

    const stopSession = (reason: PaymentStopReason): Promise<void> =>
      stopSessionForPayment({ sessionId, transactionId, ocppStationId, stationDbId }, reason);

    async function notifyPreAuthFailed(driver: string, reason: string): Promise<void> {
      try {
        void eventBus.track(
          dispatchDriverNotification(
            sql,
            'payment.PreAuthFailed',
            driver,
            {
              stationId: ocppStationId,
              transactionId,
              reason: reason.slice(0, 200),
            },
            ALL_TEMPLATES_DIRS,
            pubsub,
          ),
        );
      } catch (err) {
        logger.debug(
          { err, driverId: driver, sessionId },
          'PreAuthFailed notification dispatch failed; continuing',
        );
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
      } catch (err) {
        logger.debug({ err, sessionId }, 'PreAuthFailed SSE publish failed; continuing');
      }
    }

    async function notifyMissingPaymentMethod(driver: string): Promise<void> {
      try {
        void eventBus.track(
          dispatchDriverNotification(
            sql,
            'payment.MissingPaymentMethod',
            driver,
            {
              stationId: ocppStationId,
              transactionId,
            },
            ALL_TEMPLATES_DIRS,
            pubsub,
          ),
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
      } catch (err) {
        logger.debug({ err, sessionId }, 'MissingPaymentMethod SSE publish failed; continuing');
      }
    }

    // Prepaid token (OCPP 2.1 C17): the station enforces the remaining credit
    // (transactionLimit.maxCost) and the settlement debits the final cost when
    // the session ends, so no card pre-authorization. A prepaid token without
    // credit is stopped (a station started it without asking first).
    if (mode === 'prepaid') {
      if (prepaidBalanceCents != null && prepaidBalanceCents > 0) return;
      logger.warn(`Prepaid token without credit started session ${transactionId}, stopping`);
      await stopSession('PaymentFailed');
      return;
    }

    if (mode === 'card' && driverId != null) {
      // ---- Driver session ----
      // A free session needs no payment method and no hold.
      if (tariffIsFree) return;

      // The hold on the driver's default card, through the provider the card
      // is saved with (key preauth_<sessionId>, shared with the portal start:
      // an existing record means the portal start already placed it).
      const hold = await authorizeSessionHold(
        { sessionId, driverId, methodRowId: null, siteId, trigger: 'projection_gate' },
        paymentContext(logger),
      );
      switch (hold.outcome) {
        case 'authorized':
        case 'exists':
          return;
        case 'no_method':
          logger.warn(
            `Driver ${driverId} has no payment method for non-free session ${transactionId}, stopping`,
          );
          await stopSession('MissingPaymentMethod');
          await notifyMissingPaymentMethod(driverId);
          return;
        case 'not_configured':
          // As the portal start without a provider: the session is not held.
          logger.warn(
            { sessionId, providerId: hold.providerId },
            'Payment provider not configured; session not pre-authorized',
          );
          return;
        case 'declined':
          logger.error(
            { sessionId, reason: hold.reason },
            'Auto pre-auth failed, stopping session',
          );
          await stopSession('PaymentFailed');
          await notifyPreAuthFailed(driverId, hold.reason);
          return;
        case 'record_failed':
          // The service cancelled the hold it could not record.
          await stopSession('PaymentFailed');
          await notifyPreAuthFailed(driverId, 'Payment recording failed. Please contact support.');
          return;
      }
    }

    // ---- Guest or anonymous session ----
    // Token resolution already happened in the first subscriber:
    //   driver_tokens -> ocpi_external_tokens -> guest_sessions
    // guestStatus/guestEmail are pre-resolved from that chain.
    if (mode === 'guest') {
      if (guestStatus === 'payment_authorized') {
        // Valid guest session -- pre-auth done at checkout, allow
        return;
      }

      // Guest session exists but not authorized
      logger.warn(
        `No valid guest session for idToken ${String(idToken).slice(0, 8)}..., stopping session ${transactionId}`,
      );
      await stopSession('GuestPaymentNotAuthorized');
      if (guestEmail != null) {
        try {
          void eventBus.track(
            dispatchSystemNotification(
              sql,
              'payment.PreAuthFailed',
              { email: guestEmail },
              {
                stationId: ocppStationId,
                transactionId,
                reason: 'Payment authorization not found',
              },
              ALL_TEMPLATES_DIRS,
            ),
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

  // Payment auto-capture on session end (separate subscriber, no race with session creation)
  async function settleTransactionEnded(event: DomainEvent): Promise<void> {
    const payload = event.payload;
    const eventType = payload.eventType as string;
    const transactionId = payload.transactionId as string;
    const stationId = payload.stationId as string;

    if (eventType === 'Ended') {
      // Settlement on session end
      const sessionRows = await sql`
        SELECT cs.id, cs.final_cost_cents, cs.station_id AS station_uuid,
               UPPER(cs.currency) AS currency,
               cs2.station_id AS station_ocpp_id, cs2.site_id
        FROM charging_sessions cs
        JOIN charging_stations cs2 ON cs2.id = cs.station_id
        WHERE cs2.station_id = ${stationId} AND cs.transaction_id = ${transactionId}
      `;
      const session = sessionRows[0];
      if (session == null) return;

      // Prepaid debit, or capture/cancel of the driver's hold, through the
      // provider the payment is pinned to. Guest holds are left to the
      // guest-session worker. Idempotent: the record moves only from its
      // open state, and the provider calls carry keys derived from it.
      const outcome = await settleSessionPayment(session.id as string, paymentContext(logger));
      const sessionCurrency = session.currency as string;
      const finalCostCents = session.final_cost_cents as number | null;

      if (outcome.mode === 'prepaid') {
        logger.info(
          {
            sessionId: session.id,
            tokenId: outcome.tokenId,
            debitedCents: outcome.debitedCents,
          },
          'Prepaid balance debited',
        );
        await notifyChange(
          'payment.settled',
          session.station_uuid as string,
          (session.site_id as string | null) ?? null,
          session.id as string,
        );
        try {
          await pubsub.publish(
            'csms_events',
            JSON.stringify({ eventType: 'token.changed', tokenId: outcome.tokenId }),
          );
        } catch (err) {
          logger.debug({ err }, 'token.changed SSE publish failed; continuing');
        }
        return;
      }
      if (outcome.mode !== 'card') return;

      if (outcome.status === 'failed') {
        try {
          void eventBus.track(
            dispatchDriverNotification(
              sql,
              'payment.CaptureFailed',
              outcome.driverId,
              {
                stationId: event.aggregateId,
                transactionId,
                amountFormatted: notificationMoney(finalCostCents ?? 0, sessionCurrency),
                reason: outcome.reason.slice(0, 200),
              },
              ALL_TEMPLATES_DIRS,
              pubsub,
            ),
          );
        } catch (err) {
          logger.debug(
            { err, driverId: outcome.driverId, transactionId },
            'CaptureFailed notification dispatch failed; continuing',
          );
        }
        return;
      }

      // Notify on capture only when it was recorded (a capture whose record
      // update failed is logged for manual reconciliation instead).
      if (outcome.status === 'captured' && outcome.recorded) {
        const stationUuid = session.station_uuid as string | null;
        const captureSiteName = stationUuid != null ? await resolveSiteName(stationUuid) : null;
        void eventBus.track(
          dispatchDriverNotification(
            sql,
            'session.PaymentReceived',
            outcome.driverId,
            {
              siteName: captureSiteName ?? '',
              stationId: session.station_ocpp_id as string,
              transactionId,
              amountCents: outcome.capturedCents,
              amountFormatted: notificationMoney(outcome.capturedCents, sessionCurrency),
              currency: sessionCurrency,
            },
            ALL_TEMPLATES_DIRS,
            pubsub,
          ),
        );
      }
    }
  }

  safeSubscribe('ocpp.TransactionEvent', settleTransactionEnded);

  // A session the CSMS ends because the station will not (superseded on its
  // EVSE, or unknown to the station): the normal end, then the settlement, in
  // one queued step. A session faulted or failed meanwhile is left alone (P5).
  safeSubscribe(SESSION_ENDED_BY_CSMS, async (event: DomainEvent) => {
    const stationId = event.payload.stationId as string;
    const transactionId = event.payload.transactionId as string;
    // Transaction ids are unique per station only (N4).
    const [row] = await sql`
      SELECT cs.status FROM charging_sessions cs
      JOIN charging_stations st ON st.id = cs.station_id
      WHERE st.station_id = ${stationId} AND cs.transaction_id = ${transactionId}
    `;
    if (row?.status !== 'active') return;
    await projectTransactionEvent(event);
    await settleTransactionEnded(event);
  });

  // ---- OCPP Message Logging ----

  // Retried on a lost connection: the log INSERT runs once per event, and the
  // liveness UPDATE is idempotent with its first result (was the station
  // offline) kept for the notifications.
  safeSubscribe(
    'ocpp.MessageLog',
    async (event: DomainEvent, attempt: ProjectionAttempt) => {
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
      const loggedStationUuid = stationUuid;

      const inserted = await attempt.once(
        'message-log',
        () => sql`
          INSERT INTO ocpp_message_logs (station_id, direction, message_type, message_id, action, payload, error_code, error_description)
          SELECT ${loggedStationUuid}, ${direction}, ${messageType}, ${messageId}, ${action}, ${sql.json(asJson(messagePayload ?? {}))}, ${errorCode}, ${errorDescription}
          WHERE EXISTS (SELECT 1 FROM charging_stations WHERE id = ${loggedStationUuid})
        `,
      );
      if (inserted.count === 0) {
        invalidateStationCache(stationId);
        return;
      }

      // Any inbound message proves liveness (OCPP 2.1 G02.FR.04, OCPP 1.6 §4.6), so it
      // bumps last_heartbeat and marks online a station a late disconnect marked offline.
      let cameOnline = false;
      if (direction === 'inbound') {
        const [row] = await attempt.memo(
          'liveness',
          () => sql`
            WITH prev AS (SELECT is_online FROM charging_stations WHERE id = ${loggedStationUuid})
            UPDATE charging_stations
            SET last_heartbeat = now(), is_online = true
            WHERE id = ${loggedStationUuid}
            RETURNING (SELECT is_online FROM prev) AS was_online
          `,
        );
        cameOnline = row?.was_online === false;
      }

      const siteId = await resolveSiteId(stationUuid);
      if (cameOnline) {
        logger.info({ stationId }, 'Station marked online again by an inbound message');
        await notifyChange('station.status', stationUuid, siteId);
        if (siteId != null) {
          await notifyOcpiPush('location', { siteId });
        }
      }
      await notifyChange('ocpp.message', stationUuid, siteId);
    },
    { retryOnConnectionError: true },
  );

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
      // A status taken from a NotifyEvent already notifies as ocpp.NotifyEvent.
      if (event.payload.source === 'NotifyEvent') return;
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
        } catch (err) {
          logger.debug(
            { err, stationUuid, componentName, variableName },
            'Event alert rule evaluation failed; continuing event persistence',
          );
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

        await upsertStationConfiguration(sql, {
          stationUuid,
          component: componentName,
          componentInstance,
          evseId,
          connectorId,
          variable: variableName,
          variableInstance,
          value,
          attributeType: attrType,
          source: 'NotifyReport',
        });

        // Spec-defined path for learning a connector's plug shape: the
        // Connector component reports a ConnectorType variable. OCPP 2.1
        // ConnectorType enum values are prefixed (cCCS2, cType2, etc.); map
        // the common ones to the canonical UI labels and keep vendor
        // strings as-is so the operator can still distinguish them.
        //
        // The UPDATE is guarded on `connector_type = 'Unknown'` so we never
        // clobber an operator-picked value on subsequent boots. Once the
        // operator edits the connector to a concrete type (or accepts an
        // earlier auto-fill), later reboots no longer touch it.
        if (
          attrType === 'Actual' &&
          value != null &&
          componentName === 'Connector' &&
          variableName === 'ConnectorType' &&
          evseId != null &&
          connectorId != null
        ) {
          const canonical = mapOcppConnectorType(value);
          await sql`
            UPDATE connectors
            SET connector_type = ${canonical}, updated_at = now()
            FROM evses
            WHERE connectors.evse_id = evses.id
              AND evses.station_id = ${stationUuid}
              AND evses.evse_id = ${evseId}
              AND connectors.connector_id = ${connectorId}
              AND connectors.connector_type = 'Unknown'
          `;
        }
      }

      // The EVSE's rated power is EVSE.Power variableCharacteristics.maxLimit
      // (required by the 2.1 device model; the Actual value is instantaneous
      // power). It fills an auto-created connector's empty max power so load
      // management can cap it, and never replaces an operator's value.
      if (componentName === 'EVSE' && variableName === 'Power' && evseId != null) {
        const characteristics = entry.variableCharacteristics as
          | Record<string, unknown>
          | undefined;
        const maxLimit = Number(characteristics?.maxLimit);
        if (Number.isFinite(maxLimit) && maxLimit > 0) {
          const maxKw = characteristics?.unit === 'kW' ? maxLimit : maxLimit / 1000;
          await sql`
            UPDATE connectors
            SET max_power_kw = ${String(maxKw)}, updated_at = now()
            FROM evses
            WHERE connectors.evse_id = evses.id
              AND evses.station_id = ${stationUuid}
              AND evses.evse_id = ${evseId}
              AND connectors.max_power_kw IS NULL
          `;
        }
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

      await upsertStationConfiguration(sql, {
        stationUuid,
        component: componentName,
        componentInstance,
        evseId,
        connectorId,
        variable: variableName,
        variableInstance,
        value,
        attributeType: attrType,
        source: 'GetVariables',
      });
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

      await upsertStationConfiguration(sql, {
        stationUuid,
        component: 'OCPP',
        componentInstance: null,
        evseId: null,
        connectorId: null,
        variable: key,
        variableInstance: null,
        value,
        attributeType: 'Actual',
        source: 'GetConfiguration',
      });
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
    const controlMode = (chargingNeeds.controlMode as string | undefined) ?? null;
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

    // A command for a station deleted meanwhile is dropped (the queue has an FK
    // to charging_stations.station_id and the commands could never be sent).
    await sql`
      INSERT INTO offline_command_queue (station_id, command_id, action, payload, version, expires_at)
      SELECT
        ${stationId}, ${commandId}, ${action},
        ${sql.json(asJson(cmdPayload))}, ${version},
        now() + ${String(ttlHours) + ' hours'}::interval
      WHERE EXISTS (SELECT 1 FROM charging_stations WHERE station_id = ${stationId})
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
    // gridEventFault is a string enum, and the jsonb serializer sends a string as
    // JSON text unchanged, so it is encoded first.
    const gridEventFaultJson =
      gridEventFault != null ? sql.json(asJson(JSON.stringify(gridEventFault))) : null;

    await sql`
      INSERT INTO der_alarm_events (station_id, control_type, timestamp, grid_event_fault)
      VALUES (${stationUuid}, ${controlType}, ${ts}, ${gridEventFaultJson})
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
    const tbc = (payload.tbc as boolean | undefined) ?? false;
    const derControl = payload.derControl ?? null;

    // ReportDERControlRequest has no seqNo (2.1 schema), so seq_no stays null.
    await sql`
      INSERT INTO der_control_reports (station_id, request_id, tbc, der_control)
      VALUES (${stationUuid}, ${requestId}, ${tbc}, ${derControl != null ? sql.json(asJson(derControl)) : null})
    `;
  });
}
