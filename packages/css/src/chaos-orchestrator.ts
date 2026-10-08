// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { OCTT_TEST_DRIVER_EMAIL } from '@evtivity/lib';
import type { PubSubClient } from '@evtivity/lib';
import { ChaosJourneys } from './chaos-journey.js';
import { logger } from './lib/logger.js';

interface DriverToken {
  idToken: string;
  tokenType: string;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

export type CssStationStatus =
  | 'disconnected'
  | 'booting'
  | 'available'
  | 'charging'
  | 'faulted'
  | 'unavailable';

// Action names that mutate connector/transaction/connectivity state. Anything
// not in this set (notifications like sendHeartbeat, sendMeterValues) is safe
// to fire whenever the station is connected.
const CHAOS_STATE_MUTATING: ReadonlySet<string> = new Set([
  'plugIn',
  'unplug',
  'authorize',
  'startCharging',
  'stopCharging',
  'injectFault',
  'clearFault',
  'suspendCharging',
  'resumeCharging',
  'comeOnline',
  'goOffline',
  'sendStatusNotification',
  'sendBootNotification',
]);

const CHAOS_VALID_BY_STATE: Readonly<Record<CssStationStatus, ReadonlySet<string>>> = {
  disconnected: new Set(['comeOnline']),
  booting: new Set([]),
  available: new Set(['plugIn', 'authorize', 'goOffline', 'injectFault', 'sendStatusNotification']),
  charging: new Set([
    'stopCharging',
    'unplug',
    'injectFault',
    'goOffline',
    'suspendCharging',
    'resumeCharging',
  ]),
  faulted: new Set(['clearFault', 'goOffline']),
  unavailable: new Set(['comeOnline', 'sendStatusNotification']),
};

// css_evses.status values that mean "cable physically connected".
// Finishing is included: post-stop the cable is still plugged in until the
// driver retrieves it.
const CHAOS_PLUGGED_STATUSES: ReadonlySet<string> = new Set([
  'Preparing',
  'Occupied',
  'EVConnected',
  'SuspendedEV',
  'SuspendedEVSE',
  'Finishing',
]);

// Finishing is a transient post-stop state: the session has ended but the
// cable is still connected. The only spec-plausible chaos actions here are
// the ones a real driver or operator would do: retrieve the cable (unplug),
// take the station offline, or simulate a fault. Re-authorizing or plugging
// in here is non-physical and races with the StatusNotification(Finishing)
// that's still in flight from stopCharging, producing a charging -> preparing
// -> finishing visual flash on the portal.
const CHAOS_FINISHING_ACTIONS: ReadonlySet<string> = new Set([
  'unplug',
  'goOffline',
  'injectFault',
]);

// Reserved is a connector state where the station is holding the slot for a
// specific reservation. Chaos must NOT randomly fire `sendStatusNotification`
// here -- the random status clobbers the Reserved state with Available the
// moment a reservation is made, breaking the reservation gate end-to-end.
// Allow only off-station actions (offline, faults) and the holder's own
// physical actions (plugIn, authorize) which are how a real holder would
// transition out of Reserved.
const CHAOS_RESERVED_ACTIONS: ReadonlySet<string> = new Set([
  'plugIn',
  'authorize',
  'goOffline',
  'injectFault',
]);

/**
 * Filter chaos actions to those valid for the given station/connector state.
 * Pure function exposed for unit testing; chaos uses it to skip ticks that
 * would no-op at the simulator. The simulator's per-action guards remain the
 * source of truth -- this is an optimization, not a correctness mechanism.
 */
export function filterChaosActions<T extends { name: string }>(
  actions: T[],
  state: CssStationStatus,
  connectorStatus: string,
): T[] {
  // A fault in mode 'suspend' keeps the transaction: the station is in a session but
  // its connector is Faulted, so only clearFault (or going offline) applies.
  if (connectorStatus === 'Faulted') {
    return actions.filter(
      (a) => !CHAOS_STATE_MUTATING.has(a.name) || CHAOS_VALID_BY_STATE.faulted.has(a.name),
    );
  }
  if (connectorStatus === 'Finishing') {
    return actions.filter(
      (a) => !CHAOS_STATE_MUTATING.has(a.name) || CHAOS_FINISHING_ACTIONS.has(a.name),
    );
  }
  if (connectorStatus === 'Reserved') {
    return actions.filter(
      (a) => !CHAOS_STATE_MUTATING.has(a.name) || CHAOS_RESERVED_ACTIONS.has(a.name),
    );
  }
  const stateActions = new Set(CHAOS_VALID_BY_STATE[state]);
  if (state === 'available' && CHAOS_PLUGGED_STATUSES.has(connectorStatus)) {
    stateActions.add('startCharging');
    stateActions.add('unplug');
  }
  return actions.filter((a) => !CHAOS_STATE_MUTATING.has(a.name) || stateActions.has(a.name));
}

// Actions available for all OCPP versions
const GLOBAL_ACTIONS: Array<{
  name: string;
  params: (tokens: DriverToken[]) => Record<string, unknown>;
}> = [
  { name: 'plugIn', params: () => ({ evseId: 1 }) },
  {
    name: 'authorize',
    params: (tokens) => {
      const t = pick(tokens);
      return { evseId: 1, idToken: t.idToken, tokenType: t.tokenType };
    },
  },
  {
    name: 'startCharging',
    params: (tokens) => {
      const t = pick(tokens);
      return { evseId: 1, idToken: t.idToken, tokenType: t.tokenType };
    },
  },
  {
    name: 'stopCharging',
    params: () => ({
      evseId: 1,
      reason: pick(['Local', 'Remote', 'EVDisconnected']),
    }),
  },
  { name: 'unplug', params: () => ({ evseId: 1 }) },
  { name: 'clearFault', params: () => ({ evseId: 1 }) },
  // Idle periods inside a session: the EV or the EVSE stops the energy transfer
  {
    name: 'suspendCharging',
    params: () => ({ evseId: 1, by: pick(['EV', 'EVSE']) }),
  },
  { name: 'resumeCharging', params: () => ({ evseId: 1 }) },
  { name: 'sendHeartbeat', params: () => ({}) },
  { name: 'sendMeterValues', params: () => ({ evseId: 1 }) },
  {
    name: 'sendFirmwareStatusNotification',
    params: () => ({
      status: pick(['Downloading', 'Downloaded', 'Installing', 'Installed', 'Idle']),
    }),
  },
  {
    name: 'sendDataTransfer',
    params: () => ({
      vendorId: 'EVtivity',
      messageId: 'test',
      data: JSON.stringify({ ts: Date.now() }),
    }),
  },
];

// Actions available only for OCPP 2.1
const OCPP21_ACTIONS: Array<{
  name: string;
  params: (tokens: DriverToken[]) => Record<string, unknown>;
}> = [
  // OCPP 2.1 injectFault: no errorCode field on StatusNotification; the error code picks
  // the stop reason when the fault ends the session (GroundFault, OvercurrentFault, Other)
  {
    name: 'injectFault',
    params: () => ({
      evseId: 1,
      errorCode: pick(['GroundFailure', 'OverCurrentFailure', 'InternalError']),
      mode: pick(['end', 'suspend']),
    }),
  },
  // OCPP 2.1 sendBootNotification has reason field
  {
    name: 'sendBootNotification',
    params: () => ({ reason: pick(['PowerUp', 'Watchdog', 'RemoteReset', 'ScheduledReset']) }),
  },
  // OCPP 2.1 connectorStatus: Available, Occupied, Reserved, Unavailable, Faulted
  {
    name: 'sendStatusNotification',
    params: () => ({
      evseId: 1,
      connectorId: 1,
      status: pick(['Available', 'Occupied', 'Faulted', 'Unavailable']),
    }),
  },
  {
    name: 'sendSecurityEventNotification',
    params: () => ({
      type: pick(['FirmwareUpdated', 'SettingSystemTime', 'MemoryExhaustion']),
      timestamp: new Date().toISOString(),
    }),
  },
  {
    name: 'sendNotifyEvent',
    params: () => ({
      generatedAt: new Date().toISOString(),
      seqNo: 0,
      eventData: [
        {
          eventId: 1,
          timestamp: new Date().toISOString(),
          trigger: 'Alerting',
          actualValue: 'true',
          component: { name: 'Connector' },
          variable: { name: 'Available' },
          eventNotificationType: 'HardWiredNotification',
        },
      ],
    }),
  },
  { name: 'sendNotifyReport', params: () => ({ requestId: 1 }) },
  {
    name: 'sendNotifyMonitoringReport',
    params: () => ({
      requestId: 1,
      seqNo: 0,
      generatedAt: new Date().toISOString(),
    }),
  },
  {
    name: 'sendNotifyChargingLimit',
    params: () => ({
      chargingLimit: { chargingLimitSource: 'CSO' },
    }),
  },
  {
    name: 'sendNotifyEVChargingNeeds',
    params: () => ({
      evseId: 1,
      chargingNeeds: { requestedEnergyTransfer: 'AC_single_phase' },
    }),
  },
  {
    name: 'sendClearedChargingLimit',
    params: () => ({ chargingLimitSource: 'CSO' }),
  },
  { name: 'sendNotifyDisplayMessages', params: () => ({ requestId: 1 }) },
  {
    name: 'sendNotifyCustomerInformation',
    params: () => ({
      requestId: 1,
      data: 'Customer data: simulated station user info',
      seqNo: 0,
      generatedAt: new Date().toISOString(),
    }),
  },
  {
    name: 'sendSignCertificate',
    params: () => ({ csr: 'simulated-csr-data', certificateType: 'ChargingStationCertificate' }),
  },
  {
    name: 'sendGetCertificateStatus',
    params: () => ({
      ocspRequestData: {
        hashAlgorithm: 'SHA256',
        issuerNameHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        issuerKeyHash: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
        serialNumber: '01',
        responderURL: 'http://ocsp.example.com',
      },
    }),
  },
  { name: 'sendGetTransactionStatus', params: () => ({}) },
  {
    name: 'sendReportChargingProfiles',
    params: () => ({
      requestId: 1,
      chargingLimitSource: 'CSO',
      evseId: 1,
      chargingProfile: [
        {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxDefaultProfile',
          chargingProfileKind: 'Relative',
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'W',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 11000 }],
            },
          ],
        },
      ],
    }),
  },
  {
    name: 'sendNotifyEVChargingSchedule',
    params: () => ({
      timeBase: new Date().toISOString(),
      evseId: 1,
      chargingSchedule: {
        id: 1,
        chargingRateUnit: 'W',
        chargingSchedulePeriod: [{ startPeriod: 0, limit: 11000 }],
      },
    }),
  },
  {
    name: 'sendNotifySettlement',
    params: () => ({
      pspRef: 'SIM-PSP-001',
      status: 'Settled',
      settlementAmount: 25.0,
      settlementTime: new Date().toISOString(),
    }),
  },
  {
    name: 'sendNotifyPriorityCharging',
    params: () => ({ transactionId: 'sim-tx-001', activated: true }),
  },
  {
    name: 'sendNotifyAllowedEnergyTransfer',
    params: () => ({
      transactionId: 'sim-tx-001',
      allowedEnergyTransfer: ['AC_single_phase', 'AC_three_phase'],
    }),
  },
  {
    name: 'sendLogStatusNotification',
    params: () => ({ status: pick(['Idle', 'Uploaded', 'UploadFailure', 'Uploading']) }),
  },
  {
    name: 'sendReservationStatusUpdate',
    params: () => ({
      reservationId: 1,
      reservationUpdateStatus: pick(['Expired', 'Removed', 'NoTransaction']),
    }),
  },
  {
    name: 'sendGet15118EVCertificate',
    params: () => ({
      iso15118SchemaVersion: '15118-20:2022',
      action: 'Install',
      exiRequest: 'simulated-exi-data',
    }),
  },
  {
    name: 'sendGetCertificateChainStatus',
    params: () => ({
      certificateStatusRequests: [
        {
          source: 'OCSP',
          urls: ['http://ocsp.example.com'],
          certificateHashData: {
            hashAlgorithm: 'SHA256',
            issuerNameHash: 'a1b2c3d4e5f6',
            issuerKeyHash: 'b2c3d4e5f6a1',
            serialNumber: '01',
          },
        },
      ],
    }),
  },
  {
    name: 'sendPublishFirmwareStatusNotification',
    params: () => ({ status: pick(['Idle', 'Published', 'PublishFailed']) }),
  },
  {
    name: 'sendNotifyPeriodicEventStream',
    params: () => ({
      id: 1,
      pending: 0,
      basetime: new Date().toISOString(),
      data: [
        { t: 0, v: '1.0' },
        { t: 1, v: '2.0' },
      ],
    }),
  },
  {
    name: 'sendNotifyDERAlarm',
    params: () => ({
      controlType: 'EnterService',
      timestamp: new Date().toISOString(),
      alarmEnded: false,
    }),
  },
  {
    name: 'sendNotifyDERStartStop',
    params: () => ({
      controlId: 'sim-der-ctrl-001',
      started: true,
      timestamp: new Date().toISOString(),
    }),
  },
  {
    name: 'sendReportDERControl',
    params: () => ({
      requestId: 1,
    }),
  },
  {
    name: 'sendBatterySwap',
    params: () => ({
      eventType: pick(['BatteryIn', 'BatteryOut']),
      requestId: Math.floor(Math.random() * 1000),
      idToken: { idToken: 'SIM-SWAP-001', type: 'ISO14443' },
      batteryData: [
        { evseId: 1, serialNumber: `BAT-${String(Date.now()).slice(-6)}`, soC: 45, soH: 98 },
      ],
    }),
  },
  {
    name: 'sendPullDynamicScheduleUpdate',
    params: () => ({ chargingProfileId: 1 }),
  },
  {
    name: 'sendVatNumberValidation',
    params: () => ({ vatNumber: 'NL123456789B01', evseId: 1 }),
  },
];

