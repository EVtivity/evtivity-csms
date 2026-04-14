// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { PubSubClient } from '@evtivity/lib';

interface CsmsStation {
  stationId: string;
  securityProfile: number;
  ocppProtocol: 'ocpp1.6' | 'ocpp2.1';
}

interface DriverToken {
  idToken: string;
  tokenType: string;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
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
  // OCPP 2.1 injectFault: no errorCode field on StatusNotification
  {
    name: 'injectFault',
    params: () => ({ evseId: 1, errorCode: 'InternalError' }),
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
  { name: 'sendNotifyQRCodeScanned', params: () => ({ evseId: 1, timeout: 60 }) },
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
    name: 'sendNotifyWebPaymentStarted',
    params: () => ({ evseId: 1, timeout: 300 }),
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

export class ChaosOrchestrator {
  private readonly sql: postgres.Sql;
  private readonly pubsub: PubSubClient;
  private readonly actionIntervalMs: number;
  private readonly stationLimit: number;
  private readonly serverUrl: string;
  private readonly tlsServerUrl: string;
  private readonly password: string;
  private readonly clientCert: string | null;
  private readonly clientKey: string | null;
  private readonly caCert: string | null;
  private actionTimer: ReturnType<typeof setInterval> | null = null;
  private stationIds: string[] = [];
  private tokens: DriverToken[] = [];
  private stationProtocols: Map<string, 'ocpp1.6' | 'ocpp2.1'> = new Map();
  private offlineStations: Set<string> = new Set();
  private chargingStations: Set<string> = new Set();
  private chargingTokens: Set<string> = new Set();

  constructor(
    sql: postgres.Sql,
    pubsub: PubSubClient,
    options?: {
      actionIntervalMs?: number;
      stationLimit?: number;
      serverUrl?: string;
      tlsServerUrl?: string;
      password?: string;
      clientCert?: string;
      clientKey?: string;
      caCert?: string;
    },
  ) {
    this.sql = sql;
    this.pubsub = pubsub;
    this.actionIntervalMs = options?.actionIntervalMs ?? 1000;
    this.stationLimit = options?.stationLimit ?? 0;
    this.serverUrl = options?.serverUrl ?? 'ws://localhost:7103';
    this.tlsServerUrl = options?.tlsServerUrl ?? 'wss://localhost:8443';
    this.password = options?.password ?? 'password';
    this.clientCert = options?.clientCert ?? null;
    this.clientKey = options?.clientKey ?? null;
    this.caCert = options?.caCert ?? null;
  }

  async start(): Promise<void> {
    // Load CSMS stations
    const stationRows = await this.sql<
      Array<{ station_id: string; security_profile: number; ocpp_protocol: string }>
    >`
      SELECT station_id, security_profile, ocpp_protocol
      FROM charging_stations
      WHERE is_simulator = true
    `;

    let stations = [...stationRows];
    if (this.stationLimit > 0 && stations.length > this.stationLimit) {
      stations = stations.slice(0, this.stationLimit);
    }

    // Load driver tokens
    this.tokens = (
      await this.sql<Array<{ id_token: string; token_type: string }>>`
        SELECT id_token, token_type FROM driver_tokens WHERE is_active = true
      `
    ).map((r) => ({ idToken: r.id_token, tokenType: r.token_type }));

    console.log(
      `[chaos] Loaded ${String(stations.length)} stations and ${String(this.tokens.length)} tokens`,
    );

    // Create CSS station records directly in the database
    for (const station of stations) {
      const csmsStation: CsmsStation = {
        stationId: station.station_id,
        securityProfile: station.security_profile,
        ocppProtocol: station.ocpp_protocol === 'ocpp1.6' ? 'ocpp1.6' : 'ocpp2.1',
      };
      await this.createCssStation(csmsStation);
    }

    // Start action timer
    this.actionTimer = setInterval(() => void this.dispatchRandomAction(), this.actionIntervalMs);
    console.log(
      `[chaos] Started action timer (${String(this.actionIntervalMs)}ms interval, ${String(this.stationIds.length)} stations)`,
    );
  }

  stop(): void {
    if (this.actionTimer != null) {
      clearInterval(this.actionTimer);
      this.actionTimer = null;
    }
  }

  private async createCssStation(station: CsmsStation): Promise<void> {
    const requiresTls = station.securityProfile >= 2;
    const targetUrl = requiresTls ? this.tlsServerUrl : this.serverUrl;

    try {
      // Insert directly into css_stations (ON CONFLICT skip for idempotency)
      const serialNumber = `SN-${station.stationId}`;
      const isSp3 = station.securityProfile === 3;
      await this.sql`
        INSERT INTO css_stations (
          id, station_id, ocpp_protocol, security_profile, target_url,
          password, vendor_name, model, serial_number, firmware_version,
          client_cert, client_key, ca_cert,
          source_type, enabled
        ) VALUES (
          ${'css_' + randomUUID().replace(/-/g, '').slice(0, 12)},
          ${station.stationId},
          ${station.ocppProtocol},
          ${station.securityProfile},
          ${targetUrl},
          ${isSp3 ? null : this.password},
          ${'EVtivity'},
          ${'CSS-1000'},
          ${serialNumber},
          ${'1.0.0'},
          ${isSp3 ? this.clientCert : null},
          ${isSp3 ? this.clientKey : null},
          ${requiresTls ? this.caCert : null},
          ${'chaos'},
          ${true}
        ) ON CONFLICT (station_id) DO NOTHING
      `;

      // Get the css_station ID (may already exist)
      const rows = await this.sql<Array<{ id: string }>>`
        SELECT id FROM css_stations WHERE station_id = ${station.stationId} LIMIT 1
      `;
      const cssStationId = rows[0]?.id;
      if (cssStationId == null) return;

      // Insert default EVSE (ON CONFLICT skip)
      await this.sql`
        INSERT INTO css_evses (
          id, css_station_id, evse_id, connector_id, connector_type, max_power_w, phases, voltage
        ) VALUES (
          ${'cev_' + randomUUID().replace(/-/g, '').slice(0, 12)},
          ${cssStationId},
          ${1},
          ${1},
          ${'ac_type2'},
          ${22000},
          ${3},
          ${230}
        ) ON CONFLICT (css_station_id, evse_id, connector_id) DO NOTHING
      `;

      this.stationIds.push(station.stationId);
      this.stationProtocols.set(station.stationId, station.ocppProtocol);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[chaos] Failed to create station ${station.stationId}: ${message}`);
    }
  }

  private async dispatchRandomAction(): Promise<void> {
    if (this.stationIds.length === 0) return;

    const stationId = pick(this.stationIds);
    const protocol = this.stationProtocols.get(stationId) ?? 'ocpp2.1';

    // If station is offline, bring it back online
    if (this.offlineStations.has(stationId)) {
      this.offlineStations.delete(stationId);
      console.log(`[chaos] ${stationId} -> comeOnline (power restored)`);
      try {
        await this.pubsub.publish(
          'css_commands',
          JSON.stringify({ commandId: randomUUID(), stationId, action: 'comeOnline', params: {} }),
        );
      } catch {
        // Ignore errors
      }
      return;
    }

    // ~2% chance of power outage simulation
    if (Math.random() < 0.02) {
      this.offlineStations.add(stationId);
      console.log(`[chaos] ${stationId} -> goOffline (power outage simulation)`);
      try {
        await this.pubsub.publish(
          'css_commands',
          JSON.stringify({ commandId: randomUUID(), stationId, action: 'goOffline', params: {} }),
        );
      } catch {
        // Ignore errors
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

    // Filter out startCharging if station already has an active transaction
    if (this.chargingStations.has(stationId)) {
      actions = actions.filter((a) => a.name !== 'startCharging');
    }

    const action = pick(actions);
    let params: Record<string, unknown>;

    if (action.name === 'startCharging') {
      // Pick a token that does not already have an active session
      const available = this.tokens.filter((t) => !this.chargingTokens.has(t.idToken));
      if (available.length === 0) {
        return; // All drivers are charging, skip
      }
      const t = pick(available);
      params = { evseId: 1, idToken: t.idToken, tokenType: t.tokenType };
      this.chargingStations.add(stationId);
      this.chargingTokens.add(t.idToken);
    } else {
      params = action.params(this.tokens);
      if (action.name === 'stopCharging' || action.name === 'unplug') {
        this.chargingStations.delete(stationId);
        // Remove token from charging set (find by station's last used token)
        const idToken = params['idToken'] as string | undefined;
        if (idToken != null) {
          this.chargingTokens.delete(idToken);
        }
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[chaos] ${stationId} -> ${action.name} failed: ${message}`);
    }
  }
}
