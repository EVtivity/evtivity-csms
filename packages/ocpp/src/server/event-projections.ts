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
  applyConnectorStatus,
  clearStationFirmwareInstalling,
  setStationDisabled,
  setStationFirmwareState,
  setStationReportedStatus,
  startStatusOrderingEpoch,
  resolveStationTariff,
  priceSessionAt,
  storeRunningCost,
  switchTariffSegment,
  applySessionEnergyReading,
  eventTimeAtMostNow,
  sendSessionTariffChange,
  pgConstraintName,
  pgErrorCode,
  PG_FOREIGN_KEY_VIOLATION,
  alertStationWatchersIfAvailable,
} from '@evtivity/database';
import { getSecuritySeverity } from '../lib/security-severity.js';
import { paymentContext } from '../lib/payments.js';
import { upsertStationConfiguration } from './station-configurations.js';
import { CACHE_MAX_SIZE } from './projection-support/ttl-cache.js';
import { createProjectionLookups } from './projection-support/lookups.js';
import { createProjectionNotifier } from './projection-support/notify.js';
import type { ProjectionDeps } from './projection-support/context.js';
import { trackRunningFleetCreditNotices } from './session-lifecycle/payment-gate.js';
import {
  ceilingStopReason,
  costLimitReported,
  stopSessionForPayment,
} from './session-lifecycle/payment-stop.js';
import { projectNotifySettlement, settleTransactionEnded } from './session-lifecycle/settlement.js';
import { CostUpdatedThrottle, FleetCreditThrottle } from './session-lifecycle/state.js';
import { growAccountCeiling } from './session-lifecycle/account-ceiling.js';
import {
  isFreeToPaidSwitch,
  runDuePaymentGate,
  runSegmentPaymentGate,
  sessionStartTariff,
} from './session-lifecycle/segment-payment-gate.js';
import type { SessionLifecycleState } from './session-lifecycle/state.js';
import { TransactionProjector } from './session-lifecycle/transaction-projector.js';
import { getString } from './projection-support/payload.js';
import { SESSION_ENDED_BY_CSMS } from './csms-session-end.js';
import {
  createLogger,
  FREE_VEND_OCPP_21_VARIABLES,
  FREE_VEND_OCPP_16_KEYS,
  LIVENESS_WRITE_INTERVAL_SECONDS,
} from '@evtivity/lib';
import { OCPP_NOTIFICATION_EVENT_TYPES, publishOcppCommand } from '@evtivity/lib';
import {
  dispatchOcppNotification,
  dispatchDriverNotification,
  ALL_TEMPLATES_DIRS,
} from './notification-dispatcher.js';
import { TransactionBuffer } from './transaction-buffer.js';
import { projectionLane, projectionQueueFor } from './projection-queue.js';
import { PROJECTION_RETRY_DEFAULTS, runProjectionWithRetry } from './projection-retry.js';
import type { ProjectionAttempt } from './projection-retry.js';
import { SERVER_SHUTDOWN_DISCONNECT_REASON } from './graceful-shutdown.js';
import {
  DEFAULT_LOCATION,
  DEFAULT_MEASURAND,
  applyMultiplier,
  energyToWh,
  isFlatEnergyReading,
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

  const lookups = createProjectionLookups(sql);
  const notify = createProjectionNotifier({ sql, eventBus, pubsub, logger });
  const deps: ProjectionDeps = {
    sql,
    eventBus,
    pubsub,
    logger,
    payments: paymentContext(logger),
    lookups,
    notify,
  };

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

  // CostUpdated dispatch throttle per session. Every MeterValues whose cost
  // changes (even by 1 cent) would otherwise publish a CostUpdated command,
  // producing ~6/min per active session. At 2000 sessions that is 12k
  // commands/min, drowning the pub/sub layer and the station&#39;s OCPP queue.
  // Cap to one dispatch per session per 30 seconds; the prior "no-change"
  // guard still skips when cost is identical, so we only throttle the
  // chatter, not real updates.
  const COST_UPDATED_THROTTLE_MS = 30_000;
  // Per-fleet credit work of meter readings (notice checks, extensions of a
  // fleet without credit): at most once a minute per fleet and process (P6).
  const FLEET_CREDIT_THROTTLE_MS = 60_000;

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
  // The session projection state: buffered out-of-order transaction events,
  // the projection queue, and the CostUpdated throttle (built in this order,
  // the buffer's cleanup timer before the queue's).
  const state: SessionLifecycleState = {
    txBuffer: new TransactionBuffer({ logger }),
    projectionQueue: projectionQueueFor(eventBus),
    costUpdated: new CostUpdatedThrottle(COST_UPDATED_THROTTLE_MS),
    fleetCredit: new FleetCreditThrottle(FLEET_CREDIT_THROTTLE_MS),
  };
  const projector = new TransactionProjector(deps, state);

  function enqueueForStation(id: string, work: () => Promise<void>): Promise<void> {
    return state.projectionQueue.enqueue(id, work);
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
    lookups.invalidateStationCache(stationOcppId);
    return true;
  }

  // Station-watch alert: the station may now be free for a watching driver
  // (a connector became available, the station came online, reported itself
  // available, finished a firmware install, or lost a reservation). The shared
  // driver availability rule decides, and the worker claim makes repeated
  // signals one alert. Fail-open: the state that triggered it is stored.
  async function checkStationWatches(stationUuid: string): Promise<void> {
    try {
      await alertStationWatchersIfAvailable(sql, pubsub, stationUuid);
    } catch (err) {
      logger.warn({ err, stationUuid }, 'Station-watch check failed');
    }
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
  ): Promise<{ id: string; evseUuid: string | null; transactionId: string | null } | null> {
    const rows =
      transactionId != null
        ? await sql`
            SELECT id, evse_id, transaction_id FROM charging_sessions
            WHERE station_id = ${stationUuid} AND transaction_id = ${transactionId}
            LIMIT 1
          `
        : evseUuid != null
          ? await sql`
              SELECT id, evse_id, transaction_id FROM charging_sessions
              WHERE evse_id = ${evseUuid} AND status = 'active'
              ORDER BY started_at DESC
              LIMIT 1
            `
          : [];
    const row = rows[0];
    if (row == null) return null;
    return {
      id: row.id as string,
      evseUuid: (row.evse_id as string | null) ?? null,
      transactionId: (row.transaction_id as string | null) ?? transactionId ?? null,
    };
  }

  // Cached holiday loader (60s TTL)
  // ---- Payment simulation helpers (used in Started/Ended handlers) ----

  // Retried on a lost connection: the UPDATE is idempotent, and each log INSERT
  // is one statement run once per event.
  safeSubscribe(
    'station.Connected',
    async (event: DomainEvent, attempt: ProjectionAttempt) => {
      const stationUuid = await lookups.getStationUuid(event);
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
        lookups.invalidateStationCache(event.aggregateId);
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

      const siteId = await lookups.resolveSiteId(stationUuid);
      await notify.notifyChange('station.status', stationUuid, siteId);
      if (siteId != null) {
        await notify.notifyOcpiPush('location', { siteId });
      }
      // Back online: the station may be free again with no connector change.
      await checkStationWatches(stationUuid);
    },
    { retryOnConnectionError: true },
  );

  // The station may now receive CSMS calls (BootNotification Accepted, or its
  // first message after a reconnect without a reboot).
  safeSubscribe('station.Ready', async (event: DomainEvent) => {
    const stationUuid = await lookups.getStationUuid(event);
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
      const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
        lookups.invalidateStationCache(event.aggregateId);
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

      const siteId = await lookups.resolveSiteId(stationUuid);
      await notify.notifyChange('station.status', stationUuid, siteId);
      if (siteId != null) {
        await notify.notifyOcpiPush('location', { siteId });
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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
      const bootChange = await clearStationFirmwareInstalling(sql, stationUuid);
      // A reboot that ends an install frees the station with no connector change.
      if (bootChange.availabilityChanged) await checkStationWatches(stationUuid);
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

    const siteId = await lookups.resolveSiteId(stationUuid);
    await notify.notifyChange('station.status', stationUuid, siteId);

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
      const stationUuid = await lookups.getStationUuid(event);
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
      const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
        const stationSiteId = await lookups.resolveSiteId(stationUuid);
        await notify.notifyChange('station.status', stationUuid, stationSiteId);
        if (stationSiteId != null) {
          await notify.notifyOcpiPush('location', { siteId: stationSiteId });
        }
        if (reported === 'available') await checkStationWatches(stationUuid);
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
        lookups.invalidateStationCache(event.aggregateId);
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

      const siteId = await lookups.resolveSiteId(stationUuid);
      await notify.notifyChange('station.status', stationUuid, siteId);
      if (siteId != null) {
        await notify.notifyOcpiPush('location', { siteId });
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

      // StatusNotification idle detection. Idle fees accrue only while the EV
      // suspends: OCPP 1.6 SuspendedEV opens a period on the active session of
      // this EVSE. Every other status that says the EV is not the one pausing
      // closes an open period at the status timestamp: Charging, Preparing,
      // a station-side SuspendedEVSE, Finishing, Faulted (1.6 and 2.1),
      // Unavailable, Available, Reserved. OCPP 2.1 Occupied says nothing about
      // the charging state (the TransactionEvent chargingState decides there).
      const statusTimestamp = (payload.timestamp as string | undefined) ?? new Date().toISOString();
      // An idle period of the EVSE's active session open for
      // IDLE_NOTICE_MIN_SECONDS at this status notifies first, before this
      // status can end it (JB-2).
      const [idleSession] = await sql`
        SELECT id, transaction_id FROM charging_sessions
        WHERE station_id = ${stationUuid} AND status = 'active' AND evse_id = ${resolvedEvseUuid}
          AND idle_started_at IS NOT NULL AND idle_notified_at IS DISTINCT FROM idle_started_at
      `;
      if (idleSession != null) {
        await notify.dispatchDueIdlingNotification(
          idleSession.id as string,
          event.aggregateId,
          idleSession.transaction_id as string,
          statusTimestamp,
        );
      }
      if (ocppStatus === 'SuspendedEV') {
        await sql`
        UPDATE charging_sessions
        SET idle_started_at = ${statusTimestamp}, updated_at = now()
        WHERE station_id = ${stationUuid} AND status = 'active' AND idle_started_at IS NULL
          AND evse_id = ${resolvedEvseUuid}
      `;
      } else if (ocppStatus !== 'Occupied') {
        await sql`
        UPDATE charging_sessions
        SET idle_minutes = idle_minutes + GREATEST(0, EXTRACT(EPOCH FROM (${statusTimestamp}::timestamptz - idle_started_at)) / 60),
            idle_started_at = NULL,
            updated_at = now()
        WHERE station_id = ${stationUuid} AND status = 'active' AND idle_started_at IS NOT NULL
          AND evse_id = ${resolvedEvseUuid}
      `;
      }

      // Station-watch alert: a connector just became available. Only on this
      // rare available-edge (never on every StatusNotification). Kept last in
      // the handler so its query never reorders the writes above.
      if (dbStatus === 'available' && previousDbStatus !== 'available') {
        await checkStationWatches(stationUuid);
      }
    },
    { retryOnConnectionError: true },
  );

  // Retried on a lost connection: every step that must not repeat is in
  // attempt.once or attempt.memo (`started:`, `updated:`, `ended:` keys, see
  // transaction-projector.ts).
  safeSubscribe('ocpp.TransactionEvent', (e, attempt) => projector.project(e, attempt), {
    retryOnConnectionError: true,
  });

  // Steps a rerun must not repeat are keyed by reading (`mv:<i>:`): the
  // previous energy read keeps its first result (the energy UPDATE after it
  // would make a rerun see a flat reading), each idle open or close runs once
  // per reading (a rerun of an earlier reading's open would reopen a period a
  // later reading closed), and the active sessions keep their first read (a
  // rerun would see the cost the first run stored as the previous cost).
  safeSubscribe(
    'ocpp.MeterValues',
    async (event: DomainEvent, attempt: ProjectionAttempt) => {
      const payload = event.payload;
      const stationId = payload.stationId as string;
      let stationUuid = await lookups.resolveStationUuid(stationId);
      if (stationUuid == null) return;

      const ocppEvseId =
        typeof payload.evseId === 'number'
          ? payload.evseId
          : typeof payload.evseId === 'string'
            ? parseInt(payload.evseId, 10)
            : 0;
      const transactionId = payload.transactionId as string | undefined;
      const source = (payload.source as string | undefined) ?? null;
      // The chargingState of the 2.1 TransactionEvent that carried these
      // readings. A station that reports chargingState decides the idle state
      // itself (finding JB-1): the meter fallbacks below apply only to
      // sessions whose events never carried one (1.6, and 2.1 stations
      // without chargingState).
      const eventChargingState =
        typeof payload.chargingState === 'string' ? payload.chargingState : null;

      const reportedEvseUuid = await lookups.resolveEvseUuid(stationUuid, ocppEvseId);
      // Link meter values to a session when they came from a TransactionEvent or
      // when the MeterValues message includes a transactionId (OCPP 1.6 always does this).
      const isTransactionScoped = source === 'TransactionEvent' || transactionId != null;
      const session = isTransactionScoped
        ? await resolveMeterValueSession(stationUuid, reportedEvseUuid, transactionId)
        : null;
      const sessionId = session?.id ?? null;

      if (sessionId == null && transactionId != null && isTransactionScoped) {
        state.txBuffer.add(stationId, transactionId, event);
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

      // Readings whose session effects ran in this delivery (see below).
      let projectedReadings = 0;
      // The newest timestamp among the readings projected in this delivery:
      // the time a split billing segment switch applies at (finding B5).
      let latestReadingMs: number | null = null;
      // The session energy at that newest reading, when it was the session's
      // newest projected register reading (not stale): a reading at or before
      // a switch the boundary job made moves the boundary energy up to it.
      let latestReadingEnergy: { sessionId: string; energyWh: number } | null = null;
      for (const [reading, mv] of meterValues.entries()) {
        const mvTimestamp = mv.timestamp as string;
        const sampledValues = mv.sampledValue as Array<Record<string, unknown>> | undefined;
        if (sampledValues == null) continue;
        const energySamples: PhaseSample[] = [];
        const powerSamples: PhaseSample[] = [];
        let storedSamples = 0;

        for (const [sample, sv] of sampledValues.entries()) {
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

          // Memoized per sample: a projection retry keeps the first run's
          // answer, although that run's rows now conflict.
          const knownStationUuid = stationUuid;
          const stored = await attempt.memo(
            `mv:${String(reading)}:${String(sample)}:stored`,
            async (): Promise<{ stationUuid: string; count: number } | null> => {
              const mvInserted = await sql`
          INSERT INTO meter_values (
            station_id, evse_id, session_id, timestamp, measurand, value, unit,
            phase, location, context, signed_data, source
          )
          SELECT
            ${knownStationUuid},
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
          WHERE EXISTS (SELECT 1 FROM charging_stations WHERE id = ${knownStationUuid})
          ON CONFLICT (session_id, evse_id, timestamp, measurand, phase, location) DO NOTHING
        `;
              if (mvInserted.count !== 0) {
                return { stationUuid: knownStationUuid, count: mvInserted.count };
              }
              lookups.invalidateStationCache(stationId);
              const resolved = await lookups.resolveStationUuid(stationId);
              if (resolved == null) return null;
              const retried = await sql`
            INSERT INTO meter_values (
              station_id, evse_id, session_id, timestamp, measurand, value, unit,
              phase, location, context, signed_data, source
            )
            VALUES (
              ${resolved},
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
              return { stationUuid: resolved, count: retried.count };
            },
          );
          if (stored == null) return;
          stationUuid = stored.stationUuid;
          storedSamples += stored.count;

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

        // A reading of a session that stored no new sample is one the
        // station sent again (a resent MeterValues or TransactionEvent after
        // a reconnect, finding JB-6): the meter_values unique key already
        // holds it, so its energy, idle and notice effects ran with the first
        // delivery. Applying them again would set the energy back to an
        // older register reading.
        if (sessionId != null && storedSamples === 0) continue;
        projectedReadings++;
        const readingMs = new Date(mvTimestamp).getTime();
        if (!Number.isNaN(readingMs) && (latestReadingMs == null || readingMs > latestReadingMs)) {
          latestReadingMs = readingMs;
          latestReadingEnergy = null;
        }

        // An idle period open for IDLE_NOTICE_MIN_SECONDS at this reading
        // notifies first, before this reading can end it (JB-2). Readings a
        // TransactionEvent carried are checked by its own projection, at the
        // event timestamp.
        if (session?.transactionId != null && source !== 'TransactionEvent') {
          await notify.dispatchDueIdlingNotification(
            session.id,
            stationId,
            session.transactionId,
            mvTimestamp,
          );
        }

        // Update energy_delivered_wh on the session when we get an energy reading.
        // Transaction-scoped readings (TransactionEvent, 1.6 MeterValues with transactionId)
        // update their own session while it is active. Standalone 2.1 MeterValues on an
        // EVSE update the active session on that EVSE.
        const meterValue = overallValue(energySamples);
        if (appliesToSession && meterValue != null) {
          // The target session and when its energy last rose, for flat-reading idle detection
          const prevRows = await attempt.memo(
            `mv:${String(reading)}:prev`,
            () => sql`
          SELECT id, COALESCE(energy_rose_at, started_at) AS last_rise_at
          FROM charging_sessions
          WHERE station_id = ${stationUuid} AND status = 'active'
            AND (id = ${sessionId} OR (${sessionId}::text IS NULL AND evse_id = ${evseUuid}))
        `,
          );
          const targetSessionId = prevRows[0]?.id as string | undefined;
          const lastRiseAt = prevRows[0]?.last_rise_at as Date | string | null | undefined;

          // Registers are cumulative: energy = register + offset - meter_start
          // (applySessionEnergyReading, finding B10). The first reading of a
          // 2.1 transaction sets meter_start. A reading older than the newest
          // projected one never changes the energy, and a newer reading below
          // it (a meter reset or replacement, J02.FR.16) adds the drop to the
          // offset, so the energy never goes down. energy_rose_at records the
          // reading that raised the energy by 1 Wh or more (the flat-energy
          // fallback below measures the flat time from it). Memoized: a rerun
          // sees the result of the first run, with its previous energy.
          const energy =
            targetSessionId == null
              ? null
              : await attempt.memo(`mv:${String(reading)}:energy`, () =>
                  applySessionEnergyReading(sql, {
                    sessionId: targetSessionId,
                    registerWh: meterValue,
                    at: new Date(mvTimestamp),
                  }),
                );
          if (energy != null && targetSessionId != null && readingMs === latestReadingMs) {
            latestReadingEnergy =
              energy.kind === 'stale'
                ? null
                : { sessionId: targetSessionId, energyWh: energy.energyWh };
          }
          if (energy?.kind === 'drop') {
            logger.warn(
              {
                stationId,
                sessionId: targetSessionId,
                registerWh: meterValue,
                offsetWh: energy.offsetWh,
              },
              'Energy register dropped during the transaction (meter reset or replacement); rebased',
            );
          }
          const prevEnergyWh = energy?.previousEnergyWh ?? -1;

          // Flat energy reading idle detection (Priority 3 fallback).
          // If energy_delivered_wh did not change after this reading and has not
          // risen for a full sample interval (isFlatEnergyReading), no power is
          // flowing. A sample sent a moment after a periodic one (clock-aligned,
          // transaction end) shows almost no new energy while the EV charges,
          // so it opens nothing (finding J3).
          // The idle_started_at IS NULL guard ensures higher-priority signals are not overwritten.
          // Neither meter fallback opens a period while the session's connector
          // is faulted, suspended by the station (suspended_evse), finishing
          // (1.6), or in OCPP 2.1 Idle or EVConnected: idle fees accrue only
          // while the EV suspends. Neither fallback opens or closes a period
          // for a reading older than the newest status the station reported
          // for the session's EVSE, or the event's EVSE for a session without
          // one (connectors.status_reported_at): a reading replayed from an
          // offline queue after a live status is stale.
          // A stale (older) reading or the first reading opens and closes
          // nothing, nor does a register drop (meter reset or replacement):
          // its energy is the energy kept from before the drop, not a flat
          // reading (TC-T2-07).
          if (
            eventChargingState == null &&
            energy != null &&
            energy.kind !== 'first' &&
            energy.kind !== 'stale' &&
            energy.kind !== 'drop' &&
            prevEnergyWh >= 0
          ) {
            const newEnergyWh = energy.energyWh;
            if (Math.abs(newEnergyWh - prevEnergyWh) < 1) {
              const flat =
                lastRiseAt != null &&
                isFlatEnergyReading({
                  previousEnergyWh: prevEnergyWh,
                  energyWh: newEnergyWh,
                  lastRiseAt: new Date(lastRiseAt),
                  readingAt: new Date(mvTimestamp),
                });
              // Energy flat for a full interval: mark idle if not already set
              if (flat) {
                await attempt.once(
                  `mv:${String(reading)}:energy-idle-open`,
                  () => sql`
                UPDATE charging_sessions
                SET idle_started_at = ${mvTimestamp}, updated_at = now()
                WHERE station_id = ${stationUuid} AND status = 'active' AND idle_started_at IS NULL
                  AND (id = ${sessionId} OR (${sessionId}::text IS NULL AND evse_id = ${evseUuid}))
                  AND NOT EXISTS (
                    SELECT 1 FROM transaction_events te
                    WHERE te.session_id = charging_sessions.id
                      AND te.payload->>'chargingState' IS NOT NULL
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM connectors c
                    WHERE (c.id = charging_sessions.connector_id
                      OR (charging_sessions.connector_id IS NULL AND c.evse_id = charging_sessions.evse_id))
                      AND c.status IN ('faulted', 'suspended_evse', 'finishing', 'ev_connected', 'idle')
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM connectors c
                    WHERE c.evse_id = COALESCE(charging_sessions.evse_id, ${evseUuid})
                      AND c.status_reported_at > ${mvTimestamp}::timestamptz
                  )
              `,
                );
              }
            } else {
              // Energy increased: accumulate idle time and clear idle_started_at,
              // unless the station reports this idle period (see below).
              await attempt.once(
                `mv:${String(reading)}:energy-idle-close`,
                () => sql`
              UPDATE charging_sessions
              SET idle_minutes = idle_minutes + GREATEST(0, EXTRACT(EPOCH FROM (${mvTimestamp}::timestamptz - idle_started_at)) / 60),
                  idle_started_at = NULL,
                  updated_at = now()
              WHERE station_id = ${stationUuid} AND status = 'active' AND idle_started_at IS NOT NULL
                AND (id = ${sessionId} OR (${sessionId}::text IS NULL AND evse_id = ${evseUuid}))
                AND idle_started_at <= ${mvTimestamp}::timestamptz
                AND NOT EXISTS (
                  SELECT 1 FROM transaction_events te
                  WHERE te.session_id = charging_sessions.id
                    AND te.payload->>'chargingState' IS NOT NULL
                )
                AND NOT EXISTS (
                  SELECT 1 FROM connectors c
                  WHERE (c.id = charging_sessions.connector_id
                    OR (charging_sessions.connector_id IS NULL AND c.evse_id = charging_sessions.evse_id))
                    AND c.status = 'suspended_ev'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM connectors c
                  WHERE c.evse_id = COALESCE(charging_sessions.evse_id, ${evseUuid})
                    AND c.status_reported_at > ${mvTimestamp}::timestamptz
                )
            `,
              );
            }
          }
        }

        // Power-based idle detection (fallback for OCPP 1.6 and 2.1 stations
        // that never report chargingState: a reading carried by an event with
        // chargingState, or of a session whose events carried one, changes
        // nothing, JB-1). Only transaction-scoped readings update idle state.
        // A reading older than the newest projected register reading (an
        // offline replay) opens and closes nothing, and a close never ends a
        // period that opened after the reading (finding B11).
        const powerValue = overallValue(powerSamples);
        if (
          eventChargingState == null &&
          appliesToSession &&
          isTransactionScoped &&
          powerValue != null
        ) {
          if (powerValue === 0) {
            // No power flowing: mark idle start if not already set
            await attempt.once(
              `mv:${String(reading)}:power-idle-open`,
              () => sql`
            UPDATE charging_sessions
            SET idle_started_at = ${mvTimestamp}, updated_at = now()
            WHERE station_id = ${stationUuid} AND status = 'active' AND idle_started_at IS NULL
              AND (id = ${sessionId} OR (${sessionId}::text IS NULL AND evse_id = ${evseUuid}))
              AND (meter_last_register_at IS NULL OR meter_last_register_at <= ${mvTimestamp}::timestamptz)
              AND NOT EXISTS (
                SELECT 1 FROM transaction_events te
                WHERE te.session_id = charging_sessions.id
                  AND te.payload->>'chargingState' IS NOT NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM connectors c
                WHERE (c.id = charging_sessions.connector_id
                  OR (charging_sessions.connector_id IS NULL AND c.evse_id = charging_sessions.evse_id))
                  AND c.status IN ('faulted', 'suspended_evse', 'finishing', 'ev_connected', 'idle')
              )
              AND NOT EXISTS (
                SELECT 1 FROM connectors c
                WHERE c.evse_id = COALESCE(charging_sessions.evse_id, ${evseUuid})
                  AND c.status_reported_at > ${mvTimestamp}::timestamptz
              )
          `,
            );
          } else {
            // Power resumed: accumulate idle time and clear idle_started_at.
            // The meter fallbacks never end a period the station reports: while
            // the session's connector is suspended_ev (1.6 SuspendedEV status)
            // only the station's next state ends it, and a 2.1 session that
            // reports chargingState never takes the fallbacks (JB-1).
            await attempt.once(
              `mv:${String(reading)}:power-idle-close`,
              () => sql`
            UPDATE charging_sessions
            SET idle_minutes = idle_minutes + GREATEST(0, EXTRACT(EPOCH FROM (${mvTimestamp}::timestamptz - idle_started_at)) / 60),
                idle_started_at = NULL,
                updated_at = now()
            WHERE station_id = ${stationUuid} AND status = 'active' AND idle_started_at IS NOT NULL
              AND (id = ${sessionId} OR (${sessionId}::text IS NULL AND evse_id = ${evseUuid}))
              AND idle_started_at <= ${mvTimestamp}::timestamptz
              AND (meter_last_register_at IS NULL OR meter_last_register_at <= ${mvTimestamp}::timestamptz)
              AND NOT EXISTS (
                SELECT 1 FROM transaction_events te
                WHERE te.session_id = charging_sessions.id
                  AND te.payload->>'chargingState' IS NOT NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM connectors c
                WHERE (c.id = charging_sessions.connector_id
                  OR (charging_sessions.connector_id IS NULL AND c.evse_id = charging_sessions.evse_id))
                  AND c.status = 'suspended_ev'
              )
              AND NOT EXISTS (
                SELECT 1 FROM connectors c
                WHERE c.evse_id = COALESCE(charging_sessions.evse_id, ${evseUuid})
                  AND c.status_reported_at > ${mvTimestamp}::timestamptz
              )
          `,
            );
          }
        }
      }

      // Notify for all MeterValues (both standalone and transaction-scoped).
      // Cost recalculation and session updates follow below when active sessions exist.

      // Update the running cost of active sessions for this station from their
      // price snapshots. JOIN to charging_stations so the CostUpdated dispatch
      // path below has the transactionId and ocpp_protocol without a second SQL
      // round-trip per cost-change event.
      // Every reading was a resend: the running cost was updated when they
      // first arrived.
      const resent = sessionId != null && projectedReadings === 0;
      const activeSessions =
        appliesToSession && !resent
          ? await attempt.memo(
              'mv:active-sessions',
              () => sql`
          SELECT cs.id, cs.transaction_id, cs.tariff_id, cs.driver_id, cs.token_id,
                 COALESCE(cs.pricing_group_id,
                   (SELECT t.pricing_group_id FROM tariffs t WHERE t.id = cs.tariff_id)
                 ) AS pricing_group_id,
                 cs.payment_gate_due_at,
                 cs.tariff_price_per_kwh, cs.tariff_price_per_minute, cs.tariff_price_per_session,
                 cs.tariff_idle_fee_price_per_minute, cs.tariff_reservation_fee_per_minute,
                 cs.tariff_tax_rate,
                 cs.energy_delivered_wh, cs.current_cost_cents, cs.cost_ceiling_cents,
                 cs.idle_started_at, cs.idle_minutes, st.ocpp_protocol,
                 cs.billing_mode, cs.billing_fleet_id, cs.stopped_reason,
                 f.credit_limit_cents AS fleet_credit_limit_cents
          FROM charging_sessions cs
          JOIN charging_stations st ON st.id = cs.station_id
          LEFT JOIN fleets f ON f.id = cs.billing_fleet_id AND cs.billing_mode = 'account'
          WHERE cs.station_id = ${stationUuid} AND cs.status = 'active' AND cs.tariff_id IS NOT NULL
            AND (cs.id = ${sessionId} OR (${sessionId}::text IS NULL AND cs.evse_id = ${evseUuid}))
        `,
            )
          : [];

      const splitBillingEnabled = await isSplitBillingEnabled();
      for (const session of activeSessions) {
        const sessionId = session.id as string;
        const now = new Date();
        const energyWh = Number(session.energy_delivered_wh ?? 0);

        // Split billing: when the tariff that applies at the newest reading
        // (its timestamp, at most now; finding B5) differs from the one of the
        // open segment, close that segment and open one priced from the new
        // tariff at that reading. The session's energy so far selects an
        // energy-threshold tariff once the threshold is crossed. Under the
        // session row lock, with a compare-and-set close, so a concurrent
        // boundary job switch never opens a second segment (finding B1); a
        // reading not after the open segment's start switches nothing. The
        // session keeps the tariff snapshot it started with.
        if (splitBillingEnabled) {
          // Only within the pricing group the session started in (B7): an
          // assignment or fleet membership change applies to the next session.
          const switchAt = eventTimeAtMostNow(
            latestReadingMs != null ? new Date(latestReadingMs) : null,
            now,
          );
          const currentTariff = await resolveStationTariff(
            {
              stationUuid,
              driverUuid: session.driver_id as string | null,
              at: switchAt,
              sessionEnergyKwh: energyWh / 1000,
              pricingGroupId: session.pricing_group_id as string | null,
            },
            sql,
          );
          if (currentTariff != null) {
            const switched = await switchTariffSegment(sql, {
              sessionId,
              tariff: currentTariff,
              at: switchAt,
              energyWh,
              readingEnergyWh:
                latestReadingEnergy?.sessionId === sessionId ? latestReadingEnergy.energyWh : null,
            });
            if (switched != null) {
              // A station that calculates the cost locally gets the tariff
              // that applies from now, unless its tariff already describes it
              // (I11). Fail-open inside: billing follows the segments.
              await sendSessionTariffChange(sql, pubsub, { sessionId, at: now, energyWh });
              // A session that started free and moved to a paid tariff runs
              // the payment gate now (B3): a card hold, or a stop by the gate
              // rules.
              if (isFreeToPaidSwitch(sessionStartTariff(session), currentTariff)) {
                await runSegmentPaymentGate(deps, sessionId, currentTariff);
              }
            }
          }
        }

        // The worker's tariff boundary job moved this session from a free to
        // a paid tariff: the gate runs here, once per mark (claimed below).
        if (session.payment_gate_due_at != null) {
          await runDuePaymentGate(deps, sessionId);
        }

        // The running cost, from the one cost assembly the final cost uses
        // (segments, idle grace, and the reservation holding fee).
        let breakdown = await priceSessionAt(sql, sessionId, now, energyWh);
        if (breakdown == null) continue;

        // Account session of a credit-limited fleet (plan S8, bounded
        // reservation): near its ceiling the ceiling grows by another slice
        // of the fleet credit, and the cost is priced again under the grown
        // ceiling, so the session is neither capped nor stopped while the
        // fleet has credit. "Near" also scales with the cost this reading
        // added, so a large reading grows the ceiling before a 2.1 station
        // reaches its old maxCost. Not after the session was claimed at the
        // ceiling (stopped_reason AccountCreditLimit).
        let ceilingCents =
          session.cost_ceiling_cents != null ? Number(session.cost_ceiling_cents) : null;
        if (
          ceilingCents != null &&
          session.billing_mode === 'account' &&
          session.billing_fleet_id != null &&
          session.stopped_reason !== 'AccountCreditLimit'
        ) {
          const pricedCents = breakdown.pricedGrossCents ?? breakdown.grossCents;
          const storedCostCents =
            session.current_cost_cents != null ? Number(session.current_cost_cents) : null;
          const grown = await growAccountCeiling(deps, state.fleetCredit, {
            sessionId,
            fleetId: session.billing_fleet_id as string,
            ceilingCents,
            pricedCents,
            lastReadingCents:
              storedCostCents != null ? Math.max(pricedCents - storedCostCents, 0) : 0,
          });
          if (grown > ceilingCents) {
            ceilingCents = grown;
            breakdown = await priceSessionAt(sql, sessionId, now, energyWh);
            if (breakdown == null) continue;
          }
        }
        const totalCents = breakdown.grossCents;
        const previousCostCents = session.current_cost_cents as number | null;

        if (!(await storeRunningCost(sql, sessionId, breakdown))) continue;

        // The TransactionEvent projection renders the screen before this cost is
        // stored, so render it again with the new energy and cost.
        if (previousCostCents !== totalCents) {
          await notify.publishStationMessageTransaction(
            { stationUuid, stationId, protocol: session.ocpp_protocol as string | null },
            sessionId,
            'updated',
            null,
          );
        }

        // Fleet credit limit notices (plan S8): a running account session's
        // cost raises its fleet's exposure, so the warning and reached notices
        // also go out while it charges, once per fleet and month each (the
        // claim in dispatchFleetCreditLimitNotices). Only for a fleet with a
        // limit and a changed cost; read without the fleet lock, nothing is
        // reserved. Fire-and-forget and fail-open (P9).
        if (
          previousCostCents !== totalCents &&
          session.billing_mode === 'account' &&
          session.billing_fleet_id != null &&
          session.fleet_credit_limit_cents != null
        ) {
          trackRunningFleetCreditNotices(
            deps,
            session.billing_fleet_id as string,
            state.fleetCredit,
          );
        }

        // Cost ceiling: a guest's card hold (the authorization is the ceiling
        // for the cost, C25), a prepaid token's credit (C17.FR.03), stamped
        // by the Started projection, or the fleet credit an account session
        // reserved at the payment gate (plan S8). The cost assembly bills at most
        // cost_ceiling_cents, so energy, time and idle fees past it are not
        // paid for. OCPP 1.6 has no transaction limit: the CSMS stops the
        // transaction once the cost reaches the ceiling. An OCPP 2.1 station
        // got the ceiling as transactionLimit.maxCost and suspends itself
        // (E16.FR.05), keeping the transaction open until the driver unplugs;
        // the CSMS stops it only when a later reading finds the ceiling already
        // reached and the station never reported CostLimitReached (it ignores
        // or does not support the limit, E16.FR.12, P11). An account
        // session's ceiling grew above while its fleet had credit, so it
        // stops here only when the fleet has none left.
        const ceilingTxId = session.transaction_id as string | null;
        if (ceilingCents != null && ceilingTxId != null && totalCents >= ceilingCents) {
          const stopNow =
            session.ocpp_protocol === 'ocpp1.6' ||
            (previousCostCents != null &&
              previousCostCents >= ceilingCents &&
              !(await costLimitReported(sql, sessionId)));
          if (stopNow) {
            // The reason from how the session is paid: an account session
            // (its ceiling is the fleet credit it reserved), a prepaid token's
            // credit, or a guest's hold (no driver token).
            const reason = ceilingStopReason({
              billingMode: session.billing_mode as string | null,
              tokenId: session.token_id as string | null,
            });
            logger.info(
              {
                sessionId,
                ceilingCents,
                pricedCents: breakdown.pricedGrossCents ?? totalCents,
                protocol: session.ocpp_protocol as string | null,
                reason,
              },
              'Cost ceiling reached, stopping the transaction',
            );
            await stopSessionForPayment(
              deps,
              {
                sessionId,
                transactionId: ceilingTxId,
                ocppStationId: stationId,
                stationDbId: stationUuid,
              },
              reason,
              { atCeiling: true },
            );
          }
        }

        // Send CostUpdated to station when cost changes (OCPP 2.1 only).
        // Throttled per session via state.costUpdated to keep dispatch volume
        // bounded under high MeterValues cadence.
        if (previousCostCents !== totalCents) {
          const nowMs = now.getTime();
          if (state.costUpdated.due(sessionId, nowMs)) {
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
                state.costUpdated.markSent(sessionId, nowMs);
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

      const siteId = await lookups.resolveSiteId(stationUuid);
      await notify.notifyChange('meter.values', stationUuid, siteId);
    },
    { retryOnConnectionError: true },
  );

  safeSubscribe('ocpp.FirmwareStatusNotification', async (event: DomainEvent) => {
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
      await notify.notifyChange(
        'station.status',
        stationUuid,
        await lookups.resolveSiteId(stationUuid),
      );
      // A finished or ended install frees the station with no connector change.
      await checkStationWatches(stationUuid);
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
        // The station's site scopes the event on the operator SSE stream.
        const campaignStationSiteId = await lookups.resolveSiteId(stationUuid);
        await notify.notifyChange(
          'firmwareCampaign.stationUpdated',
          stationUuid,
          campaignStationSiteId,
          null,
          { campaignId: linkedCampaignId },
        );
        if (completed.count > 0) {
          await notify.notifyChange(
            'firmwareCampaign.completed',
            stationUuid,
            campaignStationSiteId,
            null,
            { campaignId: linkedCampaignId },
          );
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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
            await notify.notifyChange(
              'station.status',
              stationUuid,
              await lookups.resolveSiteId(stationUuid),
            );
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

    const siteId = await lookups.resolveSiteId(stationUuid);
    await notify.notifyChange('station.securityEvent', stationUuid, siteId);
  });

  safeSubscribe('ocpp.ReservationStatusUpdate', async (event: DomainEvent) => {
    const payload = event.payload;
    const reservationOcppId = payload.reservationId as number;
    const updateStatus = payload.reservationUpdateStatus as string;

    if (updateStatus === 'Expired') {
      // Expired reservations stay on the dedicated 'expired' status path,
      // which has its own no-show fee handling in the worker. Conditional
      // UPDATE so we only audit on the actual transition.
      const expired = await sql<
        Array<{ id: string; driver_id: string | null; station_id: string }>
      >`
        UPDATE reservations
        SET status = 'expired', updated_at = now()
        WHERE reservation_id = ${reservationOcppId}
          AND status IN ('active', 'scheduled', 'in_use')
        RETURNING id, driver_id, station_id
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
        await notify.notifyChange(
          'reservation.changed',
          expiredRow.station_id,
          await lookups.resolveSiteId(expiredRow.station_id),
        );
        await checkStationWatches(expiredRow.station_id);
      }
      return;
    }

    if (updateStatus === 'Removed') {
      // Station-initiated removal (operator pressed cancel on the station,
      // physical fault, etc.). Treat as a system cancel: write metadata,
      // never charge a fee. Scope the UPDATE to the reporting station to
      // avoid touching a stale row at a different station with the same
      // OCPP reservation id (no DB-level uniqueness across stations).
      const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
        await notify.notifyChange(
          'reservation.changed',
          stationUuid,
          await lookups.resolveSiteId(stationUuid),
        );
        await checkStationWatches(stationUuid);
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
    await projectNotifySettlement(deps, event);
  });

  // Retried on a lost connection: the outcome is kept (`settle:outcome`) and
  // each notice is sent once (`settle:` keys).
  safeSubscribe(
    'ocpp.TransactionEvent',
    async (event: DomainEvent, attempt: ProjectionAttempt) => {
      await settleTransactionEnded(deps, event, attempt);
    },
    { retryOnConnectionError: true },
  );

  // A session the CSMS ends because the station will not (superseded on its
  // EVSE, or unknown to the station): the normal end, then the settlement, in
  // one queued step. A session faulted or failed meanwhile is left alone (P5).
  // Not retried: a rerun's status check would find the session completed and
  // skip the settlement; the session end lease sweep asks again instead.
  safeSubscribe(SESSION_ENDED_BY_CSMS, (e, attempt) => projector.endByCsms(e, attempt));

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
        stationUuid = await lookups.resolveStationUuid(stationId);
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
        lookups.invalidateStationCache(stationId);
        return;
      }

      // Any inbound message proves liveness (OCPP 2.1 G02.FR.04, OCPP 1.6 §4.6), so it
      // bumps last_heartbeat (the station's last activity, read by the offline sweep)
      // and marks online a station a late disconnect or the sweep marked offline.
      // A busy station writes the row at most once per LIVENESS_WRITE_INTERVAL_SECONDS:
      // the guard skips the write while the stored value is newer and the station is
      // online. A guard in SQL holds across OCPP pods and never delays a station
      // coming back online.
      let cameOnline = false;
      if (direction === 'inbound') {
        const [row] = await attempt.memo(
          'liveness',
          () => sql`
            WITH prev AS (SELECT is_online FROM charging_stations WHERE id = ${loggedStationUuid})
            UPDATE charging_stations
            SET last_heartbeat = now(), is_online = true
            WHERE id = ${loggedStationUuid}
              AND (is_online = false OR last_heartbeat IS NULL
                OR last_heartbeat < now() - make_interval(secs => ${LIVENESS_WRITE_INTERVAL_SECONDS}))
            RETURNING (SELECT is_online FROM prev) AS was_online
          `,
        );
        cameOnline = row?.was_online === false;
      }

      const siteId = await lookups.resolveSiteId(stationUuid);
      if (cameOnline) {
        logger.info({ stationId }, 'Station marked online again by an inbound message');
        await notify.notifyChange('station.status', stationUuid, siteId);
        if (siteId != null) {
          await notify.notifyOcpiPush('location', { siteId });
        }
      }
      await notify.notifyChange('ocpp.message', stationUuid, siteId);
    },
    { retryOnConnectionError: true },
  );

  // --- Display Message Projection ---

  safeSubscribe('ocpp.NotifyDisplayMessages', async (event: DomainEvent) => {
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
        lookups.invalidateStationCache(event.aggregateId);
        return;
      }
    }

    const siteId = await lookups.resolveSiteId(stationUuid);
    await notify.notifyChange('displayMessage.updated', stationUuid, siteId);
  });

  // The command listener publishes these with the station's reply for every
  // SetDisplayMessage and ClearDisplayMessage it sends, including commands queued
  // while the station was offline and sent on reconnect, where no API caller is
  // waiting for the reply. Station message slots (9000+) have no display_messages
  // row and match nothing.
  safeSubscribe('command.SetDisplayMessage', async (event: DomainEvent) => {
    const request = event.payload.request as Record<string, unknown> | undefined;
    const message = request?.['message'] as Record<string, unknown> | undefined;
    const messageId = message?.['id'];
    const response = event.payload.response as Record<string, unknown> | undefined;
    const status = response?.['status'];
    if (typeof messageId !== 'number' || typeof status !== 'string') return;

    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    // Only a pending row takes the reply, so a late reply cannot revive a
    // cleared row or overwrite one the station already reported.
    const newStatus = status === 'Accepted' ? 'accepted' : 'rejected';
    const updated = await sql`
      UPDATE display_messages
      SET status = ${newStatus}, ocpp_response = ${sql.json(asJson(response))}, updated_at = now()
      WHERE station_id = ${stationUuid} AND ocpp_message_id = ${messageId} AND status = 'pending'
    `;
    if (updated.count === 0) return;

    const siteId = await lookups.resolveSiteId(stationUuid);
    await notify.notifyChange('displayMessage.updated', stationUuid, siteId);
  });

  safeSubscribe('command.ClearDisplayMessage', async (event: DomainEvent) => {
    const request = event.payload.request as Record<string, unknown> | undefined;
    const messageId = request?.['id'];
    const response = event.payload.response as Record<string, unknown> | undefined;
    // Unknown or Rejected leaves the row as it is.
    if (typeof messageId !== 'number' || response?.['status'] !== 'Accepted') return;

    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
    if (stationUuid == null) return;

    // cleared is terminal: rejected, expired and cleared rows stay as they are.
    const updated = await sql`
      UPDATE display_messages
      SET status = 'cleared', ocpp_response = ${sql.json(asJson(response))}, updated_at = now()
      WHERE station_id = ${stationUuid} AND ocpp_message_id = ${messageId}
        AND status IN ('pending', 'accepted')
    `;
    if (updated.count === 0) return;

    const siteId = await lookups.resolveSiteId(stationUuid);
    await notify.notifyChange('displayMessage.updated', stationUuid, siteId);
  });

  // --- PnC Certificate Projections ---

  safeSubscribe('pnc.CsrSigned', async (event: DomainEvent) => {
    const stationUuid = await lookups.getStationUuid(event);
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

    const siteId = await lookups.resolveSiteId(stationUuid);
    await notify.notifyChange('certificate.signed', stationUuid, siteId);
  });

  safeSubscribe('pnc.InstallCertificateResult', async (event: DomainEvent) => {
    const stationUuid = await lookups.getStationUuid(event);
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

    const siteId = await lookups.resolveSiteId(stationUuid);
    await notify.notifyChange('certificate.signed', stationUuid, siteId);
  });

  // --- Notification dispatch ---

  // Every OCPP event the CSMS lists. Each sends only when an operator enabled it
  // (an ocpp_event_settings row); the dispatcher checks that in its cached settings.
  for (const eventType of OCPP_NOTIFICATION_EVENT_TYPES) {
    safeSubscribe(eventType, async (event: DomainEvent) => {
      // A status taken from a NotifyEvent already notifies as ocpp.NotifyEvent.
      if (event.payload.source === 'NotifyEvent') return;
      await dispatchOcppNotification(sql, event);
    });
  }

  // ---- OCPP Operational Data Projections ----

  safeSubscribe('ocpp.NotifyEvent', async (event: DomainEvent) => {
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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

    const siteId = await lookups.resolveSiteId(stationUuid);
    await notify.notifyChange('station.event', stationUuid, siteId);
  });

  safeSubscribe('ocpp.NotifyMonitoringReport', async (event: DomainEvent) => {
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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

    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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

    const siteId = await lookups.resolveSiteId(stationUuid);
    await notify.notifyChange('station.evChargingNeeds', stationUuid, siteId);

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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
    const stationUuid = await lookups.resolveStationUuid(event.aggregateId);
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