// Actions available only for OCPP 1.6
const OCPP16_ACTIONS: Array<{
  name: string;
  params: (tokens: DriverToken[]) => Record<string, unknown>;
}> = [
  {
    name: 'sendDiagnosticsStatusNotification',
    params: () => ({ status: pick(['Idle', 'Uploaded', 'UploadFailed']) }),
  },
  // OCPP 1.6 injectFault: all 15 error codes from the 1.6 enum (excluding NoError)
  {
    name: 'injectFault',
    params: () => ({
      evseId: 1,
      errorCode: pick([
        'ConnectorLockFailure',
        'EVCommunicationError',
        'GroundFailure',
        'HighTemperature',
        'InternalError',
        'LocalListConflict',
        'OtherError',
        'OverCurrentFailure',
        'PowerMeterFailure',
        'PowerSwitchFailure',
        'ReaderFailure',
        'ResetFailure',
        'UnderVoltage',
        'OverVoltage',
        'WeakSignal',
      ]),
      mode: pick(['end', 'suspend']),
    }),
  },
  // OCPP 1.6 sendBootNotification: no reason field
  { name: 'sendBootNotification', params: () => ({}) },
  // OCPP 1.6 statuses: Available, Preparing, Charging, SuspendedEVSE, SuspendedEV, Finishing, Reserved, Unavailable, Faulted
  {
    name: 'sendStatusNotification',
    params: () => ({
      evseId: 1,
      connectorId: 1,
      status: pick(['Available', 'Charging', 'Faulted', 'Unavailable', 'SuspendedEV', 'Preparing']),
    }),
  },
];

const REFRESH_INTERVAL_MS = 30_000;

// Share of ticks that take a due session step instead of a random action.
const JOURNEY_TICK_SHARE = 0.5;

export class ChaosOrchestrator {
  private readonly sql: postgres.Sql;
  private readonly pubsub: PubSubClient;
  private readonly actionIntervalMs: number;
  private readonly stationLimit: number;
  private actionTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private stationIds: string[] = [];
  private tokens: DriverToken[] = [];
  private stationProtocols: Map<string, 'ocpp1.6' | 'ocpp2.1'> = new Map();
  private offlineStations: Set<string> = new Set();
  private chargingStations: Set<string> = new Set();
  private chargingTokenByStation: Map<string, string> = new Map();
  private readonly journeys = new ChaosJourneys();

  constructor(
    sql: postgres.Sql,
    pubsub: PubSubClient,
    options?: {
      actionIntervalMs?: number;
      stationLimit?: number;
    },
  ) {
    this.sql = sql;
    this.pubsub = pubsub;
    this.actionIntervalMs = options?.actionIntervalMs ?? 1000;
    this.stationLimit = options?.stationLimit ?? 0;
  }

  // Loads the current set of action targets from the DB and replaces the
  // in-memory caches. Stations added at runtime (dashboard toggle, POST
  // /v1/css/stations) appear here on the next call; rows that were deleted
  // or had enabled flipped to false drop out. State for stations that
  // disappeared (offline marker, active-tx markers) is cleared to avoid
  // confusing later dispatch ticks.
  private async loadStations(): Promise<{
    stations: Array<{ station_id: string; ocpp_protocol: string }>;
    tokens: DriverToken[];
  }> {
    const stationRows = await this.sql<Array<{ station_id: string; ocpp_protocol: string }>>`
      SELECT cs.station_id, cs.ocpp_protocol
      FROM charging_stations cs
      INNER JOIN css_stations css ON css.station_id = cs.station_id
      WHERE cs.is_simulator = true AND css.enabled = true
    `;
    let stations = [...stationRows];
    if (this.stationLimit > 0 && stations.length > this.stationLimit) {
      stations = stations.slice(0, this.stationLimit);
    }
    // The OCTT runner's tokens belong to its run: a chaos session with one
    // would take a token a conformance test is using and keep the run's driver
    // and tariff referenced, so the run's cleanup could not delete them.
    const tokens = (
      await this.sql<Array<{ id_token: string; token_type: string }>>`
        SELECT t.id_token, t.token_type FROM driver_tokens t
        WHERE t.is_active = true
          AND NOT EXISTS (
            SELECT 1 FROM drivers d
            WHERE d.id = t.driver_id AND d.email = ${OCTT_TEST_DRIVER_EMAIL}
          )
      `
    ).map((r) => ({ idToken: r.id_token, tokenType: r.token_type }));
    return { stations, tokens };
  }

  private applyLoaded(
    stations: Array<{ station_id: string; ocpp_protocol: string }>,
    tokens: DriverToken[],
  ): void {
    const liveIds = new Set(stations.map((s) => s.station_id));

    this.stationIds = stations.map((s) => s.station_id);
    this.stationProtocols.clear();
    for (const station of stations) {
      this.stationProtocols.set(
        station.station_id,
        station.ocpp_protocol === 'ocpp1.6' ? 'ocpp1.6' : 'ocpp2.1',
      );
    }

    // Drop in-flight markers for stations that are no longer in the DB; the
    // SimulatorManager has already removed those simulators, so any state we
    // hold for them is stale.
    for (const id of [...this.offlineStations]) {
      if (!liveIds.has(id)) this.offlineStations.delete(id);
    }
    for (const id of [...this.chargingStations]) {
      if (!liveIds.has(id)) this.chargingStations.delete(id);
    }
    for (const id of [...this.chargingTokenByStation.keys()]) {
      if (!liveIds.has(id)) this.chargingTokenByStation.delete(id);
    }
    this.journeys.retain(liveIds);

    this.tokens = tokens;
  }

  async start(): Promise<void> {
    // css_stations rows are owned by the seed scripts (db:seed, db:seed:dev)
    // and migration 0001 -- plus any added at runtime via the dashboard
    // simulator toggle or POST /v1/css/stations. The orchestrator just reads
    // them to populate its in-memory action targets; no INSERT mirroring.
    const { stations, tokens } = await this.loadStations();
    this.applyLoaded(stations, tokens);

    console.log(
      `[chaos] Loaded ${String(stations.length)} stations and ${String(this.tokens.length)} tokens`,
    );

    // Start action timer
    this.actionTimer = setInterval(() => void this.dispatchRandomAction(), this.actionIntervalMs);

    // Periodically re-sync station targets so simulators created/deleted
    // after start are picked up without a CSS restart. Matches the
    // SimulatorManager's 5s poll-on-css_stations behavior (slower cadence
    // here because chaos targets are read at every dispatch tick anyway).
    this.refreshTimer = setInterval(() => {
      void (async (): Promise<void> => {
        try {
          const loaded = await this.loadStations();
          this.applyLoaded(loaded.stations, loaded.tokens);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`[chaos] Refresh failed: ${msg}`);
        }
      })();
    }, REFRESH_INTERVAL_MS);

    console.log(
      `[chaos] Started action timer (${String(this.actionIntervalMs)}ms interval, ${String(this.stationIds.length)} stations)`,
    );
  }

  stop(): void {
    if (this.actionTimer != null) {
      clearInterval(this.actionTimer);
      this.actionTimer = null;
    }
    if (this.refreshTimer != null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // Remove a single station from in-memory caches. Used when a dispatch tick
  // discovers the css_stations row was deleted or disabled between refreshes.
  private dropStation(stationId: string): void {
    this.stationIds = this.stationIds.filter((id) => id !== stationId);
    this.stationProtocols.delete(stationId);
    this.offlineStations.delete(stationId);
    this.chargingStations.delete(stationId);
    this.chargingTokenByStation.delete(stationId);
    this.journeys.drop(stationId);
  }

  private async dispatchRandomAction(): Promise<void> {
    if (this.stationIds.length === 0) return;

    const due = Math.random() < JOURNEY_TICK_SHARE ? this.journeys.nextDue(Date.now()) : null;
    const stationId = due?.stationId ?? pick(this.stationIds);
    const protocol = this.stationProtocols.get(stationId) ?? 'ocpp1.6';

    // If station is offline, bring it back online
    if (this.offlineStations.has(stationId)) {
      this.offlineStations.delete(stationId);
      console.log(`[chaos] ${stationId} -> comeOnline (power restored)`);
      try {
        await this.pubsub.publish(
          'css_commands',
          JSON.stringify({ commandId: randomUUID(), stationId, action: 'comeOnline', params: {} }),
        );
      } catch (err) {
        logger.warn(
          { err, stationId, action: 'comeOnline' },
          'Publish of the chaos command failed',
        );
      }
      return;
    }

    // ~2% chance of power outage simulation
    if (due == null && Math.random() < 0.02) {
      this.offlineStations.add(stationId);
      // Ends only a journey that has not started charging: the simulator keeps
      // its transaction through the outage, so a session still gets its stop.
      this.journeys.record(stationId, 'goOffline', Date.now());
      console.log(`[chaos] ${stationId} -> goOffline (power outage simulation)`);
      try {
        await this.pubsub.publish(
          'css_commands',
          JSON.stringify({ commandId: randomUUID(), stationId, action: 'goOffline', params: {} }),
        );
      } catch (err) {
        logger.warn({ err, stationId, action: 'goOffline' }, 'Publish of the chaos command failed');
      }
      return;
    }

    // Build action list based on protocol
    let actions = [...GLOBAL_ACTIONS];
    if (protocol === 'ocpp2.1') {
      actions = [...actions, ...OCPP21_ACTIONS];
    } else {
      actions = [...actions, ...OCPP16_ACTIONS];
    }

    // State-aware action filter. Read css_stations.status, the connector
    // status, and active-transaction existence in one query, then call the
    // pure filterChaosActions() helper. The simulator's per-action guards are
    // the correctness floor; this filter just stops chaos from wasting ticks
    // on actions that would no-op.
    let stationStatus: CssStationStatus = 'available';
    let connectorStatus = 'Available';
    let hasActiveTx = this.chargingStations.has(stationId);
    try {
      const rows = await this.sql<
        Array<{ status: string; evse_status: string | null; has_tx: boolean }>
      >`
        SELECT s.status,
               e.status AS evse_status,
               EXISTS (
                 SELECT 1 FROM css_transactions t
                 WHERE t.css_station_id = s.id AND t.status = 'active'
               ) AS has_tx
        FROM css_stations s
        LEFT JOIN css_evses e ON e.css_station_id = s.id AND e.evse_id = 1
        WHERE s.station_id = ${stationId} AND s.enabled = true
        LIMIT 1
      `;
      const row = rows[0];
      if (row == null) {
        // The css_stations row was deleted or disabled after our last
        // refresh. Drop it from in-memory targets so we don't publish
        // commands the SimulatorManager will silently drop, and skip this
        // tick. The next periodic refresh will reconcile fully.
        this.dropStation(stationId);
        return;
      }
      stationStatus = row.status as CssStationStatus;
      connectorStatus = row.evse_status ?? 'Available';
      hasActiveTx = row.has_tx || hasActiveTx;
    } catch (err) {
      logger.warn({ err, stationId }, 'Load station state failed, using the default state');
    }

    // Treat charging-or-active-transaction as the same effective state.
    // css_stations.status updates lag for sessions started by the dashboard
    // or guest portal; the active-tx existence check catches those.
    const effectiveState: CssStationStatus = hasActiveTx ? 'charging' : stationStatus;

    actions = filterChaosActions(actions, effectiveState, connectorStatus);

    // Drop token-requiring actions when no driver tokens are loaded. With
    // SEED_DEMO=false there are no driver tokens in the dev fixture, so
    // authorize/startCharging would crash on `pick(this.tokens)` returning
    // undefined. startCharging has its own empty-tokens guard below; this
    // filter keeps authorize from getting selected at all.
    if (this.tokens.length === 0) {
      actions = actions.filter((a) => a.name !== 'authorize' && a.name !== 'startCharging');
    }

    let action: (typeof actions)[number] | undefined;
    if (due != null) {
      action = actions.find((a) => a.name === due.action);
      if (action == null) {
        // The station already started the transaction itself, or it left the
        // session path (fault, unplug, stop by an operator).
        this.journeys.skipDue(stationId, due.action, hasActiveTx, Date.now());
        return;
      }
    } else {
      if (actions.length === 0) {
        // No valid action for this state this tick.
        return;
      }
      action = pick(actions);
    }
    let params: Record<string, unknown>;

    if (action.name === 'startCharging') {
      // Pick a token that does not already have an active session
      const busy = new Set(this.chargingTokenByStation.values());
      const available = this.tokens.filter((t) => !busy.has(t.idToken));
      if (available.length === 0) {
        return; // All drivers are charging, skip
      }
      const t = pick(available);
      params = { evseId: 1, idToken: t.idToken, tokenType: t.tokenType };
      this.chargingStations.add(stationId);
      this.chargingTokenByStation.set(stationId, t.idToken);
    } else {
      params = action.params(this.tokens);
      if (action.name === 'stopCharging' || action.name === 'unplug') {
        this.chargingStations.delete(stationId);
        this.chargingTokenByStation.delete(stationId);
      }
    }

    console.log(`[chaos] ${stationId} -> ${action.name}`);

    try {
      // Publish command directly to Redis css_commands channel
      await this.pubsub.publish(
        'css_commands',
        JSON.stringify({
          commandId: randomUUID(),
          stationId,
          action: action.name,
          params,
        }),
      );
      this.journeys.record(stationId, action.name, Date.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[chaos] ${stationId} -> ${action.name} failed: ${message}`);
    }
  }
}
