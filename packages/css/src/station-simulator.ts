// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { OcppClient } from './ocpp-client.js';
import { MeterValueGenerator } from './meter-value-generator.js';

export interface StationConfig {
  id: string;
  stationId: string;
  ocppProtocol: 'ocpp1.6' | 'ocpp2.1';
  securityProfile: number;
  targetUrl: string;
  password?: string;
  vendorName: string;
  model: string;
  serialNumber: string;
  firmwareVersion: string;
  clientCert?: string;
  clientKey?: string;
  caCert?: string;
  evses: Array<{
    evseId: number;
    connectorId: number;
    connectorType: 'ac_type2' | 'ac_type1' | 'dc_ccs2' | 'dc_ccs1' | 'dc_chademo';
    maxPowerW: number;
    phases: number;
    voltage: number;
  }>;
}

interface Reservation {
  id: number;
  evseId: number;
  idToken: string;
  groupIdToken?: string | undefined;
  connectorType?: string | undefined;
  expiryDateTime: string;
  expiryTimer: ReturnType<typeof setTimeout>;
}

interface EvseContext {
  state: string;
  authorizedToken: string | null;
  authorizedTokenType: string | null;
  transactionId: string | null;
  remoteStartId: number | null;
  cablePlugged: boolean;
}

export class StationSimulator {
  readonly client: OcppClient;
  private readonly config: StationConfig;
  private readonly sql: postgres.Sql;
  private readonly meterGens = new Map<number, MeterValueGenerator>();
  private readonly meterTimers = new Map<number, ReturnType<typeof setInterval>>();
  private readonly reservations = new Map<number, Reservation>();
  private readonly reservationTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly evseContexts = new Map<number, EvseContext>();

  // In-memory config variable cache
  private configVariables = new Map<string, { value: string; readonly: boolean }>();
  private configLoaded = false;

  // Heartbeat
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // ConnectionTimeOut timers per EVSE (1.6 authorize-without-cable)
  private readonly connectionTimeoutTimers = new Map<number, ReturnType<typeof setTimeout>>();
  // OCPP 2.1 EVConnectionTimeout timers per EVSE (remote start without cable)
  private readonly evConnectTimeoutTimers = new Map<number, ReturnType<typeof setTimeout>>();

  // Per-EVSE charging state
  private readonly evsePowerLimits = new Map<number, number | null>();
  private readonly evseIdle = new Map<number, boolean>();
  private readonly evseChargingState = new Map<number, string | null>();
  private readonly evseSeqNo = new Map<number, number>();
  private readonly evseMeterTick = new Map<number, number>();
  private readonly evseConnectorStatus = new Map<number, string>();

  // Clock-aligned meter value timer
  private clockAlignedTimer: ReturnType<typeof setInterval> | null = null;

  // Station-level state
  private availabilityState = 'Operative';
  private bootStatus: 'Accepted' | 'Pending' | 'Rejected' | null = null;
  private pendingReset: string | null = null;
  private destroyed = false;
  private offlineFlag = false;
  private readonly offlineMessageQueue: Array<{
    action: string;
    payload: Record<string, unknown>;
  }> = [];
  private localAuthListVersion = 0;
  private readonly localAuthEntries = new Map<string, Record<string, unknown>>();

  // Preserved transactions for power cycle resume (OCPP 2.1)
  private preservedTransactions = new Map<
    number,
    { transactionId: string; idToken: string; tokenType: string; powerLossTime: number }
  >();

  // Authorization cache (Feature 2): token value -> idTokenInfo from CSMS
  private readonly authCache = new Map<string, Record<string, unknown>>();

  // Group ID mapping (Feature 3): token value -> groupIdToken object
  private readonly tokenGroupMap = new Map<string, Record<string, unknown>>();

  // Track start token per transaction (Feature 3): txId -> { idToken, groupIdToken }
  private readonly transactionStartTokens = new Map<
    string,
    { idToken: string; groupIdToken: Record<string, unknown> | null }
  >();

  // Master pass group ID (Feature 4): set when authorize returns a groupIdToken
  private masterPassGroupId: string | null = null;

  // Track current log and firmware upload status for TriggerMessage
  private logUploadStatus: string = 'Idle';
  private firmwareUpdateStatus: string = 'Idle';

  // Custom triggers support
  private readonly customTriggers: string[] = ['DiagnosticsLog', 'SecurityAudit'];

  // Variable monitoring state
  private monitorIdCounter = 0;
  private readonly variableMonitors = new Map<
    number,
    {
      id: number;
      type: string;
      severity: number;
      component: Record<string, unknown>;
      variable: Record<string, unknown>;
      isHardwired: boolean;
    }
  >();
  private monitoringLevel = 9; // default: report all severities (0-9)

  // Active log upload tracking
  private activeLogUploadRequestId: number | null = null;

  // Customer data store (simulated)
  private readonly customerDataStore = new Map<string, string>();

  // In-memory stores for CSMS command simulation
  private readonly displayMessagesCache = new Map<number, Record<string, unknown>>();
  private readonly installedCertificatesCache = new Map<
    string,
    { certificateType: string; certificateHashData: Record<string, string> }
  >();
  private readonly chargingProfilesCache = new Map<number, Record<string, unknown>>();

  // Tariff store: tariffId -> { evseId, tariff data, inUse }
  private readonly defaultTariffs = new Map<
    string,
    { evseId: number; tariff: Record<string, unknown>; inUse: boolean }
  >();
  // Track transaction currency: transactionId -> currency
  private readonly transactionTariffCurrency = new Map<string, string>();
  // Per-EVSE driver tariff received from AuthorizeResponse (OCPP 2.1)
  private readonly driverTariffs = new Map<
    number,
    { tariffId: string; tariff: Record<string, unknown> }
  >();

  // Per-EVSE transaction limit state (OCPP 2.1)
  private readonly evseTransactionLimits = new Map<
    number,
    { maxEnergy?: number; maxTime?: number; maxCost?: number }
  >();
  // Per-EVSE CSMS-provided running totalCost
  private readonly evseTotalCost = new Map<number, number>();
  // Per-EVSE transaction start time (for time limit tracking)
  private readonly evseTransactionStartTime = new Map<number, number>();
  // Per-EVSE flag to prevent duplicate limit-reached events
  private readonly evseLimitReached = new Map<number, boolean>();
  // Per-EVSE snapshot of last-reported driver-set limits (for change detection)
  private readonly evseLastDriverLimits = new Map<
    number,
    { maxEnergy?: number; maxTime?: number; maxCost?: number } | null
  >();
  // Per-EVSE last reported local cost (for RunningCost event dedup)
  private readonly evseLastLocalCost = new Map<number, number>();

  constructor(config: StationConfig, sql: postgres.Sql) {
    this.config = config;
    this.sql = sql;

    this.client = new OcppClient({
      serverUrl: config.targetUrl,
      stationId: config.stationId,
      ocppProtocol: config.ocppProtocol,
      password: config.password,
      securityProfile: config.securityProfile,
      clientCert: config.clientCert,
      clientKey: config.clientKey,
      caCert: config.caCert,
    });

    this.client.setIncomingCallHandler((messageId, action, payload) =>
      this.handleCsmsCommand(messageId, action, payload),
    );

    // Wrap sendCall to track boot status from any BootNotification response,
    // whether sent via sendBootNotification() or raw client.sendCall().
    const originalSendCall = this.client.sendCall.bind(this.client);
    this.client.sendCall = async (action: string, payload: Record<string, unknown>) => {
      const response = await originalSendCall(action, payload);
      if (action === 'BootNotification' && response['status'] != null) {
        this.bootStatus = response['status'] as 'Accepted' | 'Pending' | 'Rejected';
      }
      return response;
    };

    this.client.setConnectedHandler(() => {
      void this.onReconnect();
    });

    this.client.setDisconnectedHandler(() => {
      void this.updateStationStatus('disconnected');
    });

    // Create MeterValueGenerator per EVSE
    for (const evse of config.evses) {
      this.meterGens.set(
        evse.evseId,
        new MeterValueGenerator({
          connectorType: evse.connectorType,
          maxPowerW: evse.maxPowerW,
          phases: evse.phases,
          voltage: evse.voltage,
        }),
      );
      this.evsePowerLimits.set(evse.evseId, null);
      this.evseIdle.set(evse.evseId, false);
      this.evseChargingState.set(evse.evseId, null);
      this.evseSeqNo.set(evse.evseId, 0);
      this.evseMeterTick.set(evse.evseId, 0);
      this.evseTransactionLimits.delete(evse.evseId);
      this.evseTotalCost.delete(evse.evseId);
      this.evseTransactionStartTime.delete(evse.evseId);
      this.evseLimitReached.delete(evse.evseId);
      this.evseLastDriverLimits.delete(evse.evseId);
      this.evseLastLocalCost.delete(evse.evseId);
      this.evseContexts.set(evse.evseId, {
        state: 'Available',
        authorizedToken: null,
        authorizedTokenType: null,
        transactionId: null,
        remoteStartId: null,
        cablePlugged: false,
      });
    }
  }

  get is16(): boolean {
    return this.config.ocppProtocol === 'ocpp1.6';
  }

  get stationId(): string {
    return this.config.stationId;
  }

  get isConnected(): boolean {
    return this.client.isConnected;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    this.destroyed = false;
    this.offlineFlag = false;

    await this.loadConfigVariables();
    await this.client.connect();
    await this.updateStationStatus('booting');
    await this.sendBootNotification('PowerUp');

    // Only send StatusNotification and transition to Available if boot was Accepted.
    // For Pending/Rejected, the retry timer will handle re-boot and status after Accepted.
    if (this.bootStatus !== 'Accepted') return;

    for (const evse of this.config.evses) {
      const ctx = this.evseContexts.get(evse.evseId) as EvseContext;
      ctx.state = 'Available';
      ctx.cablePlugged = false;
      ctx.authorizedToken = null;
      ctx.authorizedTokenType = null;
      ctx.transactionId = null;
      ctx.remoteStartId = null;
      this.evseConnectorStatus.set(evse.evseId, 'Available');
      await this.sendStatusNotification(evse.evseId, evse.connectorId, 'Available');
      await this.updateEvseStatus(evse.evseId, 'Available');
    }

    await this.updateStationStatus('available');

    // Seed default hardwired monitors (AvailabilityState Delta for ChargingStation and EVSEs)
    if (!this.is16) {
      this.seedDefaultMonitors();
    }

    // Seed customer data store
    this.customerDataStore.set('TEST_TOKEN', 'Customer: Test User, Email: test@example.com');
    this.customerDataStore.set('CUST-001', 'Customer: CUST-001, Account: Active');

    // Start clock-aligned meter value timer
    this.startClockAlignedTimer();
  }

  async stop(): Promise<void> {
    this.destroyed = true;

    // Stop all meter timers
    for (const [evseId] of this.meterTimers) {
      this.stopMeterLoop(evseId);
    }

    this.stopHeartbeat();
    this.stopClockAlignedTimer();

    // Clear connection timeout timers
    for (const evseId of this.connectionTimeoutTimers.keys()) {
      this.cancelConnectionTimeoutTimer(evseId);
    }
    for (const evseId of this.evConnectTimeoutTimers.keys()) {
      this.cancelEvConnectTimeoutTimer(evseId);
    }

    // Clear reservation timers
    for (const r of this.reservations.values()) {
      clearTimeout(r.expiryTimer);
    }
    this.reservations.clear();

    this.client.disconnect();
    await this.updateStationStatus('disconnected');
  }

  // ---------------------------------------------------------------------------
  // Group 1: Driver simulation actions
  // ---------------------------------------------------------------------------

  async plugIn(evseId: number): Promise<void> {
    const ctx = this.evseContexts.get(evseId) as EvseContext;
    ctx.cablePlugged = true;
    this.cancelConnectionTimeoutTimer(evseId);
    this.cancelEvConnectTimeoutTimer(evseId);
    const connectorId = this.getConnectorId(evseId);
    const status = this.is16 ? 'Preparing' : 'Occupied';
    const currentStatus = this.evseConnectorStatus.get(evseId);
    this.evseConnectorStatus.set(evseId, status);
    // Skip duplicate StatusNotification if already in Preparing (from authorize)
    if (currentStatus !== status) {
      try {
        await this.sendStatusNotification(evseId, connectorId, status);
      } catch {
        // Offline - status will be reported on reconnect
      }
    }
    await this.updateEvseStatus(evseId, status);

    // OCPP 2.1: If transaction is suspended (cable was unplugged with
    // StopTxOnEVSideDisconnect=false), resume charging on re-plug.
    if (!this.is16 && ctx.state === 'SuspendedEV' && ctx.transactionId != null) {
      const seqNo1 = (this.evseSeqNo.get(evseId) ?? 0) + 1;
      this.evseSeqNo.set(evseId, seqNo1);
      this.evseChargingState.set(evseId, 'EVConnected');
      await this.sendTransactionEvent(evseId, 'Updated', {
        triggerReason: 'CablePluggedIn',
        transactionId: ctx.transactionId,
        chargingState: 'EVConnected',
        seqNo: seqNo1,
      });
      // Resume charging
      const seqNo2 = seqNo1 + 1;
      this.evseSeqNo.set(evseId, seqNo2);
      this.evseChargingState.set(evseId, 'Charging');
      ctx.state = 'Charging';
      await this.sendTransactionEvent(evseId, 'Updated', {
        triggerReason: 'ChargingStateChanged',
        transactionId: ctx.transactionId,
        chargingState: 'Charging',
        seqNo: seqNo2,
      });
      this.startMeterLoop(evseId);
    } else if (ctx.state === 'Authorized' && ctx.authorizedToken != null) {
      // Auto-start transaction when cable is plugged in after authorization.
      // 1.6: always auto-start (authorize first, then plug in flow)
      // 2.1: only auto-start for remote starts (remoteStartId set)
      //       Local authorize-first flow: test calls startCharging explicitly
      if (this.is16 || ctx.remoteStartId != null) {
        try {
          if (this.is16) {
            await this.beginTransaction(
              evseId,
              ctx.authorizedToken,
              ctx.authorizedTokenType ?? 'ISO14443',
            );
          } else {
            await this.startCharging(
              evseId,
              ctx.authorizedToken,
              ctx.authorizedTokenType ?? 'ISO14443',
              ctx.remoteStartId ?? undefined,
            );
          }
        } catch {
          // May fail if transaction already active
        }
      } else {
        ctx.state = 'Preparing';
      }
    } else {
      ctx.state = 'Preparing';
    }
  }

  async authorize(
    evseId: number,
    idToken: string,
    tokenType: string = 'ISO14443',
  ): Promise<Record<string, unknown>> {
    // OCPP 2.1: DisableRemoteAuthorization means only check local list/cache
    if (!this.is16 && this.getConfigValue('AuthCtrlr.DisableRemoteAuthorization') === 'true') {
      const localEntry = this.localAuthEntries.get(idToken);
      if (localEntry != null) {
        const status = (localEntry['authStatus'] as string | undefined) ?? 'Accepted';
        const statusField = 'idTokenInfo';
        return { [statusField]: { status } };
      }
      const cached = this.authCache.get(idToken);
      if (cached != null) {
        return { idTokenInfo: cached };
      }
      // Token not found locally: reject without contacting CSMS
      return { idTokenInfo: { status: 'Unknown' } };
    }

    const result = await this.sendAuthorize(idToken, tokenType);
    const ctx = this.evseContexts.get(evseId) as EvseContext;

    // Feature 3+4: GroupId and MasterPass stop (2.1 only)
    if (!this.is16) {
      const info = result['idTokenInfo'] as Record<string, unknown> | undefined;
      // Get groupId from CSMS response or from pre-stored tokenGroupMap (local auth / cache)
      let groupId: string | undefined;
      if (info != null && info['status'] === 'Accepted' && info['groupIdToken'] != null) {
        const groupToken = info['groupIdToken'] as Record<string, unknown>;
        groupId = groupToken['idToken'] as string | undefined;
      } else if (info != null && info['status'] === 'Accepted') {
        const storedGroup = this.tokenGroupMap.get(idToken);
        if (storedGroup != null) {
          groupId = storedGroup['idToken'] as string | undefined;
        }
      }
      if (groupId != null) {
        // Check if this is a MasterPass groupId
        const masterPassGroupId = this.getConfigValue('AuthCtrlr.MasterPassGroupId');
        const isMasterPass = masterPassGroupId != null && masterPassGroupId === groupId;

        if (isMasterPass) {
          // MasterPass: stop ALL active transactions
          console.log(
            `[${this.config.stationId}] MasterPass groupId match - stopping all active transactions`,
          );
          for (const evse of this.config.evses) {
            const tx = await this.getActiveTransaction(evse.evseId);
            if (tx != null) {
              await this.stopCharging(evse.evseId, 'MasterPass');
            }
          }
          return result;
        }

        // Regular GroupId: stop the transaction on this EVSE if groupId matches
        const ctx = this.evseContexts.get(evseId) as EvseContext;
        if (ctx.transactionId != null) {
          const startInfo = this.transactionStartTokens.get(ctx.transactionId);
          if (startInfo != null && startInfo.groupIdToken != null) {
            const startGroupId = startInfo.groupIdToken['idToken'] as string | undefined;
            if (startGroupId === groupId && startInfo.idToken !== idToken) {
              console.log(
                `[${this.config.stationId}] GroupId match - stopping transaction on EVSE ${String(evseId)}`,
              );
              await this.stopCharging(evseId, 'Local');
              return result;
            }
          }
        }
      }
    }

    // Check auth result
    const statusField = this.is16 ? 'idTagInfo' : 'idTokenInfo';
    const authInfo = result[statusField] as Record<string, unknown> | undefined;
    if (authInfo?.['status'] !== 'Accepted') return result;

    // Store auth in context
    ctx.authorizedToken = idToken;
    ctx.authorizedTokenType = tokenType;

    // OCPP 2.1: Consume matching reservation on authorize (1.6 consumes in beginTransaction)
    if (!this.is16)
      for (const [resId, res] of this.reservations) {
        if (res.evseId === evseId || res.evseId === 0) {
          // Match by idToken or groupIdToken
          const tokenMatches = res.idToken === idToken;
          const groupMatches = res.groupIdToken != null && res.groupIdToken === idToken;
          if (tokenMatches || groupMatches) {
            clearTimeout(res.expiryTimer);
            this.reservations.delete(resId);
            console.log(
              `[${this.config.stationId}] Reservation ${String(resId)} consumed by authorize`,
            );
            const connId = this.getConnectorId(res.evseId > 0 ? res.evseId : evseId);
            this.evseConnectorStatus.set(res.evseId > 0 ? res.evseId : evseId, 'Available');
            void this.sendStatusNotification(
              res.evseId > 0 ? res.evseId : evseId,
              connId,
              'Available',
            ).catch(() => {});
            void this.sql`
            DELETE FROM css_reservations
            WHERE css_station_id = ${this.config.id} AND reservation_id = ${resId}
          `.catch(() => {});
            break;
          }
        }
      }

    // 2.1: check if same token should stop the active transaction
    if (!this.is16 && ctx.transactionId != null) {
      const startInfo = this.transactionStartTokens.get(ctx.transactionId);
      if (startInfo != null && idToken === startInfo.idToken) {
        await this.stopCharging(evseId, 'Local');
        return result;
      }
    }

    // 1.6: check if this token (or its parentIdTag) should stop an active transaction
    if (this.is16 && ctx.transactionId != null) {
      const parentIdTag = authInfo['parentIdTag'] as string | undefined;
      const startInfo = this.transactionStartTokens.get(ctx.transactionId);
      if (startInfo != null) {
        // Stop if same token or matching parentIdTag
        const startParent =
          startInfo.groupIdToken != null
            ? (startInfo.groupIdToken['idToken'] as string | undefined)
            : undefined;
        const shouldStop =
          idToken === startInfo.idToken ||
          (parentIdTag != null && startParent != null && parentIdTag === startParent);
        if (shouldStop) {
          await this.stopCharging(evseId, 'Local');
          return result;
        }
      }
    }

    // Auto-start if cable already plugged
    if (this.is16 && ctx.state === 'Preparing') {
      try {
        await this.beginTransaction(evseId, idToken, tokenType);
      } catch {
        // May fail if transaction already active
      }
    } else if (!this.is16 && ctx.cablePlugged && ctx.transactionId == null) {
      // 2.1: auto-start when cable is connected and no active transaction
      try {
        await this.beginTransaction(evseId, idToken, tokenType);
      } catch {
        // May fail if transaction already active
      }
    } else if (ctx.state !== 'Charging') {
      // Transition to Preparing on auth (station indicates user is identified)
      ctx.state = 'Authorized';
      if (this.is16) {
        const evse = this.config.evses.find((e) => e.evseId === evseId);
        if (evse != null) {
          this.evseConnectorStatus.set(evseId, 'Preparing');
          await this.sendStatusNotification(evse.evseId, evse.connectorId, 'Preparing');
          this.startConnectionTimeoutTimer(evseId);
        }
      } else if (!ctx.cablePlugged) {
        // OCPP 2.1: Start EVConnectionTimeout for local authorize-first flow
        this.startEvConnectTimeoutTimerPreTx(evseId);
      }
    }

    return result;
  }

  async startCharging(
    evseId: number,
    idToken: string,
    tokenType: string = 'ISO14443',
    remoteStartId?: number,
  ): Promise<string> {
    const ctx = this.evseContexts.get(evseId) as EvseContext;
    if (ctx.transactionId != null) {
      throw new Error('Transaction already active on this EVSE');
    }

    // Skip authorize if already authorized with this token
    if (ctx.authorizedToken !== idToken) {
      let authInfo: Record<string, unknown> | undefined;
      if (!this.client.isConnected) {
        // Offline: check local auth list, then auth cache
        const localEntry = this.localAuthEntries.get(idToken);
        if (localEntry != null) {
          const status = (localEntry['authStatus'] as string | undefined) ?? 'Accepted';
          authInfo = { status };
        } else {
          const cached = this.authCache.get(idToken);
          if (cached != null) {
            authInfo = cached;
          } else {
            const allowUnknown = this.getConfigValue('AllowOfflineTxForUnknownId') === 'true';
            authInfo = { status: allowUnknown ? 'Accepted' : 'Unknown' };
          }
        }
      } else {
        const authResult = await this.sendAuthorize(idToken, tokenType);
        const statusField = this.is16 ? 'idTagInfo' : 'idTokenInfo';
        authInfo = authResult[statusField] as Record<string, unknown> | undefined;
      }
      if (authInfo != null && authInfo['status'] !== 'Accepted') {
        throw new Error(`Authorization rejected: ${authInfo['status'] as string}`);
      }
      ctx.authorizedToken = idToken;
      ctx.authorizedTokenType = tokenType;
    }

    if (remoteStartId != null) ctx.remoteStartId = remoteStartId;

    return this.beginTransaction(evseId, idToken, tokenType, remoteStartId);
  }

  private async beginTransaction(
    evseId: number,
    idToken: string,
    tokenType: string,
    remoteStartId?: number,
    _consumedReservationId?: number,
    customTriggerReason?: string,
  ): Promise<string> {
    const ctx = this.evseContexts.get(evseId) as EvseContext;

    // Reset meter generator for this EVSE
    const gen = this.meterGens.get(evseId);
    if (gen != null) {
      gen.resetSession();
    }

    // Consume any reservation on this EVSE
    let consumedReservationId: number | undefined;
    for (const [id, r] of this.reservations) {
      if (r.evseId === evseId || r.evseId === 0) {
        clearTimeout(r.expiryTimer);
        consumedReservationId = id;
        this.reservations.delete(id);
        console.log(`[${this.config.stationId}] Reservation ${String(id)} consumed by transaction`);
        break;
      }
    }

    // StatusNotification
    const connectorId = this.getConnectorId(evseId);
    const chargingStatus = this.is16 ? 'Charging' : 'Occupied';
    this.evseConnectorStatus.set(evseId, chargingStatus);
    try {
      await this.sendStatusNotification(evseId, connectorId, chargingStatus);
    } catch {
      // Offline - status reported on reconnect
    }
    await this.updateEvseStatus(evseId, chargingStatus).catch(() => {});

    let txId: string;

    if (this.is16) {
      if (this.client.isConnected) {
        const response = await this.sendStartTransaction(evseId, idToken, consumedReservationId);
        txId = String(response['transactionId']);
      } else {
        // Queue StartTransaction for replay when back online
        txId = String(Date.now()); // Temporary local ID
        const gen2 = this.meterGens.get(evseId);
        const meterStartWh = gen2?.energyWh ?? 0;
        const startPayload: Record<string, unknown> = {
          connectorId: evseId,
          idTag: idToken,
          meterStart: meterStartWh,
          timestamp: new Date().toISOString(),
        };
        if (consumedReservationId != null) {
          startPayload['reservationId'] = consumedReservationId;
        }
        this.queueOfflineMessage('StartTransaction', startPayload);
      }
    } else {
      txId = randomUUID();
      this.evseSeqNo.set(evseId, 0);
      this.evseChargingState.set(evseId, 'EVConnected');

      // Generate Transaction.Begin meter values for Started event
      const startMeasurands = this.getSampledMeasurands();
      const startSampledValues =
        gen != null
          ? gen
              .generate(startMeasurands, false)
              .map((sv) => ({ ...sv, context: 'Transaction.Begin' }))
          : [];

      const startedOpts: Parameters<typeof this.sendTransactionEvent>[2] = {
        triggerReason:
          customTriggerReason ?? (remoteStartId != null ? 'RemoteStart' : 'Authorized'),
        transactionId: txId,
        chargingState: 'EVConnected',
        idToken,
        tokenType,
      };
      if (startSampledValues.length > 0) {
        startedOpts.meterValue = [
          { timestamp: new Date().toISOString(), sampledValue: startSampledValues },
        ] as unknown as Array<Record<string, unknown>>;
      }
      await this.sendTransactionEvent(evseId, 'Started', startedOpts);
      // Follow up with Charging state (energy transfer begins)
      const seqNo2 = (this.evseSeqNo.get(evseId) ?? 0) + 1;
      this.evseSeqNo.set(evseId, seqNo2);
      this.evseChargingState.set(evseId, 'Charging');
      await this.sendTransactionEvent(evseId, 'Updated', {
        triggerReason: 'ChargingStateChanged',
        transactionId: txId,
        chargingState: 'Charging',
        seqNo: seqNo2,
      });
    }

    // Create DB transaction record
    const meterStartWh = gen?.energyWh ?? 0;
    await this.createTransaction(evseId, txId, idToken, tokenType, meterStartWh).catch(() => {
      // DB may be unavailable
    });

    // Feature 3: Store start token and its groupId for stop-authorization checks
    const groupIdToken = this.tokenGroupMap.get(idToken) ?? null;
    this.transactionStartTokens.set(txId, { idToken, groupIdToken });

    console.log(
      `[${this.config.stationId}] Transaction started: ${txId} on EVSE ${String(evseId)}`,
    );

    // Start meter loop
    this.evseIdle.set(evseId, false);
    this.evseMeterTick.set(evseId, 0);
    this.evseTransactionStartTime.set(evseId, Date.now());
    this.evseTransactionLimits.delete(evseId);
    this.evseTotalCost.delete(evseId);
    this.evseLimitReached.delete(evseId);
    this.evseLastDriverLimits.delete(evseId);
    this.evseLastLocalCost.delete(evseId);
    this.startMeterLoop(evseId);

    // Update context
    ctx.state = 'Charging';
    ctx.transactionId = txId;

    return txId;
  }

  async stopCharging(evseId: number, reason: string = 'Local'): Promise<void> {
    const tx = await this.getActiveTransaction(evseId);
    if (tx == null) {
      console.log(`[${this.config.stationId}] No active transaction on EVSE ${String(evseId)}`);
      return;
    }

    this.stopMeterLoop(evseId);

    const gen = this.meterGens.get(evseId);
    const meterStopWh = gen?.energyWh ?? 0;

    if (this.is16) {
      const stopPayload: Record<string, unknown> = {
        transactionId: Number(tx.transactionId),
        meterStop: meterStopWh,
        timestamp: new Date().toISOString(),
        reason,
      };
      stopPayload['idTag'] = tx.idToken;
      if (this.client.isConnected) {
        await this.client.sendCall('StopTransaction', stopPayload);
      } else {
        this.queueOfflineMessage('StopTransaction', stopPayload);
      }
    } else {
      const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
      this.evseSeqNo.set(evseId, seqNo);
      // Map stop reason to OCPP 2.1 triggerReason and chargingState
      let triggerReason = 'StopAuthorized';
      let endChargingState = 'EVConnected';
      if (reason === 'Remote') {
        triggerReason = 'RemoteStop';
      } else if (reason === 'EVDisconnected') {
        triggerReason = 'EVCommunicationLost';
        endChargingState = 'Idle';
      } else if (reason === 'DeAuthorized') {
        triggerReason = 'Deauthorized';
      } else if (reason === 'MasterPass') {
        triggerReason = 'StopAuthorized';
      } else if (reason === 'StoppedByEV') {
        triggerReason = 'ChargingStateChanged';
      } else if (reason === 'EVDeparted') {
        triggerReason = 'EVDeparted';
      } else if (reason === 'PowerLoss') {
        triggerReason = 'AbnormalCondition';
      } else if (reason === 'Other') {
        triggerReason = 'AbnormalCondition';
      }
      // Generate Transaction.End meter values for Ended event
      const endMeasurands = this.getSampledMeasurands();
      const endSampledValues =
        gen != null
          ? gen.generate(endMeasurands, false).map((sv) => ({ ...sv, context: 'Transaction.End' }))
          : [];

      const endedOpts: Parameters<typeof this.sendTransactionEvent>[2] = {
        triggerReason,
        transactionId: tx.transactionId,
        chargingState: endChargingState,
        stoppedReason: reason,
        seqNo,
      };
      if (endSampledValues.length > 0) {
        endedOpts.meterValue = [
          { timestamp: new Date().toISOString(), sampledValue: endSampledValues },
        ] as unknown as Array<Record<string, unknown>>;
      }
      await this.sendTransactionEvent(evseId, 'Ended', endedOpts);
    }

    console.log(
      `[${this.config.stationId}] Transaction stopped: ${tx.transactionId} (${String(meterStopWh)} Wh)`,
    );

    // Complete DB record
    await this.completeTransaction(tx.transactionId, reason, meterStopWh);

    // Clean up start token tracking (Feature 3)
    this.transactionStartTokens.delete(tx.transactionId);

    // Reset per-EVSE state
    this.evsePowerLimits.set(evseId, null);
    this.evseIdle.set(evseId, false);
    this.evseChargingState.set(evseId, null);
    this.evseSeqNo.set(evseId, 0);
    this.evseMeterTick.set(evseId, 0);
    this.evseTransactionLimits.delete(evseId);
    this.evseTotalCost.delete(evseId);
    this.evseTransactionStartTime.delete(evseId);
    this.evseLimitReached.delete(evseId);
    this.evseLastDriverLimits.delete(evseId);
    this.evseLastLocalCost.delete(evseId);

    // Update EvseContext
    const ctx = this.evseContexts.get(evseId) as EvseContext;
    ctx.transactionId = null;
    ctx.authorizedToken = null;
    ctx.authorizedTokenType = null;
    ctx.remoteStartId = null;

    // Transition status after stop
    const connectorId = this.getConnectorId(evseId);
    if (this.is16) {
      // 1.6: send Finishing (cable still connected), Available comes on unplug
      ctx.state = 'Finishing';
      this.evseConnectorStatus.set(evseId, 'Finishing');
      try {
        await this.sendStatusNotification(evseId, connectorId, 'Finishing');
      } catch {
        // Offline - status will be reported on reconnect
      }
      await this.updateEvseStatus(evseId, 'Finishing').catch(() => {});
    } else {
      // Check if there is a pending scheduled availability change
      const pendingInoperative =
        this.availabilityState === 'Inoperative' || this.availabilityState === 'Unavailable';
      const hasOtherActiveTx = await this.hasAnyActiveTransaction();

      if (pendingInoperative && !hasOtherActiveTx) {
        // Apply the scheduled availability change now that all transactions ended
        ctx.state = 'Unavailable';
        this.evseConnectorStatus.set(evseId, 'Unavailable');
        try {
          await this.sendStatusNotification(evseId, connectorId, 'Unavailable');
        } catch {
          // Offline
        }
        await this.updateEvseStatus(evseId, 'Unavailable').catch(() => {});
      } else {
        ctx.state = 'Available';
        this.evseConnectorStatus.set(evseId, 'Available');
        try {
          await this.sendStatusNotification(evseId, connectorId, 'Available');
        } catch {
          // Offline
        }
        await this.updateEvseStatus(evseId, 'Available').catch(() => {});
      }
    }

    // Handle pending reset
    if (this.pendingReset != null) {
      const resetType = this.pendingReset;
      this.pendingReset = null;
      void this.simulateReset(resetType).catch(() => {});
    }
  }

  async unplug(evseId: number): Promise<void> {
    const ctx = this.evseContexts.get(evseId) as EvseContext;
    ctx.cablePlugged = false;
    const connectorId = this.getConnectorId(evseId);

    // If a transaction is active, check StopTransactionOnEVSideDisconnect
    if (ctx.transactionId != null) {
      const stopOnDisconnect = this.is16
        ? this.configVariables.get('StopTransactionOnEVSideDisconnect')?.value !== 'false'
        : this.configVariables.get('TxCtrlr.StopTxOnEVSideDisconnect')?.value !== 'false';

      if (stopOnDisconnect) {
        // Stop the transaction and send Available
        await this.stopCharging(evseId, 'EVDisconnected');
        ctx.state = 'Available';
        this.evseConnectorStatus.set(evseId, 'Available');
        try {
          await this.sendStatusNotification(evseId, connectorId, 'Available');
        } catch {
          // Offline - status will be reported on reconnect
        }
        await this.updateEvseStatus(evseId, 'Available').catch(() => {});
      } else if (!this.is16) {
        // OCPP 2.1: Suspend the transaction - send TransactionEvent Updated
        // with EVCommunicationLost and chargingState Idle
        this.stopMeterLoop(evseId);
        const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
        this.evseSeqNo.set(evseId, seqNo);
        this.evseChargingState.set(evseId, 'Idle');
        ctx.state = 'SuspendedEV';
        await this.sendTransactionEvent(evseId, 'Updated', {
          triggerReason: 'EVCommunicationLost',
          transactionId: ctx.transactionId,
          chargingState: 'Idle',
          seqNo,
        });
        // Send StatusNotification Available (cable disconnected)
        this.evseConnectorStatus.set(evseId, 'Available');
        try {
          await this.sendStatusNotification(evseId, connectorId, 'Available');
        } catch {
          // Offline
        }
        await this.updateEvseStatus(evseId, 'Available').catch(() => {});

        // Start EVConnectionTimeout timer for the suspended transaction.
        // If cable is not re-plugged within the timeout, end the transaction.
        this.startEvConnectTimeoutTimer(evseId, ctx.transactionId);
      } else {
        // 1.6: Suspend the transaction (EV disconnected but tx continues)
        ctx.state = 'SuspendedEV';
        this.evseConnectorStatus.set(evseId, 'SuspendedEV');
        try {
          await this.sendStatusNotification(evseId, connectorId, 'SuspendedEV');
        } catch {
          // Offline - status will be reported on reconnect
        }
        await this.updateEvseStatus(evseId, 'SuspendedEV').catch(() => {});
      }
    } else {
      // No active transaction - just go to Available
      ctx.state = 'Available';
      ctx.authorizedToken = null;
      ctx.authorizedTokenType = null;
      this.evseConnectorStatus.set(evseId, 'Available');
      try {
        await this.sendStatusNotification(evseId, connectorId, 'Available');
      } catch {
        // Offline - status will be reported on reconnect
      }
      await this.updateEvseStatus(evseId, 'Available').catch(() => {});
    }
  }

  /**
   * OCPP 2.1: Simulate the EV stopping energy transfer while cable stays connected.
   * Sends TransactionEvent Ended with triggerReason ChargingStateChanged,
   * chargingState EVConnected, stoppedReason StoppedByEV.
   */
  async suspendEV(evseId: number): Promise<void> {
    if (this.is16) return;
    const ctx = this.evseContexts.get(evseId) as EvseContext;
    if (ctx.transactionId == null) return;
    await this.stopCharging(evseId, 'StoppedByEV');
  }

  /**
   * OCPP 2.1: Simulate the EV departing the parking bay.
   * Sends TransactionEvent Ended with triggerReason EVDeparted,
   * stoppedReason Local.
   */
  async departParkingBay(evseId: number): Promise<void> {
    if (this.is16) return;
    const ctx = this.evseContexts.get(evseId) as EvseContext;
    if (ctx.transactionId == null) return;
    await this.stopCharging(evseId, 'EVDeparted');
  }

  /**
   * OCPP 2.1: Simulate parking bay becoming occupied (vehicle detected).
   * Sends TransactionEvent Started with triggerReason ParkingBayOccupancy.
   */
  async occupyParkingBay(evseId: number, idToken: string): Promise<void> {
    if (this.is16) return;
    await this.beginTransaction(
      evseId,
      idToken,
      'ISO14443',
      undefined,
      undefined,
      'ParkingBayOccupancy',
    );
  }

  /**
   * OCPP 2.1: Simulate EV not ready for charging (SuspendedEV state).
   * The transaction starts but the EV doesn't accept energy.
   */
  async setEvNotReady(evseId: number): Promise<void> {
    if (this.is16) return;
    const ctx = this.evseContexts.get(evseId) as EvseContext;
    if (ctx.transactionId == null) return;
    const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
    this.evseSeqNo.set(evseId, seqNo);
    this.evseChargingState.set(evseId, 'SuspendedEV');
    await this.sendTransactionEvent(evseId, 'Updated', {
      triggerReason: 'ChargingStateChanged',
      transactionId: ctx.transactionId,
      chargingState: 'SuspendedEV',
      seqNo,
    });
  }

  // ---------------------------------------------------------------------------
  // Group 2: Fault injection
  // ---------------------------------------------------------------------------

  async injectFault(evseId: number, errorCode: string): Promise<void> {
    // Stop active transaction if any
    const faultCtx = this.evseContexts.get(evseId) as EvseContext;
    if (faultCtx.transactionId != null) {
      await this.stopCharging(evseId, 'Other');
    }
    const connectorId = this.getConnectorId(evseId);
    this.evseConnectorStatus.set(evseId, 'Faulted');
    faultCtx.state = 'Faulted';
    await this.sendStatusNotification(evseId, connectorId, 'Faulted', errorCode);
    await this.updateEvseStatus(evseId, 'Faulted');
  }

  async clearFault(evseId: number): Promise<void> {
    const connectorId = this.getConnectorId(evseId);
    this.evseConnectorStatus.set(evseId, 'Available');
    const clearCtx = this.evseContexts.get(evseId) as EvseContext;
    clearCtx.state = 'Available';
    await this.sendStatusNotification(evseId, connectorId, 'Available');
    await this.updateEvseStatus(evseId, 'Available');
  }

  // ---------------------------------------------------------------------------
  // Group 3: Network
  // ---------------------------------------------------------------------------

  async goOffline(): Promise<void> {
    this.offlineFlag = true;
    this.client.disconnect();
    await this.updateStationStatus('disconnected');
  }

  async comeOnline(): Promise<void> {
    this.offlineFlag = false;
    this.destroyed = false;
    await this.start();
  }

  // ---------------------------------------------------------------------------
  // Group 4: Station-initiated OCPP messages
  // ---------------------------------------------------------------------------

  async sendBootNotification(reason: string = 'PowerUp'): Promise<Record<string, unknown>> {
    const payload = this.is16
      ? {
          chargePointVendor: this.config.vendorName,
          chargePointModel: this.config.model,
          chargePointSerialNumber: this.config.serialNumber,
          firmwareVersion: this.config.firmwareVersion,
        }
      : {
          chargingStation: {
            vendorName: this.config.vendorName,
            model: this.config.model,
            serialNumber: this.config.serialNumber,
            firmwareVersion: this.config.firmwareVersion,
          },
          reason,
        };

    const response = await this.client.sendCall('BootNotification', payload);
    this.bootStatus = response['status'] as 'Accepted' | 'Pending' | 'Rejected';
    console.log(`[${this.config.stationId}] Boot status: ${response['status'] as string}`);

    if (response['status'] === 'Accepted') {
      const interval = (response['interval'] as number) * 1000;
      this.startHeartbeat(interval > 0 ? interval : 300_000);

      // Update DB
      await this.sql`
        UPDATE css_stations
        SET boot_reason = ${reason}, last_boot_at = NOW(), updated_at = NOW()
        WHERE id = ${this.config.id}
      `;
    } else if (response['status'] === 'Pending' || response['status'] === 'Rejected') {
      // Per OCPP spec: station must retry BootNotification after the interval.
      // During Pending/Rejected, the station must not send other OCPP messages
      // (except responses to CSMS-initiated commands).
      const interval = response['interval'] as number | undefined;
      const retryIntervalMs = (interval != null ? interval : 60) * 1000;
      if (!this.destroyed) {
        setTimeout(() => {
          if (!this.destroyed) {
            void (async () => {
              try {
                await this.sendBootNotification(reason);
                // If boot was accepted after retry, send StatusNotification for all connectors
                if (this.bootStatus === 'Accepted') {
                  for (const evse of this.config.evses) {
                    const ctx = this.evseContexts.get(evse.evseId) as EvseContext;
                    ctx.state = 'Available';
                    ctx.cablePlugged = false;
                    this.evseConnectorStatus.set(evse.evseId, 'Available');
                    await this.sendStatusNotification(evse.evseId, evse.connectorId, 'Available');
                    await this.updateEvseStatus(evse.evseId, 'Available');
                  }
                  await this.updateStationStatus('available');
                }
              } catch {
                // Retry failed
              }
            })();
          }
        }, retryIntervalMs);
      }
    }

    return response;
  }

  async sendHeartbeat(): Promise<Record<string, unknown>> {
    const response = await this.client.sendCall('Heartbeat', {});
    console.log(`[${this.config.stationId}] Heartbeat: ${response['currentTime'] as string}`);

    await this.sql`
      UPDATE css_stations SET last_heartbeat_at = NOW(), updated_at = NOW()
      WHERE id = ${this.config.id}
    `;

    return response;
  }

  async sendStatusNotification(
    evseId: number,
    connectorId: number,
    status: string,
    errorCode?: string,
  ): Promise<void> {
    if (this.is16) {
      await this.client.sendCall('StatusNotification', {
        connectorId: evseId,
        errorCode: errorCode ?? 'NoError',
        status,
      });
    } else {
      await this.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: status,
        evseId,
        connectorId,
      });
      // Per OCPP 2.1 spec: send NotifyEvent with Delta trigger for AvailabilityState
      // when connector status changes
      try {
        await this.client.sendCall('NotifyEvent', {
          generatedAt: new Date().toISOString(),
          seqNo: 0,
          tbc: false,
          eventData: [
            {
              eventId: Math.floor(Math.random() * 1000000),
              timestamp: new Date().toISOString(),
              trigger: 'Delta',
              actualValue: status,
              eventNotificationType: 'HardWiredMonitor',
              component: { name: 'Connector', evse: { id: evseId, connectorId } },
              variable: { name: 'AvailabilityState' },
            },
          ],
        });
      } catch {
        // NotifyEvent may fail if connection is closing
      }
    }
    console.log(
      `[${this.config.stationId}] StatusNotification: EVSE ${String(evseId)} connector ${String(connectorId)} = ${status}`,
    );
  }

  async sendMeterValues(
    evseId: number,
    sampledValues?: Array<Record<string, unknown>>,
    transactionId?: string,
  ): Promise<void> {
    // If no sampled values provided, generate them from the meter value generator
    if (sampledValues == null) {
      const gen = this.meterGens.get(evseId);
      if (gen != null) {
        const idle = this.evseIdle.get(evseId) ?? false;
        const powerLimit = this.evsePowerLimits.get(evseId) ?? null;
        gen.tick(idle, powerLimit);
        const measurands = this.getSampledMeasurands();
        sampledValues = gen.generate(measurands, this.is16) as unknown as Array<
          Record<string, unknown>
        >;
      } else {
        sampledValues = [];
      }
    }
    if (this.is16) {
      const mv: Record<string, unknown> = {
        connectorId: evseId,
        meterValue: [{ timestamp: new Date().toISOString(), sampledValue: sampledValues }],
      };
      if (transactionId != null) {
        mv['transactionId'] = Number(transactionId);
      }
      await this.client.sendCall('MeterValues', mv);
    } else {
      await this.client.sendCall('MeterValues', {
        evseId,
        meterValue: [{ timestamp: new Date().toISOString(), sampledValue: sampledValues }],
      });
    }
  }

  async sendAuthorize(
    idToken: string,
    tokenType: string = 'ISO14443',
  ): Promise<Record<string, unknown>> {
    // LocalPreAuthorize: check local list and cache before sending to CS
    const localPreAuth = this.is16
      ? this.getConfigValue('LocalPreAuthorize') === 'true'
      : this.getConfigValue('AuthCtrlr.LocalPreAuthorize') === 'true';
    if (localPreAuth) {
      const localEntry = this.localAuthEntries.get(idToken);
      if (localEntry != null) {
        const status = (localEntry['authStatus'] as string | undefined) ?? 'Accepted';
        // Local auth list takes absolute priority over cache (any status)
        console.log(`[${this.config.stationId}] Authorize (local pre-auth/list): ${status}`);
        const sf = this.is16 ? 'idTagInfo' : 'idTokenInfo';
        return { [sf]: { status } };
      }
      const cached = this.authCache.get(idToken);
      if (cached != null) {
        const status = cached['status'] as string;
        if (status === 'Accepted') {
          console.log(`[${this.config.stationId}] Authorize (local pre-auth/cache): ${status}`);
          const sf = this.is16 ? 'idTagInfo' : 'idTokenInfo';
          return { [sf]: cached };
        }
      }
    }

    // LocalAuthListCtrlr.DisablePostAuthorize: if token is in local auth list (any status),
    // use the local result without sending Authorize to CSMS
    if (!this.is16 && this.getConfigValue('LocalAuthListCtrlr.DisablePostAuthorize') === 'true') {
      const localEntry = this.localAuthEntries.get(idToken);
      if (localEntry != null) {
        const status = (localEntry['authStatus'] as string | undefined) ?? 'Accepted';
        console.log(
          `[${this.config.stationId}] Authorize (LocalAuthList DisablePostAuthorize): ${status}`,
        );
        return { idTokenInfo: { status } };
      }
    }

    // DisablePostAuthorize: if token is cached (any status), do not send to CSMS
    if (!this.is16 && this.getConfigValue('AuthCacheCtrlr.DisablePostAuthorize') === 'true') {
      const cached = this.authCache.get(idToken);
      if (cached != null) {
        const status = cached['status'] as string;
        console.log(
          `[${this.config.stationId}] Authorize (DisablePostAuthorize/cached): ${status}`,
        );
        return { idTokenInfo: cached };
      }
    }

    // Offline fallback: check local auth list, then auth cache
    if (!this.client.isConnected) {
      const localEntry = this.localAuthEntries.get(idToken);
      if (localEntry != null) {
        const status = (localEntry['authStatus'] as string | undefined) ?? 'Accepted';
        console.log(`[${this.config.stationId}] Authorize (offline/local): ${status}`);
        const statusField = this.is16 ? 'idTagInfo' : 'idTokenInfo';
        return { [statusField]: { status } };
      }
      const cached = this.authCache.get(idToken);
      if (cached != null) {
        const status = cached['status'] as string;
        console.log(`[${this.config.stationId}] Authorize (offline/cached): ${status}`);
        const statusField = this.is16 ? 'idTagInfo' : 'idTokenInfo';
        return { [statusField]: cached };
      }
      // Check AllowOfflineTxForUnknownId
      const allowUnknown = this.getConfigValue('AllowOfflineTxForUnknownId') === 'true';
      if (allowUnknown) {
        console.log(
          `[${this.config.stationId}] Authorize (offline/unknown): Accepted (AllowOfflineTxForUnknownId)`,
        );
        const statusField = this.is16 ? 'idTagInfo' : 'idTokenInfo';
        return { [statusField]: { status: 'Accepted' } };
      }
      console.log(`[${this.config.stationId}] Authorize (offline/unknown): Unknown`);
      const statusField = this.is16 ? 'idTagInfo' : 'idTokenInfo';
      return { [statusField]: { status: 'Unknown' } };
    }

    const payload = this.is16 ? { idTag: idToken } : { idToken: { idToken, type: tokenType } };
    let response: Record<string, unknown>;
    try {
      response = await this.client.sendCall('Authorize', payload);
    } catch (err) {
      // Connection error during send: fall back to local auth / cache
      const localEntry = this.localAuthEntries.get(idToken);
      if (localEntry != null) {
        const status = (localEntry['authStatus'] as string | undefined) ?? 'Accepted';
        console.log(`[${this.config.stationId}] Authorize (connection error/local): ${status}`);
        const statusField = this.is16 ? 'idTagInfo' : 'idTokenInfo';
        return { [statusField]: { status } };
      }
      const cached = this.authCache.get(idToken);
      if (cached != null) {
        const status = cached['status'] as string;
        console.log(`[${this.config.stationId}] Authorize (connection error/cached): ${status}`);
        const statusField = this.is16 ? 'idTagInfo' : 'idTokenInfo';
        return { [statusField]: cached };
      }
      throw err;
    }

    const statusField = this.is16 ? 'idTagInfo' : 'idTokenInfo';
    const idTokenInfo = response[statusField] as Record<string, unknown> | undefined;
    console.log(
      `[${this.config.stationId}] Authorize: ${idTokenInfo != null ? (idTokenInfo['status'] as string) : 'unknown'}`,
    );

    // Feature 2: Cache the auth result
    if (idTokenInfo != null) {
      this.authCache.set(idToken, idTokenInfo);

      // Feature 3: Store group token mapping if present
      // OCPP 2.1 uses groupIdToken, OCPP 1.6 uses parentIdTag
      if (this.is16) {
        const parentIdTag = idTokenInfo['parentIdTag'] as string | undefined;
        if (parentIdTag != null) {
          this.tokenGroupMap.set(idToken, { idToken: parentIdTag, type: 'ISO14443' });
        }
      } else {
        const groupIdToken = idTokenInfo['groupIdToken'] as Record<string, unknown> | undefined;
        if (groupIdToken != null) {
          this.tokenGroupMap.set(idToken, groupIdToken);
        }
      }
    }

    // OCPP 2.1: Process driver tariff from AuthorizeResponse
    if (!this.is16) {
      const tariff = response['tariff'] as Record<string, unknown> | undefined;
      if (tariff != null) {
        const tariffId = tariff['tariffId'] as string;
        // Store the driver tariff (keyed by a placeholder EVSE; actual EVSE resolved in beginTransaction)
        this.driverTariffs.set(0, { tariffId, tariff });
        console.log(`[${this.config.stationId}] Received driver tariff: ${tariffId}`);

        // If TariffCostCtrlr is not enabled, report TariffCostCtrlr Problem via NotifyEvent
        const tariffEnabled = this.getConfigValue('TariffCostCtrlr.Enabled') ?? 'true';
        if (tariffEnabled !== 'true') {
          void this.sendNotifyEvent([
            {
              eventId: Date.now(),
              timestamp: new Date().toISOString(),
              trigger: 'Delta',
              actualValue: 'true',
              component: { name: 'TariffCostCtrlr' },
              variable: { name: 'Problem' },
            },
          ]).catch(() => {});
          // Deauthorize if configured to do so (I08.FR.31)
          const deauthorize =
            this.getConfigValue('TariffCostCtrlr.DeauthorizeOnProblem') ?? 'false';
          if (deauthorize === 'true' && idTokenInfo != null) {
            idTokenInfo['status'] = 'Invalid';
          }
        }
      }
    }

    return response;
  }

  clearAuthCache(): void {
    this.authCache.clear();
    this.tokenGroupMap.clear();
  }

  /** Add a token to the auth cache. For testing. */
  addToAuthCache(
    idToken: string,
    status: string = 'Accepted',
    groupIdToken?: { idToken: string; type: string },
  ): void {
    const entry: Record<string, unknown> = { status };
    if (groupIdToken != null) {
      entry['groupIdToken'] = groupIdToken;
      this.tokenGroupMap.set(idToken, groupIdToken);
    }
    this.authCache.set(idToken, entry);
  }

  /** Add a token to the local auth list. For testing. */
  addToLocalAuthList(
    idToken: string,
    status: string = 'Accepted',
    groupIdToken?: { idToken: string; type: string },
  ): void {
    const entry: Record<string, unknown> = { authStatus: status };
    if (groupIdToken != null) {
      entry['groupIdToken'] = groupIdToken;
      this.tokenGroupMap.set(idToken, groupIdToken);
    }
    this.localAuthEntries.set(idToken, entry);
  }

  async sendTransactionEvent(
    evseId: number,
    eventType: 'Started' | 'Updated' | 'Ended',
    opts: {
      triggerReason: string;
      transactionId: string;
      chargingState?: string;
      stoppedReason?: string;
      idToken?: string;
      tokenType?: string;
      seqNo?: number;
      meterValue?: Array<Record<string, unknown>>;
      transactionLimit?: { maxEnergy?: number; maxTime?: number; maxCost?: number };
      costDetails?: Record<string, unknown>;
      remoteStartId?: number;
    },
  ): Promise<Record<string, unknown>> {
    const seqNo = opts.seqNo ?? this.evseSeqNo.get(evseId) ?? 0;
    const transactionInfo: Record<string, unknown> = {
      transactionId: opts.transactionId,
    };
    // Include remoteStartId from opts or from the EVSE context
    const rsId = opts.remoteStartId ?? this.evseContexts.get(evseId)?.remoteStartId;
    if (rsId != null) {
      transactionInfo['remoteStartId'] = rsId;
    }
    if (opts.chargingState != null) {
      transactionInfo['chargingState'] = opts.chargingState;
    }
    // Include tariffId from driver tariff or default tariff
    if (!this.is16) {
      const driverTariff = this.driverTariffs.get(evseId) ?? this.driverTariffs.get(0);
      if (driverTariff != null) {
        transactionInfo['tariffId'] = driverTariff.tariffId;
      }
    }
    if (opts.stoppedReason != null) {
      transactionInfo['stoppedReason'] = opts.stoppedReason;
    }
    if (opts.transactionLimit != null) {
      transactionInfo['transactionLimit'] = opts.transactionLimit;
    }

    const payload: Record<string, unknown> = {
      eventType,
      timestamp: new Date().toISOString(),
      triggerReason: opts.triggerReason,
      seqNo,
      transactionInfo,
      evse: { id: evseId, connectorId: this.getConnectorId(evseId) },
    };

    if (opts.idToken != null) {
      payload['idToken'] = {
        idToken: opts.idToken,
        type: opts.tokenType ?? 'ISO14443',
      };
    }

    if (opts.meterValue != null) {
      payload['meterValue'] = opts.meterValue;
    }

    if (opts.costDetails != null) {
      payload['costDetails'] = opts.costDetails;
    }

    // Set offline flag when not connected
    if (!this.client.isConnected) {
      payload['offline'] = true;
      this.queueOfflineMessage('TransactionEvent', payload);
      return {};
    }

    const response = await this.client.sendCall('TransactionEvent', payload);

    // OCPP 2.1: process transactionLimit and totalCost from response.
    // Deferred so the current call chain completes first (e.g., startCharging
    // finishes Started + ChargingStateChanged before LimitSet fires).
    if (!this.is16 && eventType !== 'Ended') {
      const hasTxLimit = response['transactionLimit'] != null;
      const hasTotalCost = response['totalCost'] != null;
      if (hasTxLimit || hasTotalCost) {
        const txIdCopy = opts.transactionId;
        const responseCopy = { ...response };
        setTimeout(() => {
          void this.processTransactionEventResponse(evseId, txIdCopy, responseCopy).catch(() => {});
        }, 0);
      }
    }

    return response;
  }

  /**
   * Process TransactionEventResponse fields: transactionLimit and totalCost.
   * When a new limit is received, sends a TransactionEvent Updated with triggerReason LimitSet.
   */
  private async processTransactionEventResponse(
    evseId: number,
    transactionId: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    // Store totalCost from CSMS
    const totalCost = response['totalCost'] as number | undefined;
    if (totalCost != null) {
      this.evseTotalCost.set(evseId, totalCost);
      // Immediately check cost limit (the meter loop check may have already run this tick)
      const limits = this.evseTransactionLimits.get(evseId);
      if (
        limits?.maxCost != null &&
        totalCost >= limits.maxCost &&
        !(this.evseLimitReached.get(evseId) ?? false)
      ) {
        this.evseLimitReached.set(evseId, true);
        await this.sendLimitReachedEvent(evseId, transactionId, 'CostLimitReached');
        return;
      }
    }

    // Process transactionLimit from CSMS
    const limit = response['transactionLimit'] as Record<string, unknown> | undefined;
    if (limit == null) return;

    const newLimit: { maxEnergy?: number; maxTime?: number; maxCost?: number } = {};
    if (limit['maxEnergy'] != null) newLimit.maxEnergy = limit['maxEnergy'] as number;
    if (limit['maxTime'] != null) newLimit.maxTime = limit['maxTime'] as number;
    if (limit['maxCost'] != null) newLimit.maxCost = limit['maxCost'] as number;

    // Merge with existing limits (CSMS update replaces previous values for same fields)
    const existing = this.evseTransactionLimits.get(evseId) ?? {};
    const merged = { ...existing, ...newLimit };
    this.evseTransactionLimits.set(evseId, merged);

    // Reset limit-reached flag when limits change
    this.evseLimitReached.set(evseId, false);

    // Send TransactionEvent Updated with triggerReason LimitSet
    const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
    this.evseSeqNo.set(evseId, seqNo);
    await this.sendTransactionEvent(evseId, 'Updated', {
      triggerReason: 'LimitSet',
      transactionId,
      chargingState: this.evseChargingState.get(evseId) ?? 'Charging',
      seqNo,
      transactionLimit: merged,
    });

    // Immediately check if limits are already exceeded
    const gen = this.meterGens.get(evseId);
    if (gen != null && !(this.evseLimitReached.get(evseId) ?? false)) {
      await this.checkTransactionLimits(evseId, transactionId, gen);
    }
  }

  async sendFirmwareStatusNotification(status: string, requestId?: number): Promise<void> {
    if (this.is16) {
      await this.client.sendCall('FirmwareStatusNotification', { status });
    } else {
      await this.client.sendCall('FirmwareStatusNotification', {
        status,
        requestId: requestId ?? 0,
      });
    }
  }

  async sendLogStatusNotification(status: string, requestId?: number): Promise<void> {
    if (this.is16) {
      await this.client.sendCall('DiagnosticsStatusNotification', { status });
    } else {
      await this.client.sendCall('LogStatusNotification', {
        status,
        requestId: requestId ?? 0,
      });
    }
  }

  async sendSecurityEventNotification(
    type: string,
    timestamp?: string,
    techInfo?: string,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      type,
      timestamp: timestamp ?? new Date().toISOString(),
    };
    if (techInfo != null) payload['techInfo'] = techInfo;
    return this.client.sendCall('SecurityEventNotification', payload);
  }

  async sendNotifyEvent(
    eventData: Array<Record<string, unknown>>,
    seqNo: number = 0,
    tbc: boolean = false,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyEvent', {
      generatedAt: new Date().toISOString(),
      seqNo,
      tbc,
      eventData,
    });
  }

  private parseConfigKey(key: string): {
    componentName: string;
    variableName: string;
    instance: string | undefined;
  } {
    const dotIdx = key.indexOf('.');
    const afterDot = dotIdx >= 0 ? key.substring(dotIdx + 1) : key;
    const hashIdx = afterDot.indexOf('#');
    const componentName = dotIdx >= 0 ? key.substring(0, dotIdx) : key;
    const variableName = hashIdx >= 0 ? afterDot.substring(0, hashIdx) : afterDot;
    const instance = hashIdx >= 0 ? afterDot.substring(hashIdx + 1) : undefined;
    return { componentName, variableName, instance };
  }

  private countMatchingVariables(filters?: {
    componentCriteria?: string[] | undefined;
    componentVariable?:
      | Array<{
          component: { name: string; evse?: { id: number }; instance?: string };
          variable: { name: string; instance?: string };
        }>
      | undefined;
  }): number {
    let count = 0;
    for (const [key, entry] of this.configVariables) {
      const { componentName, variableName, instance } = this.parseConfigKey(key);

      if (filters?.componentCriteria != null && filters.componentCriteria.length > 0) {
        const criteria = filters.componentCriteria;
        let matches = false;
        if (criteria.includes('Enabled') && variableName === 'Enabled' && entry.value === 'true')
          matches = true;
        if (criteria.includes('Active') && variableName === 'Enabled' && entry.value === 'true')
          matches = true;
        if (criteria.includes('Available') && variableName === 'AvailabilityState') matches = true;
        if (
          criteria.includes('Problem') &&
          (variableName === 'Problem' ||
            variableName === 'Tripped' ||
            variableName === 'Overload' ||
            variableName === 'Fallback')
        )
          matches = true;
        if (!matches) continue;
      }

      if (filters?.componentVariable != null && filters.componentVariable.length > 0) {
        let matches = false;
        for (const cv of filters.componentVariable) {
          const compMatches = cv.component.name === componentName;
          const varMatches = cv.variable.name === variableName;
          const instanceMatches = cv.variable.instance == null || cv.variable.instance === instance;
          if (compMatches && varMatches && instanceMatches) {
            matches = true;
            break;
          }
        }
        if (!matches) continue;
      }

      count++;
    }
    return count;
  }

  async sendNotifyReport(
    requestId: number,
    filters?: {
      componentCriteria?: string[] | undefined;
      componentVariable?:
        | Array<{
            component: { name: string; evse?: { id: number }; instance?: string };
            variable: { name: string; instance?: string };
          }>
        | undefined;
    },
  ): Promise<void> {
    const reportData: Array<Record<string, unknown>> = [];

    for (const [key, entry] of this.configVariables) {
      const { componentName, variableName, instance } = this.parseConfigKey(key);

      // Apply componentCriteria filter
      if (filters?.componentCriteria != null && filters.componentCriteria.length > 0) {
        const criteria = filters.componentCriteria;
        let matches = false;
        if (criteria.includes('Enabled') && variableName === 'Enabled' && entry.value === 'true')
          matches = true;
        if (criteria.includes('Active') && variableName === 'Enabled' && entry.value === 'true')
          matches = true;
        if (criteria.includes('Available') && variableName === 'AvailabilityState') matches = true;
        if (
          criteria.includes('Problem') &&
          (variableName === 'Problem' ||
            variableName === 'Tripped' ||
            variableName === 'Overload' ||
            variableName === 'Fallback')
        )
          matches = true;
        if (!matches) continue;
      }

      // Apply componentVariable filter
      if (filters?.componentVariable != null && filters.componentVariable.length > 0) {
        let matches = false;
        for (const cv of filters.componentVariable) {
          const compMatches = cv.component.name === componentName;
          const varMatches = cv.variable.name === variableName;
          // If instance filter is specified, must match. If not specified, match all.
          const instanceMatches = cv.variable.instance == null || cv.variable.instance === instance;
          if (compMatches && varMatches && instanceMatches) {
            matches = true;
            break;
          }
        }
        if (!matches) continue;
      }

      const component: Record<string, unknown> = { name: componentName };
      const variable: Record<string, unknown> = { name: variableName };
      if (instance != null) variable['instance'] = instance;

      reportData.push({
        component,
        variable,
        variableAttribute: [
          {
            type: 'Actual',
            value: entry.value,
            mutability: entry.readonly ? 'ReadOnly' : 'ReadWrite',
          },
        ],
        variableCharacteristics: {
          dataType: 'string',
          supportsMonitoring: false,
        },
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    if (this.destroyed) return;
    try {
      await this.client.sendCall('NotifyReport', {
        requestId,
        seqNo: 0,
        tbc: false,
        generatedAt: new Date().toISOString(),
        reportData,
      });
    } catch {
      // Ignore
    }
  }

  async sendDataTransfer(
    vendorId: string,
    messageId?: string,
    data?: string,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { vendorId };
    if (messageId != null) payload['messageId'] = messageId;
    if (data != null) payload['data'] = data;
    return this.client.sendCall('DataTransfer', payload);
  }

  async sendNotifyMonitoringReport(
    requestId: number,
    monitor: Array<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyMonitoringReport', {
      requestId,
      seqNo: 0,
      tbc: false,
      generatedAt: new Date().toISOString(),
      monitor,
    });
  }

  async sendNotifyChargingLimit(
    chargingLimit: Record<string, unknown>,
    chargingSchedule?: Array<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { chargingLimit };
    if (chargingSchedule != null) payload['chargingSchedule'] = chargingSchedule;
    return this.client.sendCall('NotifyChargingLimit', payload);
  }

  async sendNotifyEVChargingNeeds(
    evseId: number,
    chargingNeeds: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyEVChargingNeeds', {
      evseId,
      chargingNeeds,
    });
  }

  async sendClearedChargingLimit(
    chargingLimitSource: string,
    evseId?: number,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { chargingLimitSource };
    if (evseId != null) payload['evseId'] = evseId;
    return this.client.sendCall('ClearedChargingLimit', payload);
  }

  async sendReservationStatusUpdate(
    reservationId: number,
    reservationUpdateStatus: string,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('ReservationStatusUpdate', {
      reservationId,
      reservationUpdateStatus,
    });
  }

  async sendNotifyDisplayMessages(
    requestId: number,
    messageInfo: Array<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyDisplayMessages', {
      requestId,
      messageInfo,
      tbc: false,
    });
  }

  async sendNotifyCustomerInformation(
    requestId: number,
    data: string,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyCustomerInformation', {
      requestId,
      data,
      seqNo: 0,
      tbc: false,
      generatedAt: new Date().toISOString(),
    });
  }

  async sendSignCertificate(
    csr: string,
    certificateType: string = 'ChargingStationCertificate',
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('SignCertificate', { csr, certificateType });
  }

  async sendGetCertificateStatus(
    ocspRequestData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('GetCertificateStatus', { ocspRequestData });
  }

  async sendGetTransactionStatus(transactionId?: string): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {};
    if (transactionId != null) payload['transactionId'] = transactionId;
    return this.client.sendCall('GetTransactionStatus', payload);
  }

  async sendReportChargingProfiles(
    requestId: number,
    chargingProfile: Array<Record<string, unknown>>,
    evseId: number,
    chargingLimitSource: string = 'CSO',
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('ReportChargingProfiles', {
      requestId,
      chargingLimitSource,
      chargingProfile,
      evseId,
      tbc: false,
    });
  }

  async sendNotifyEVChargingSchedule(
    timeBase: string,
    evseId: number,
    chargingSchedule: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyEVChargingSchedule', {
      timeBase,
      evseId,
      chargingSchedule,
    });
  }

  async sendNotifySettlement(
    settlementData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifySettlement', settlementData);
  }

  async sendNotifyPriorityCharging(
    transactionId: string,
    activated: boolean,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyPriorityCharging', {
      transactionId,
      activated,
    });
  }

  async sendNotifyQRCodeScanned(evseId: number, timeout: number): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyQRCodeScanned', { evseId, timeout });
  }

  async sendNotifyAllowedEnergyTransfer(
    allowedEnergyTransfer: string[],
    transactionId: string = 'unknown',
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyAllowedEnergyTransfer', {
      transactionId,
      allowedEnergyTransfer,
    });
  }

  async sendGet15118EVCertificate(
    iso15118SchemaVersion: string,
    action: string,
    exiRequest: string,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('Get15118EVCertificate', {
      iso15118SchemaVersion,
      action,
      exiRequest,
    });
  }

  async sendGetCertificateChainStatus(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('GetCertificateChainStatus', payload);
  }

  async sendPublishFirmwareStatusNotification(
    status: string,
    requestId?: number,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('PublishFirmwareStatusNotification', {
      status,
      requestId: requestId ?? 0,
    });
  }

  async sendNotifyWebPaymentStarted(
    evseId: number,
    timeout: number,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyWebPaymentStarted', { evseId, timeout });
  }

  async sendNotifyPeriodicEventStream(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyPeriodicEventStream', payload);
  }

  async sendNotifyDERAlarm(alarmInfo: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyDERAlarm', alarmInfo);
  }

  async sendNotifyDERStartStop(info: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyDERStartStop', info);
  }

  async sendReportDERControl(
    controlData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('ReportDERControl', controlData);
  }

  async sendBatterySwap(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.sendCall('BatterySwap', payload);
  }

  async sendPullDynamicScheduleUpdate(chargingProfileId: number): Promise<Record<string, unknown>> {
    return this.client.sendCall('PullDynamicScheduleUpdate', { chargingProfileId });
  }

  async sendVatNumberValidation(
    vatNumber: string,
    evseId?: number,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { vatNumber };
    if (evseId != null) payload['evseId'] = evseId;
    return this.client.sendCall('VatNumberValidation', payload);
  }

  // ---------------------------------------------------------------------------
  // Group 5: OCPP 1.6 specific station-initiated messages
  // ---------------------------------------------------------------------------

  async sendStartTransaction(
    connectorId: number,
    idTag: string,
    reservationId?: number,
  ): Promise<Record<string, unknown>> {
    const gen = this.meterGens.get(connectorId);
    const payload: Record<string, unknown> = {
      connectorId,
      idTag,
      meterStart: gen?.energyWh ?? 0,
      timestamp: new Date().toISOString(),
    };
    if (reservationId != null) payload['reservationId'] = reservationId;
    return this.client.sendCall('StartTransaction', payload);
  }

  async sendStopTransaction(
    transactionId: number,
    meterStop: number,
    reason: string = 'Local',
    idTag?: string,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      transactionId,
      meterStop,
      timestamp: new Date().toISOString(),
      reason,
    };
    if (idTag != null) payload['idTag'] = idTag;
    return this.client.sendCall('StopTransaction', payload);
  }

  async sendDiagnosticsStatusNotification(status: string): Promise<Record<string, unknown>> {
    return this.client.sendCall('DiagnosticsStatusNotification', { status });
  }

  // ---------------------------------------------------------------------------
  // Group 6: Clock-aligned (public, called by ClockAlignedScheduler)
  // ---------------------------------------------------------------------------

  /** Start internal clock-aligned meter value timer. */
  startClockAlignedTimer(): void {
    this.stopClockAlignedTimer();
    const intervalSec = this.getAlignedIntervalSeconds();
    console.log(`[${this.config.stationId}] Clock-aligned timer: interval=${String(intervalSec)}s`);
    if (intervalSec <= 0) return;
    this.clockAlignedTimer = setInterval(() => {
      console.log(`[${this.config.stationId}] Clock-aligned timer FIRED`);
      void this.sendClockAlignedMeterValues().catch(() => {});
    }, intervalSec * 1000);
  }

  /** Stop internal clock-aligned meter value timer. */
  stopClockAlignedTimer(): void {
    if (this.clockAlignedTimer != null) {
      clearInterval(this.clockAlignedTimer);
      this.clockAlignedTimer = null;
    }
  }

  sendClockAlignedMeterValues(): Promise<void> {
    const interval = this.getAlignedIntervalSeconds();
    if (interval <= 0) {
      console.log(
        `[${this.config.stationId}] Clock-aligned: interval=${String(interval)}, skipping`,
      );
      return Promise.resolve();
    }
    if (!this.client.isConnected) {
      console.log(`[${this.config.stationId}] Clock-aligned: not connected, skipping`);
      return Promise.resolve();
    }

    const measurands = this.getAlignedMeasurands();
    if (measurands.length === 0) {
      console.log(`[${this.config.stationId}] Clock-aligned: no measurands, skipping`);
      return Promise.resolve();
    }

    // Use the first EVSE's generator for station-level readings
    const firstEvse = this.config.evses[0];
    if (firstEvse == null) return Promise.resolve();
    const gen = this.meterGens.get(firstEvse.evseId);
    if (gen == null) return Promise.resolve();

    // Tick with idle=true for ambient readings
    gen.tick(true, this.evsePowerLimits.get(firstEvse.evseId) ?? null);

    const sampledValues = gen
      .generate(measurands, this.is16)
      .map((sv) => ({ ...sv, context: 'Sample.Clock' }));
    if (sampledValues.length === 0) return Promise.resolve();

    // OCPP 2.1 during transaction: send TransactionEvent Updated with MeterValueClock
    if (!this.is16) {
      const txId = this.getActiveTransactionSync(firstEvse.evseId);
      if (txId != null) {
        const seqNo = (this.evseSeqNo.get(firstEvse.evseId) ?? 0) + 1;
        this.evseSeqNo.set(firstEvse.evseId, seqNo);
        this.sendTransactionEvent(firstEvse.evseId, 'Updated', {
          triggerReason: 'MeterValueClock',
          transactionId: txId,
          chargingState: this.evseChargingState.get(firstEvse.evseId) ?? 'Charging',
          seqNo,
          meterValue: [
            { timestamp: new Date().toISOString(), sampledValue: sampledValues },
          ] as unknown as Array<Record<string, unknown>>,
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (
            !msg.includes('not open') &&
            !msg.includes('timed out') &&
            !msg.includes('Not connected') &&
            !msg.includes('disconnected')
          ) {
            console.warn(`[clock-aligned] ${this.config.stationId}: ${msg}`);
          }
        });
        return Promise.resolve();
      }
    }

    const payload = this.is16
      ? {
          connectorId: 0,
          meterValue: [{ timestamp: new Date().toISOString(), sampledValue: sampledValues }],
        }
      : {
          evseId: 0,
          meterValue: [{ timestamp: new Date().toISOString(), sampledValue: sampledValues }],
        };

    this.client.sendCall('MeterValues', payload).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        !msg.includes('not open') &&
        !msg.includes('timed out') &&
        !msg.includes('Not connected') &&
        !msg.includes('disconnected')
      ) {
        console.warn(`[clock-aligned] ${this.config.stationId}: ${msg}`);
      }
    });
    return Promise.resolve();
  }

  getAlignedIntervalSeconds(): number {
    if (this.is16) {
      const raw = Number(this.getConfigValue('ClockAlignedDataInterval') ?? '900');
      return isNaN(raw) || raw < 0 ? 0 : raw;
    }
    const raw = Number(this.getConfigValue('AlignedDataCtrlr.Interval') ?? '900');
    return isNaN(raw) || raw < 0 ? 0 : raw;
  }

  // ---------------------------------------------------------------------------
  // CSMS Command Handler (private)
  // ---------------------------------------------------------------------------

  private async handleCsmsCommand(
    _messageId: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    console.log(`[${this.config.stationId}] Received ${action} from CSMS`);

    // Per OCPP spec: a station in Rejected boot state must not accept CSMS commands.
    // OCPP 2.1: respond with CALLERROR SecurityError (except TriggerMessage for BootNotification)
    // OCPP 1.6: silently reject (1.6 does not have SecurityError CALLERROR)
    if (this.bootStatus === 'Rejected') {
      if (this.is16) {
        return { status: 'Rejected' };
      }
      const isTriggerBoot =
        action === 'TriggerMessage' &&
        (payload['requestedMessage'] as string) === 'BootNotification';
      if (!isTriggerBoot) {
        throw new Error('SecurityError: Station boot was rejected');
      }
    }

    // During Pending boot state, reject transaction-related commands
    // OCPP 2.1: RequestStartTransaction
    // OCPP 1.6: RemoteStartTransaction
    if (this.bootStatus === 'Pending') {
      if (action === 'RequestStartTransaction' || action === 'RemoteStartTransaction') {
        return { status: 'Rejected', statusInfo: { reasonCode: 'BootPending' } };
      }
    }

    switch (action) {
      case 'RequestStartTransaction': {
        const idToken = payload['idToken'] as Record<string, unknown>;
        const evseId = (payload['evseId'] as number | undefined) ?? 1;
        // Always use a remoteStartId for RequestStartTransaction so the CSS
        // sets triggerReason to 'RemoteStart'. Use the provided value or
        // generate one.
        const remoteStartId = (payload['remoteStartId'] as number | undefined) ?? 1;

        // Check if a transaction is already active on this EVSE
        const existingTx = await this.getActiveTransaction(evseId);
        if (existingTx != null) {
          return {
            status: 'Rejected',
            statusInfo: { reasonCode: 'TxInProgress' },
          };
        }

        // Check if EVSE is reserved for a different token
        const startTokenStr = idToken['idToken'] as string;
        for (const res of this.reservations.values()) {
          if (res.evseId === evseId || res.evseId === 0) {
            const tokenMatch = res.idToken === startTokenStr;
            const groupMatch = res.groupIdToken != null && res.groupIdToken === startTokenStr;
            if (!tokenMatch && !groupMatch) {
              return {
                status: 'Rejected',
                statusInfo: { reasonCode: 'ReservedForOtherToken' },
              };
            }
          }
        }

        try {
          const evseCtx = this.evseContexts.get(evseId) as EvseContext;
          const cableIn = evseCtx.cablePlugged;

          // Store charging profile if provided (stamp _evseId for GetChargingProfiles filtering)
          const chargingProfile = payload['chargingProfile'] as Record<string, unknown> | undefined;
          if (chargingProfile != null) {
            const profileId = chargingProfile['id'] as number | undefined;
            if (profileId != null) {
              this.chargingProfilesCache.set(profileId, { ...chargingProfile, _evseId: evseId });
            }
          }

          if (cableIn) {
            // Cable already plugged: start charging immediately
            const txId = await this.startCharging(
              evseId,
              idToken['idToken'] as string,
              (idToken['type'] as string | undefined) ?? 'ISO14443',
              remoteStartId,
            );
            return { status: 'Accepted', transactionId: txId };
          }

          // OCPP 2.1: Cable not plugged. Authorize and wait for cable plug-in.
          // Do not start transaction yet. Set authorized state so plugIn()
          // auto-starts the transaction when cable connects.
          evseCtx.authorizedToken = idToken['idToken'] as string;
          evseCtx.authorizedTokenType = (idToken['type'] as string | undefined) ?? 'ISO14443';
          evseCtx.state = 'Authorized';
          evseCtx.remoteStartId = remoteStartId;

          // Send StatusNotification Occupied (EVSE reserved for remote start)
          const connectorId = this.getConnectorId(evseId);
          this.evseConnectorStatus.set(evseId, 'Occupied');
          try {
            await this.sendStatusNotification(evseId, connectorId, 'Occupied');
          } catch {
            // Offline
          }

          // Start EVConnectionTimeout timer. When it fires, the station
          // ends the (not-yet-started) authorization with EVConnectTimeout.
          this.startEvConnectTimeoutTimerPreTx(evseId);

          return { status: 'Accepted' };
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : 'InternalError';
          return {
            status: 'Rejected',
            statusInfo: { reasonCode: reason },
          };
        }
      }

      case 'RequestStopTransaction': {
        const stopTxId = payload['transactionId'] as string;
        // Find the EVSE with this transaction
        const evseId = await this.findEvseForTransaction(stopTxId);
        if (evseId != null) {
          await this.stopCharging(evseId, 'Remote');
          return { status: 'Accepted' };
        }
        if (!this.is16) {
          return {
            status: 'Rejected',
            statusInfo: { reasonCode: 'UnknownTransaction' },
          };
        }
        return { status: 'Rejected' };
      }

      case 'RemoteStartTransaction': {
        const idTag16 = payload['idTag'] as string;
        const connId = (payload['connectorId'] as number | undefined) ?? 1;
        const ctx16 = this.evseContexts.get(connId);
        if (ctx16 == null) {
          return { status: 'Rejected' };
        }

        // Validate charging profile purpose if provided
        const rsProfile = payload['chargingProfile'] as Record<string, unknown> | undefined;
        if (rsProfile != null) {
          const rsPurpose = rsProfile['chargingProfilePurpose'] as string | undefined;
          if (rsPurpose != null && rsPurpose !== 'TxProfile') {
            return { status: 'Rejected' };
          }
        }

        // Reject if transaction already active on this connector
        if (ctx16.transactionId != null) {
          return { status: 'Rejected' };
        }

        // Accept the command - handle auth/start asynchronously
        // If cable is already plugged in, try to start immediately
        if (ctx16.cablePlugged) {
          // Fire-and-forget: attempt start, don't block the response
          void (async () => {
            try {
              await this.startCharging(connId, idTag16);
            } catch {
              // Auth failed or start failed - station stays in current state
            }
          })();
          return { status: 'Accepted' };
        }

        // Cable not plugged: authorize and wait for plug-in.
        // Set Authorized state so plugIn() will auto-start the transaction.
        void (async () => {
          try {
            const authResult = await this.sendAuthorize(idTag16, 'ISO14443');
            const authInfo = authResult['idTagInfo'] as Record<string, unknown> | undefined;
            if (authInfo?.['status'] === 'Accepted') {
              ctx16.authorizedToken = idTag16;
              ctx16.authorizedTokenType = 'ISO14443';
              ctx16.state = 'Authorized';
              ctx16.remoteStartId = 1;
              this.evseConnectorStatus.set(connId, 'Preparing');
              const connId16 = this.getConnectorId(connId);
              await this.sendStatusNotification(connId, connId16, 'Preparing');
              this.startConnectionTimeoutTimer(connId);
            }
          } catch {
            // Auth failed
          }
        })();
        return { status: 'Accepted' };
      }

      case 'RemoteStopTransaction': {
        const stopTxId16 = String(payload['transactionId'] as number);
        const evseId16 = await this.findEvseForTransaction(stopTxId16);
        if (evseId16 != null) {
          await this.stopCharging(evseId16, 'Remote');
          return { status: 'Accepted' };
        }
        return { status: 'Rejected' };
      }

      case 'Reset': {
        let resetType = payload['type'] as string;
        const resetEvseId = payload['evseId'] as number | undefined;

        // Map OCPP 1.6 reset types to internal types
        if (this.is16) {
          if (resetType === 'Hard') resetType = 'Immediate';
          if (resetType === 'Soft') resetType = 'OnIdle';
        }

        console.log(
          `[${this.config.stationId}] Resetting (${resetType}${resetEvseId != null ? ` evseId=${String(resetEvseId)}` : ''})`,
        );

        // Check if any EVSE has an active transaction
        const anyActive = await this.hasAnyActiveTransaction();

        // Version-appropriate stop reason for immediate resets
        const immediateStopReason = this.is16 ? 'HardReset' : 'ImmediateReset';

        // ImmediateAndResume: reject if ResumptionTimeout is 0 or not set
        if (resetType === 'ImmediateAndResume') {
          const resumptionTimeout = this.configVariables.get('TxCtrlr.ResumptionTimeout');
          const timeout = resumptionTimeout != null ? Number(resumptionTimeout.value) : 0;
          if (timeout <= 0) {
            return { status: 'Rejected' };
          }
          // Stop active transactions, reset, then resume
          if (anyActive) {
            for (const evse of this.config.evses) {
              const tx = await this.getActiveTransaction(evse.evseId);
              if (tx != null) {
                await this.stopCharging(evse.evseId, immediateStopReason);
              }
            }
          }
          void this.simulateReset(resetType).catch(() => {});
          return { status: 'Accepted' };
        }

        if (resetType === 'OnIdle' && anyActive) {
          if (this.is16) {
            // OCPP 1.6 Soft Reset: stop all transactions then reboot
            const softStopReason = 'SoftReset';
            for (const evse of this.config.evses) {
              const tx = await this.getActiveTransaction(evse.evseId);
              if (tx != null) {
                await this.stopCharging(evse.evseId, softStopReason);
              }
            }
            void this.simulateReset(resetType).catch(() => {});
            return { status: 'Accepted' };
          }
          this.pendingReset = resetType;
          return {
            status: 'Scheduled',
            statusInfo: { reasonCode: 'TransactionInProgress' },
          };
        }

        // Immediate reset: stop all active transactions first
        if (resetType === 'Immediate' && anyActive) {
          for (const evse of this.config.evses) {
            const tx = await this.getActiveTransaction(evse.evseId);
            if (tx != null) {
              await this.stopCharging(evse.evseId, immediateStopReason);
            }
          }
        }

        void this.simulateReset(resetType).catch(() => {});
        return { status: 'Accepted' };
      }

      case 'UnlockConnector': {
        const unlockEvseId =
          (payload['evseId'] as number | undefined) ??
          (payload['connectorId'] as number | undefined) ??
          1;
        const unlockConnectorId = this.is16
          ? undefined
          : (payload['connectorId'] as number | undefined);
        console.log(
          `[${this.config.stationId}] Unlocking connector on EVSE ${String(unlockEvseId)}`,
        );

        // Validate EVSE exists
        const unlockEvse = this.config.evses.find((e) => e.evseId === unlockEvseId);
        if (unlockEvse == null) {
          return { status: this.is16 ? 'NotSupported' : 'UnknownConnector' };
        }

        // OCPP 2.1: validate connectorId matches the EVSE's connector
        if (
          !this.is16 &&
          unlockConnectorId != null &&
          unlockConnectorId !== unlockEvse.connectorId
        ) {
          return { status: 'UnknownConnector' };
        }

        // Check if connector is unavailable
        if (this.availabilityState === 'Inoperative' || this.availabilityState === 'Unavailable') {
          return { status: 'UnlockFailed' };
        }

        // OCPP 2.1: If a transaction is active, return OngoingAuthorizedTransaction
        const unlockTx = await this.getActiveTransaction(unlockEvseId);
        if (unlockTx != null) {
          if (this.is16) {
            await this.stopCharging(unlockEvseId, 'UnlockCommand');
          } else {
            return { status: 'OngoingAuthorizedTransaction' };
          }
        }

        // Send StatusNotification Available after unlock
        const unlockConnId = this.getConnectorId(unlockEvseId);
        await this.sendStatusNotification(unlockEvseId, unlockConnId, 'Available');
        await this.updateEvseStatus(unlockEvseId, 'Available');
        const unlockCtx = this.evseContexts.get(unlockEvseId) as EvseContext;
        unlockCtx.state = 'Available';
        unlockCtx.cablePlugged = false;
        this.evseConnectorStatus.set(unlockEvseId, 'Available');

        return { status: 'Unlocked' };
      }

      case 'ChangeAvailability': {
        let newAvail: string;
        if (this.is16) {
          newAvail = payload['type'] as string;
          const connId16 = (payload['connectorId'] as number | undefined) ?? 0;
          console.log(
            `[${this.config.stationId}] Availability -> ${newAvail} (connector ${String(connId16)})`,
          );
        } else {
          newAvail = payload['operationalStatus'] as string;
          console.log(`[${this.config.stationId}] Availability -> ${newAvail}`);
        }
        this.availabilityState = newAvail;

        const anyActiveTx = await this.hasAnyActiveTransaction();
        if (anyActiveTx) {
          return { status: 'Scheduled' };
        }

        const statusValue =
          newAvail === 'Inoperative' || newAvail === 'Unavailable' ? 'Unavailable' : 'Available';

        // Determine target EVSEs from the payload
        let targetEvseId: number | undefined;
        if (!this.is16) {
          const evseObj = payload['evse'] as Record<string, unknown> | undefined;
          targetEvseId = evseObj?.['id'] as number | undefined;
        }

        for (const evse of this.config.evses) {
          // If a specific EVSE was targeted, only change that one
          if (targetEvseId != null && targetEvseId !== 0 && evse.evseId !== targetEvseId) continue;
          this.evseConnectorStatus.set(evse.evseId, statusValue);
          const availCtx = this.evseContexts.get(evse.evseId) as EvseContext;
          availCtx.state = statusValue;
          void this.sendStatusNotification(evse.evseId, evse.connectorId, statusValue).catch(
            () => {},
          );
        }

        // Cancel reservations on EVSEs going unavailable
        if (statusValue === 'Unavailable') {
          for (const [resId, res] of this.reservations) {
            const affectsEvse =
              targetEvseId == null ||
              targetEvseId === 0 ||
              res.evseId === targetEvseId ||
              res.evseId === 0;
            if (affectsEvse) {
              clearTimeout(res.expiryTimer);
              this.reservations.delete(resId);
              void this.sendReservationStatusUpdate(resId, 'Removed').catch(() => {});
              void this.sql`
                DELETE FROM css_reservations
                WHERE css_station_id = ${this.config.id} AND reservation_id = ${resId}
              `.catch(() => {});
            }
          }
        }

        return { status: 'Accepted' };
      }

      case 'TriggerMessage': {
        const requestedMessage = payload['requestedMessage'] as string;
        const customTrigger = payload['customTrigger'] as string | undefined;
        console.log(`[${this.config.stationId}] TriggerMessage: ${requestedMessage}`);

        const validMessages16 = [
          'BootNotification',
          'DiagnosticsStatusNotification',
          'FirmwareStatusNotification',
          'Heartbeat',
          'MeterValues',
          'StatusNotification',
        ];
        const validMessages21 = [
          'BootNotification',
          'FirmwareStatusNotification',
          'Heartbeat',
          'MeterValues',
          'StatusNotification',
          'LogStatusNotification',
          'TransactionEvent',
          'SignChargingStationCertificate',
          'PublishFirmwareStatusNotification',
          'CustomTrigger',
        ];
        const validSet = this.is16 ? validMessages16 : validMessages21;

        if (!validSet.includes(requestedMessage)) {
          return { status: 'NotImplemented' };
        }

        // OCPP 2.1: Reject BootNotification trigger if already booted successfully
        if (
          !this.is16 &&
          requestedMessage === 'BootNotification' &&
          this.bootStatus === 'Accepted'
        ) {
          return { status: 'Rejected' };
        }

        // OCPP 2.1: CustomTrigger validation
        if (!this.is16 && requestedMessage === 'CustomTrigger') {
          if (customTrigger == null || !this.customTriggers.includes(customTrigger)) {
            return { status: 'NotImplemented' };
          }
        }

        // Validate connectorId/evseId if provided
        const triggerEvseObj = payload['evse'] as Record<string, unknown> | undefined;
        const triggerConnId =
          (payload['connectorId'] as number | undefined) ??
          (triggerEvseObj?.['id'] as number | undefined);
        if (triggerConnId != null && triggerConnId > 0) {
          const triggerEvse = this.config.evses.find((e) => e.evseId === triggerConnId);
          if (triggerEvse == null) {
            return { status: 'Rejected' };
          }
        }

        setTimeout(() => {
          void this.handleTriggerMessage(requestedMessage, payload).catch(() => {});
        }, 100);
        return { status: 'Accepted' };
      }

      case 'GetVariables': {
        const getVarData = (payload['getVariableData'] ?? []) as Array<Record<string, unknown>>;
        return {
          getVariableResult: getVarData.map((item) => {
            const comp = item['component'] as Record<string, unknown>;
            const vari = item['variable'] as Record<string, unknown>;
            const compName = comp['name'] as string;
            const varName = vari['name'] as string;
            const varInstance =
              (comp['instance'] as string | undefined) ?? (vari['instance'] as string | undefined);
            const lookupKey =
              varInstance != null
                ? `${compName}.${varName}#${varInstance}`
                : `${compName}.${varName}`;
            const reqAttrType = (item['attributeType'] as string | undefined) ?? 'Actual';

            // Check if component exists
            let componentExists = false;
            for (const key of this.configVariables.keys()) {
              if (key.startsWith(compName + '.')) {
                componentExists = true;
                break;
              }
            }

            if (!componentExists) {
              return {
                attributeStatus: 'UnknownComponent',
                attributeType: reqAttrType,
                component: item['component'],
                variable: item['variable'],
              };
            }

            // Try instance key first, fall back to non-instance key
            let entry = this.configVariables.get(lookupKey);
            if (entry == null && varInstance != null) {
              entry = this.configVariables.get(`${compName}.${varName}`);
            }
            if (entry == null) {
              return {
                attributeStatus: 'UnknownVariable',
                attributeType: reqAttrType,
                component: item['component'],
                variable: item['variable'],
              };
            }

            // Only Actual attribute type is supported
            if (reqAttrType !== 'Actual') {
              return {
                attributeStatus: 'NotSupportedAttributeType',
                attributeType: reqAttrType,
                component: item['component'],
                variable: item['variable'],
              };
            }

            return {
              attributeStatus: 'Accepted',
              attributeType: reqAttrType,
              attributeValue: entry.value,
              component: item['component'],
              variable: item['variable'],
            };
          }),
        };
      }

      case 'SetVariables': {
        const setVarData = (payload['setVariableData'] ?? []) as Array<Record<string, unknown>>;
        const result = setVarData.map((item) => {
          const comp = item['component'] as Record<string, unknown>;
          const vari = item['variable'] as Record<string, unknown>;
          const compName = comp['name'] as string;
          const varName = vari['name'] as string;
          const compInstance =
            (comp['instance'] as string | undefined) ?? (vari['instance'] as string | undefined);
          const lookupKey =
            compInstance != null
              ? `${compName}.${varName}#${compInstance}`
              : `${compName}.${varName}`;
          const newValue = item['attributeValue'] as string;
          const reqAttrType = (item['attributeType'] as string | undefined) ?? 'Actual';

          // Check if component exists in device model
          let componentExists = false;
          for (const key of this.configVariables.keys()) {
            if (key.startsWith(compName + '.')) {
              componentExists = true;
              break;
            }
          }

          if (!componentExists) {
            return {
              attributeStatus: 'UnknownComponent',
              attributeType: reqAttrType,
              component: item['component'],
              variable: item['variable'],
            };
          }

          // Check if variable exists under the component.
          // Try instance key first, fall back to non-instance key.
          let existing = this.configVariables.get(lookupKey);
          let effectiveKey = lookupKey;
          if (existing == null && compInstance != null) {
            const baseKey = `${compName}.${varName}`;
            existing = this.configVariables.get(baseKey);
            if (existing != null) effectiveKey = baseKey;
          }
          if (existing == null) {
            return {
              attributeStatus: 'UnknownVariable',
              attributeType: reqAttrType,
              component: item['component'],
              variable: item['variable'],
            };
          }

          // Check if attribute type is supported (only Actual is supported)
          if (reqAttrType !== 'Actual') {
            return {
              attributeStatus: 'NotSupportedAttributeType',
              attributeType: reqAttrType,
              component: item['component'],
              variable: item['variable'],
            };
          }

          // Check if readonly
          if (existing.readonly) {
            return {
              attributeStatus: 'Rejected',
              attributeType: reqAttrType,
              component: item['component'],
              variable: item['variable'],
            };
          }

          // Validate BasicAuthPassword length (16-40 chars per OCPP spec)
          if (varName === 'BasicAuthPassword' && (newValue.length < 16 || newValue.length > 40)) {
            return {
              attributeStatus: 'Rejected',
              attributeType: reqAttrType,
              component: item['component'],
              variable: item['variable'],
            };
          }

          // Prevent security profile downgrade via SetVariables
          if (compName === 'NetworkConfiguration' && varName === 'SecurityProfile') {
            const currentSecProfile = Number(
              this.configVariables.get('SecurityCtrlr.SecurityProfile')?.value ?? '0',
            );
            const allowDowngrade =
              this.configVariables.get('SecurityCtrlr.AllowSecurityDowngrade')?.value === 'true';
            if (Number(newValue) < currentSecProfile && !allowDowngrade) {
              return {
                attributeStatus: 'Rejected',
                attributeType: reqAttrType,
                component: item['component'],
                variable: item['variable'],
              };
            }
          }

          // Prevent modifying NetworkConfiguration on the active slot
          if (compName === 'NetworkConfiguration' && compInstance != null) {
            const priority =
              this.configVariables.get('OCPPCommCtrlr.NetworkConfigurationPriority')?.value ?? '1';
            const activeSlot = priority.split(',')[0]?.trim();
            if (compInstance === activeSlot) {
              return {
                attributeStatus: 'Rejected',
                attributeType: reqAttrType,
                component: item['component'],
                variable: item['variable'],
              };
            }
          }

          // Validate NetworkConfigurationPriority: all referenced slots must have a valid URL
          if (compName === 'OCPPCommCtrlr' && varName === 'NetworkConfigurationPriority') {
            const slots = newValue.split(',').map((s) => s.trim());
            for (const slot of slots) {
              const url = this.configVariables.get(`NetworkConfiguration.OcppCsmsUrl#${slot}`);
              if (url == null || url.value === '') {
                return {
                  attributeStatus: 'Rejected',
                  attributeType: reqAttrType,
                  component: item['component'],
                  variable: item['variable'],
                };
              }
            }
          }

          this.configVariables.set(effectiveKey, { value: newValue, readonly: false });
          // Persist to DB async
          void this.saveConfigVariable(effectiveKey, newValue).catch(() => {});

          return {
            attributeStatus: 'Accepted',
            attributeType: reqAttrType,
            component: item['component'],
            variable: item['variable'],
          };
        });
        return { setVariableResult: result };
      }

      case 'GetConfiguration': {
        const requestedKeys = payload['key'] as string[] | undefined;
        const configurationKey: Array<{ key: string; readonly: boolean; value: string }> = [];
        const unknownKey: string[] = [];

        if (requestedKeys != null && requestedKeys.length > 0) {
          for (const k of requestedKeys) {
            const entry = this.configVariables.get(k);
            if (entry != null) {
              configurationKey.push({ key: k, readonly: entry.readonly, value: entry.value });
            } else {
              unknownKey.push(k);
            }
          }
        } else {
          for (const [k, entry] of this.configVariables) {
            configurationKey.push({ key: k, readonly: entry.readonly, value: entry.value });
          }
        }

        return { configurationKey, unknownKey };
      }

      case 'ChangeConfiguration': {
        const cfgKey = payload['key'] as string;
        const cfgValue = payload['value'] as string;
        const existing = this.configVariables.get(cfgKey);

        if (existing == null) {
          return { status: 'NotSupported' };
        }
        if (existing.readonly) {
          return { status: 'Rejected' };
        }

        // Validate integer configuration keys
        const integerKeys = new Set([
          'MeterValueSampleInterval',
          'HeartbeatInterval',
          'ConnectionTimeOut',
          'ClockAlignedDataInterval',
          'ResetRetries',
          'TransactionMessageAttempts',
          'TransactionMessageRetryInterval',
          'WebSocketPingInterval',
          'LocalAuthListMaxLength',
          'ChargeProfileMaxStackLevel',
          'ChargingScheduleMaxPeriods',
          'MaxChargingProfilesInstalled',
          'GetConfigurationMaxKeys',
          'NumberOfConnectors',
        ]);
        if (integerKeys.has(cfgKey)) {
          const numVal = Number(cfgValue);
          if (isNaN(numVal) || numVal < 0 || !Number.isInteger(numVal)) {
            return { status: 'Rejected' };
          }
        }

        existing.value = cfgValue;
        void this.saveConfigVariable(cfgKey, cfgValue).catch(() => {});

        const rebootKeys = new Set(['WebSocketPingInterval', 'ConnectionTimeOut']);
        return { status: rebootKeys.has(cfgKey) ? 'RebootRequired' : 'Accepted' };
      }

      case 'ClearCache': {
        // OCPP 2.1: reject when AuthCacheCtrlr.Enabled is false
        if (!this.is16 && this.getConfigValue('AuthCacheCtrlr.Enabled') === 'false') {
          return { status: 'Rejected' };
        }
        this.clearAuthCache();
        return { status: 'Accepted' };
      }

      case 'GetBaseReport': {
        const baseReportRequestId = payload['requestId'] as number;
        if (!this.is16) {
          void this.sendNotifyReport(baseReportRequestId).catch(() => {});
        }
        return { status: 'Accepted' };
      }

      case 'GetReport': {
        const getReportRequestId = payload['requestId'] as number;
        const componentCriteria = payload['componentCriteria'] as string[] | undefined;
        const componentVariable = payload['componentVariable'] as
          | Array<{
              component: { name: string; evse?: { id: number }; instance?: string };
              variable: { name: string; instance?: string };
            }>
          | undefined;

        // Validate componentCriteria values
        const validCriteria = new Set(['Active', 'Available', 'Enabled', 'Problem']);
        if (componentCriteria != null) {
          const hasInvalid = componentCriteria.some((c) => !validCriteria.has(c));
          if (hasInvalid) {
            return { status: 'NotSupported' };
          }
        }

        if (!this.is16) {
          // Check if any variables match the filter before sending
          const matchCount = this.countMatchingVariables({
            componentCriteria: componentCriteria ?? undefined,
            componentVariable: componentVariable ?? undefined,
          });
          if (matchCount === 0) {
            return { status: 'EmptyResultSet' };
          }
          void this.sendNotifyReport(getReportRequestId, {
            componentCriteria: componentCriteria ?? undefined,
            componentVariable: componentVariable ?? undefined,
          }).catch(() => {});
        }
        return { status: 'Accepted' };
      }

      case 'SetChargingProfile': {
        const profile = (payload['csChargingProfiles'] ?? payload['chargingProfile']) as
          | Record<string, unknown>
          | undefined;
        const evseIdForProfile =
          (payload['evseId'] as number | undefined) ??
          (payload['connectorId'] as number | undefined) ??
          1;

        // Validate: TxProfile on connectorId 0 is rejected
        const profilePurpose = profile?.['chargingProfilePurpose'] as string | undefined;
        if (profilePurpose === 'TxProfile' && evseIdForProfile === 0) {
          return { status: 'Rejected' };
        }

        // Validate: TxProfile must have matching transactionId
        if (profilePurpose === 'TxProfile') {
          if (this.is16) {
            const profileTxId = profile?.['transactionId'] as number | undefined;
            if (profileTxId != null) {
              const activeTxForProfile = await this.getActiveTransaction(evseIdForProfile);
              if (
                activeTxForProfile == null ||
                Number(activeTxForProfile.transactionId) !== profileTxId
              ) {
                return { status: 'Rejected' };
              }
            }
          } else {
            // OCPP 2.1: TxProfile requires an active transaction on the specified EVSE
            const activeTxForProfile = await this.getActiveTransaction(evseIdForProfile);
            const profileTxId21 = profile?.['transactionId'] as string | undefined;
            if (activeTxForProfile == null) {
              return { status: 'Rejected' };
            }
            if (profileTxId21 != null && activeTxForProfile.transactionId !== profileTxId21) {
              return { status: 'Rejected' };
            }
          }
        }

        // Extract power limit
        const schedule = (
          (profile?.['chargingSchedule'] ?? []) as Array<Record<string, unknown>>
        )[0];
        const periods = (
          (schedule?.['chargingSchedulePeriod'] ?? []) as Array<Record<string, unknown>>
        )[0];
        const limit = periods?.['limit'] as number | undefined;
        if (limit != null) {
          this.evsePowerLimits.set(evseIdForProfile, limit);
          console.log(
            `[${this.config.stationId}] SetChargingProfile: power limit set to ${String(limit)} W on EVSE ${String(evseIdForProfile)}`,
          );
        }

        // Store in memory cache (stamp _evseId and _chargingLimitSource for GetChargingProfiles)
        if (profile != null) {
          const profileId =
            (profile['id'] as number | undefined) ??
            (profile['chargingProfileId'] as number | undefined) ??
            0;
          const source = profilePurpose === 'ChargingStationExternalConstraints' ? 'EMS' : 'CSO';
          this.chargingProfilesCache.set(profileId, {
            ...profile,
            _evseId: evseIdForProfile,
            _chargingLimitSource: source,
          });
        }

        // Persist to DB
        if (profile != null) {
          const profileId =
            (profile['id'] as number | undefined) ??
            (profile['chargingProfileId'] as number | undefined) ??
            0;
          const id = 'ccp_' + randomUUID().replace(/-/g, '').slice(0, 12);
          void this.sql`
            INSERT INTO css_charging_profiles (id, css_station_id, profile_id, evse_id, profile_data)
            VALUES (${id}, ${this.config.id}, ${profileId}, ${evseIdForProfile}, ${JSON.stringify(profile)})
            ON CONFLICT (css_station_id, profile_id) DO UPDATE
            SET evse_id = EXCLUDED.evse_id, profile_data = EXCLUDED.profile_data
          `.catch(() => {});
        }

        return { status: 'Accepted' };
      }

      case 'ClearChargingProfile': {
        const clearProfileId = payload['chargingProfileId'] as number | undefined;
        const clearCriteria = payload['chargingProfileCriteria'] as
          | Record<string, unknown>
          | undefined;

        // OCPP 1.6: simple clear all
        if (this.is16) {
          for (const evse of this.config.evses) {
            this.evsePowerLimits.set(evse.evseId, null);
          }
          this.chargingProfilesCache.clear();
          console.log(`[${this.config.stationId}] ClearChargingProfile: power limits cleared`);
          void this.sql`
            DELETE FROM css_charging_profiles WHERE css_station_id = ${this.config.id}
          `.catch(() => {});
          return { status: 'Accepted' };
        }

        // OCPP 2.1: filter and clear matching profiles
        let cleared = false;
        if (clearProfileId != null) {
          // Clear by specific profile ID
          if (this.chargingProfilesCache.has(clearProfileId)) {
            this.chargingProfilesCache.delete(clearProfileId);
            cleared = true;
          }
          void this.sql`
            DELETE FROM css_charging_profiles
            WHERE css_station_id = ${this.config.id} AND profile_id = ${clearProfileId}
          `.catch(() => {});
        } else if (clearCriteria != null) {
          // Clear by criteria: purpose, stackLevel, evseId
          const critPurpose = clearCriteria['chargingProfilePurpose'] as string | undefined;
          const critStackLevel = clearCriteria['stackLevel'] as number | undefined;
          const toDelete: number[] = [];
          for (const [profileId, profile] of this.chargingProfilesCache.entries()) {
            let matches = true;
            if (critPurpose != null && profile['chargingProfilePurpose'] !== critPurpose)
              matches = false;
            if (critStackLevel != null && profile['stackLevel'] !== critStackLevel) matches = false;
            if (matches) toDelete.push(profileId);
          }
          for (const profileId of toDelete) {
            this.chargingProfilesCache.delete(profileId);
            cleared = true;
          }
          // Also clear from DB
          void this.sql`
            DELETE FROM css_charging_profiles WHERE css_station_id = ${this.config.id}
          `.catch(() => {});
        } else {
          // No criteria: clear all
          if (this.chargingProfilesCache.size > 0) cleared = true;
          this.chargingProfilesCache.clear();
          void this.sql`
            DELETE FROM css_charging_profiles WHERE css_station_id = ${this.config.id}
          `.catch(() => {});
        }

        if (cleared) {
          for (const evse of this.config.evses) {
            this.evsePowerLimits.set(evse.evseId, null);
          }
          console.log(`[${this.config.stationId}] ClearChargingProfile: power limits cleared`);
          return { status: 'Accepted' };
        }
        return { status: 'Unknown' };
      }

      case 'GetCompositeSchedule': {
        const gcs_rateUnit = (payload['chargingRateUnit'] as string | undefined) ?? 'A';
        if (this.is16) {
          const gcs_connId = (payload['connectorId'] as number | undefined) ?? 1;
          const gcs_dur16 = (payload['duration'] as number | undefined) ?? 86400;
          return {
            status: 'Accepted',
            connectorId: gcs_connId,
            scheduleStart: new Date().toISOString(),
            chargingSchedule: {
              chargingRateUnit: gcs_rateUnit,
              chargingSchedulePeriod: [
                { startPeriod: 0, limit: 11000, numberPhases: 3 },
                { startPeriod: 3600, limit: 22000, numberPhases: 3 },
              ],
              duration: gcs_dur16,
            },
          };
        }
        // OCPP 2.1
        const gcs_evseId = (payload['evseId'] as number | undefined) ?? 0;
        const gcs_duration = (payload['duration'] as number | undefined) ?? 86400;
        // Reject unsupported chargingRateUnit (simulator only supports A)
        if (gcs_rateUnit !== 'A') {
          return { status: 'Rejected' };
        }
        // Reject unknown EVSE IDs (0 is station-level, always valid)
        if (gcs_evseId !== 0) {
          const validEvse = this.config.evses.some((e) => e.evseId === gcs_evseId);
          if (!validEvse) {
            return { status: 'Rejected' };
          }
        }
        return {
          status: 'Accepted',
          schedule: {
            evseId: gcs_evseId,
            duration: gcs_duration,
            scheduleStart: new Date().toISOString(),
            chargingRateUnit: gcs_rateUnit,
            chargingSchedulePeriod: [
              { startPeriod: 0, limit: 32, numberPhases: 3 },
              { startPeriod: 3600, limit: 32, numberPhases: 3 },
            ],
          },
        };
      }

      case 'GetChargingProfiles': {
        const cpRequestId = payload['requestId'] as number;
        const cpEvseId = payload['evseId'] as number | undefined;
        const cpSource = (payload['chargingLimitSource'] as string | undefined) ?? 'CSO';
        const cpCriteria = payload['chargingProfile'] as Record<string, unknown> | undefined;

        // Use in-memory cache first, fall back to DB
        let allProfiles: Array<Record<string, unknown>>;
        if (this.chargingProfilesCache.size > 0) {
          allProfiles = Array.from(this.chargingProfilesCache.values());
        } else {
          const dbProfiles = await this.sql`
            SELECT profile_data, evse_id FROM css_charging_profiles
            WHERE css_station_id = ${this.config.id}
          `;
          allProfiles = dbProfiles.map((r) => ({
            ...(r.profile_data as Record<string, unknown>),
            _evseId: r.evse_id as number,
          }));
        }

        // Filter by evseId: if specified, only return profiles for that EVSE
        // evseId=0 means station-level profiles only; omitted means all profiles
        let filtered = allProfiles;
        if (cpEvseId != null) {
          filtered = filtered.filter((p) => (p['_evseId'] as number | undefined) === cpEvseId);
        }
        if (cpCriteria != null) {
          const rawProfileId = cpCriteria['chargingProfileId'];
          const filterProfileIds: number[] | undefined = Array.isArray(rawProfileId)
            ? rawProfileId
            : typeof rawProfileId === 'number'
              ? [rawProfileId]
              : undefined;
          const filterPurpose = cpCriteria['chargingProfilePurpose'] as string | undefined;
          const filterStackLevel = cpCriteria['stackLevel'] as number | undefined;
          const rawSource = cpCriteria['chargingLimitSource'];
          const filterSources: string[] | undefined = Array.isArray(rawSource)
            ? rawSource
            : typeof rawSource === 'string'
              ? [rawSource]
              : undefined;
          filtered = filtered.filter((p) => {
            if (filterProfileIds != null) {
              const pId =
                (p['id'] as number | undefined) ?? (p['chargingProfileId'] as number | undefined);
              if (pId == null || !filterProfileIds.includes(pId)) return false;
            }
            if (filterPurpose != null && p['chargingProfilePurpose'] !== filterPurpose)
              return false;
            if (filterStackLevel != null && p['stackLevel'] !== filterStackLevel) return false;
            if (filterSources != null) {
              const profileSource = (p['_chargingLimitSource'] as string | undefined) ?? 'CSO';
              if (!filterSources.includes(profileSource)) return false;
            }
            return true;
          });
        }

        if (filtered.length === 0) {
          return { status: 'NoProfiles' };
        }

        if (!this.is16) {
          const reportEvseId = cpEvseId ?? 1;
          // Strip internal metadata before sending
          const cleanProfiles = filtered.map((p) => {
            const { _evseId: _unused, _chargingLimitSource: _unused2, ...rest } = p;
            void _unused;
            void _unused2;
            return rest;
          });
          // Determine the chargingLimitSource from the matched profiles
          const reportSource =
            (filtered[0]?.['_chargingLimitSource'] as string | undefined) ?? cpSource;
          setTimeout(() => {
            void this.sendReportChargingProfiles(
              cpRequestId,
              cleanProfiles,
              reportEvseId,
              reportSource,
            ).catch(() => {});
          }, 200);
        }
        return { status: 'Accepted' };
      }

      case 'ReserveNow': {
        // Check if reservation feature is supported
        if (this.is16) {
          const profiles = this.getConfigValue('SupportedFeatureProfiles') ?? '';
          if (!profiles.includes('Reservation')) {
            return { status: 'Rejected' };
          }
        } else {
          const resEnabled = this.getConfigValue('ReservationCtrlr.Enabled');
          if (resEnabled === 'false') {
            return { status: 'Rejected', statusInfo: { reasonCode: 'UnavailableReservation' } };
          }
        }

        let reservationId: number;
        let reserveEvseId: number;
        let reserveIdTokenStr: string;
        let expiryDateTime: string;

        let groupIdTokenStr: string | undefined;
        let reserveConnectorType: string | undefined;

        if (this.is16) {
          reservationId = payload['reservationId'] as number;
          reserveEvseId = (payload['connectorId'] as number | undefined) ?? 1;
          reserveIdTokenStr = payload['idTag'] as string;
          expiryDateTime = payload['expiryDate'] as string;
        } else {
          reservationId = payload['id'] as number;
          // OCPP 2.1: omitted evseId means "any EVSE" (0)
          reserveEvseId = (payload['evseId'] as number | undefined) ?? 0;
          const reserveIdToken = payload['idToken'] as Record<string, unknown>;
          reserveIdTokenStr = reserveIdToken['idToken'] as string;
          expiryDateTime = payload['expiryDateTime'] as string;
          const gidToken = payload['groupIdToken'] as Record<string, unknown> | undefined;
          if (gidToken != null) {
            groupIdTokenStr = gidToken['idToken'] as string;
          }
          reserveConnectorType = payload['connectorType'] as string | undefined;
        }

        // If same reservation ID exists, this is a replacement. Remove old one first.
        const existingRes = this.reservations.get(reservationId);
        if (existingRes != null) {
          clearTimeout(existingRes.expiryTimer);
          this.reservations.delete(reservationId);
          void this.sql`
            DELETE FROM css_reservations
            WHERE css_station_id = ${this.config.id} AND reservation_id = ${reservationId}
          `.catch(() => {});
        }

        // Filter EVSEs by connectorType if specified (OCPP 2.1)
        // Map OCPP 2.1 connector type enum to internal CSS type
        const ocppToInternalType: Record<string, string> = {
          cType2: 'ac_type2',
          cType1: 'ac_type1',
          cCCS2: 'dc_ccs2',
          cCCS1: 'dc_ccs1',
          cCHAdeMO: 'dc_chademo',
        };
        const candidateEvses =
          reserveConnectorType != null
            ? this.config.evses.filter(
                (e) =>
                  e.connectorType === reserveConnectorType ||
                  e.connectorType === ocppToInternalType[reserveConnectorType],
              )
            : this.config.evses;

        // Check connector status
        // For connectorId 0 (any connector), check all connectors
        if (reserveEvseId === 0) {
          let hasFaulted = false;
          let allUnavailable = true;
          let allOccupiedOrReserved = true;
          for (const evse of candidateEvses) {
            const status = this.evseConnectorStatus.get(evse.evseId) ?? 'Available';
            if (status === 'Faulted') hasFaulted = true;
            if (status !== 'Unavailable') allUnavailable = false;
            const isOccupied =
              status === 'Charging' || status === 'Occupied' || status === 'Preparing';
            const isReserved = status === 'Reserved';
            if (!isOccupied && !isReserved) allOccupiedOrReserved = false;
          }
          // Also count in-memory reservations for EVSEs that might still show Available
          // (race between reservation set and StatusNotification)
          if (!allOccupiedOrReserved) {
            let allBusyOrReserved = true;
            for (const evse of candidateEvses) {
              const status = this.evseConnectorStatus.get(evse.evseId) ?? 'Available';
              const isOccupied =
                status === 'Charging' || status === 'Occupied' || status === 'Preparing';
              let hasReservation = status === 'Reserved';
              if (!hasReservation) {
                for (const r of this.reservations.values()) {
                  if (r.evseId === evse.evseId || r.evseId === 0) {
                    hasReservation = true;
                    break;
                  }
                }
              }
              if (!isOccupied && !hasReservation) {
                allBusyOrReserved = false;
                break;
              }
            }
            allOccupiedOrReserved = allBusyOrReserved;
          }
          if (hasFaulted) return { status: 'Faulted' };
          if (allUnavailable) return { status: 'Unavailable' };
          if (allOccupiedOrReserved) return { status: 'Occupied' };
        } else {
          const connStatus = this.evseConnectorStatus.get(reserveEvseId) ?? 'Available';
          if (connStatus === 'Faulted') return { status: 'Faulted' };
          if (connStatus === 'Unavailable') return { status: 'Unavailable' };
          if (
            connStatus === 'Charging' ||
            connStatus === 'Occupied' ||
            connStatus === 'Preparing'
          ) {
            return { status: 'Occupied' };
          }
        }

        // Check for active transaction on this EVSE
        const activeTx = reserveEvseId > 0 ? await this.getActiveTransaction(reserveEvseId) : null;
        if (activeTx != null) {
          const occupiedResponse: Record<string, unknown> = { status: 'Occupied' };
          if (!this.is16) {
            occupiedResponse['statusInfo'] = { reasonCode: 'TransactionInProgress' };
          }
          return occupiedResponse;
        }

        // Check for existing reservation on this EVSE (different reservation ID)
        let evseReserved = false;
        for (const r of this.reservations.values()) {
          if (r.evseId === reserveEvseId) {
            evseReserved = true;
            break;
          }
        }
        if (evseReserved) {
          return { status: 'Occupied' };
        }

        // For unspecified EVSE (evseId=0), pick a free EVSE from candidates
        let assignedEvseId = reserveEvseId;
        if (reserveEvseId === 0) {
          for (const evse of candidateEvses) {
            const status = this.evseConnectorStatus.get(evse.evseId) ?? 'Available';
            if (status === 'Available') {
              let hasRes = false;
              for (const r of this.reservations.values()) {
                if (r.evseId === evse.evseId) {
                  hasRes = true;
                  break;
                }
              }
              if (!hasRes) {
                assignedEvseId = evse.evseId;
                break;
              }
            }
          }
          // If no free EVSE found, keep evseId=0 (reservation for any)
        }

        // Set expiry timer
        const expiryMs = new Date(expiryDateTime).getTime() - Date.now();
        const expiryTimer = setTimeout(
          () => {
            this.reservations.delete(reservationId);
            console.log(`[${this.config.stationId}] Reservation ${String(reservationId)} expired`);
            if (assignedEvseId > 0) {
              this.evseConnectorStatus.set(assignedEvseId, 'Available');
            }
            void this.sendReservationStatusUpdate(reservationId, 'Expired').catch(() => {});
            if (assignedEvseId > 0) {
              void this.sendStatusNotification(
                assignedEvseId,
                this.getConnectorId(assignedEvseId),
                'Available',
              ).catch(() => {});
            }
            // Remove from DB
            void this.sql`
              DELETE FROM css_reservations
              WHERE css_station_id = ${this.config.id} AND reservation_id = ${reservationId}
            `.catch(() => {});
          },
          Math.max(expiryMs, 0),
        );

        this.reservations.set(reservationId, {
          id: reservationId,
          evseId: assignedEvseId,
          idToken: reserveIdTokenStr,
          groupIdToken: groupIdTokenStr,
          connectorType: reserveConnectorType,
          expiryDateTime,
          expiryTimer,
        });

        // Persist to DB
        const reservationRowId = 'crv_' + randomUUID().replace(/-/g, '').slice(0, 12);
        void this.sql`
          INSERT INTO css_reservations (id, css_station_id, reservation_id, evse_id, id_token, expiry_date_time)
          VALUES (${reservationRowId}, ${this.config.id}, ${reservationId}, ${assignedEvseId}, ${reserveIdTokenStr}, ${expiryDateTime})
          ON CONFLICT (css_station_id, reservation_id) DO UPDATE
          SET evse_id = EXCLUDED.evse_id, id_token = EXCLUDED.id_token, expiry_date_time = EXCLUDED.expiry_date_time
        `.catch(() => {});

        console.log(
          `[${this.config.stationId}] Reservation ${String(reservationId)} accepted for EVSE ${String(assignedEvseId)}`,
        );
        if (assignedEvseId > 0) {
          this.evseConnectorStatus.set(assignedEvseId, 'Reserved');
          void this.sendStatusNotification(
            assignedEvseId,
            this.getConnectorId(assignedEvseId),
            'Reserved',
          ).catch(() => {});
        }
        return { status: 'Accepted' };
      }

      case 'CancelReservation': {
        const cancelId = payload['reservationId'] as number;
        const reservation = this.reservations.get(cancelId);
        if (reservation == null) {
          if (!this.is16) {
            return {
              status: 'Rejected',
              statusInfo: { reasonCode: 'UnknownReservation' },
            };
          }
          return { status: 'Rejected' };
        }
        clearTimeout(reservation.expiryTimer);
        this.reservations.delete(cancelId);
        console.log(`[${this.config.stationId}] Reservation ${String(cancelId)} cancelled`);
        if (reservation.evseId > 0) {
          this.evseConnectorStatus.set(reservation.evseId, 'Available');
        }
        void this.sendReservationStatusUpdate(cancelId, 'Removed').catch(() => {});
        void this.sendStatusNotification(
          reservation.evseId,
          this.getConnectorId(reservation.evseId),
          'Available',
        ).catch(() => {});
        // Remove from DB
        void this.sql`
          DELETE FROM css_reservations
          WHERE css_station_id = ${this.config.id} AND reservation_id = ${cancelId}
        `.catch(() => {});
        return { status: 'Accepted' };
      }

      case 'CertificateSigned': {
        const certType =
          (payload['certificateType'] as string | undefined) ?? 'ChargingStationCertificate';
        console.log(`[${this.config.stationId}] CertificateSigned: ${certType}`);
        return { status: 'Accepted' };
      }

      case 'DeleteCertificate': {
        const hashData = payload['certificateHashData'] as Record<string, string> | undefined;
        const serial = hashData?.['serialNumber'] ?? '';
        // Check in-memory cache first
        if (this.installedCertificatesCache.has(serial)) {
          const entry = this.installedCertificatesCache.get(serial);
          // Refuse to delete CSMSRootCertificate (station's own trust anchor)
          if (entry?.certificateType === 'CSMSRootCertificate') {
            return { status: 'Failed' };
          }
          this.installedCertificatesCache.delete(serial);
          console.log(`[${this.config.stationId}] DeleteCertificate: removed ${serial}`);
          void this.sql`
            DELETE FROM css_installed_certificates
            WHERE css_station_id = ${this.config.id} AND serial_number = ${serial}
          `.catch(() => {});
          return { status: 'Accepted' };
        }
        // Check DB
        try {
          const dbRows = await this.sql`
            DELETE FROM css_installed_certificates
            WHERE css_station_id = ${this.config.id} AND serial_number = ${serial}
            RETURNING serial_number
          `;
          if (dbRows.length > 0) {
            console.log(`[${this.config.stationId}] DeleteCertificate: removed ${serial} from DB`);
            return { status: 'Accepted' };
          }
        } catch {
          // DB unavailable
        }
        return { status: 'NotFound' };
      }

      case 'GetInstalledCertificateIds': {
        const requestedTypes = payload['certificateType'] as string[] | undefined;

        // Build cert chain from in-memory cache (loaded from DB + defaults on startup,
        // updated by InstallCertificate/DeleteCertificate)
        type CertEntry = {
          certificateType: string;
          certificateHashData: Record<string, string>;
          childCertificateHashData?: Array<Record<string, string>>;
        };
        let certChain: CertEntry[] = [];
        for (const entry of this.installedCertificatesCache.values()) {
          const item: CertEntry = {
            certificateType: entry.certificateType,
            certificateHashData: { ...entry.certificateHashData },
          };
          // V2GCertificateChain includes child certificate hash data
          if (entry.certificateType === 'V2GCertificateChain') {
            item.childCertificateHashData = [
              {
                hashAlgorithm: 'SHA256',
                issuerNameHash: entry.certificateHashData['issuerNameHash'] ?? '',
                issuerKeyHash: entry.certificateHashData['issuerKeyHash'] ?? '',
                serialNumber: `${entry.certificateHashData['serialNumber'] ?? ''}-child`,
              },
            ];
          }
          certChain.push(item);
        }

        // Filter by requested types if specified
        if (requestedTypes != null && requestedTypes.length > 0) {
          certChain = certChain.filter((c) => requestedTypes.includes(c.certificateType));
        }

        if (certChain.length === 0) {
          return { status: 'NotFound' };
        }

        return {
          status: 'Accepted',
          certificateHashDataChain: certChain,
        };
      }

      case 'InstallCertificate': {
        const installType =
          (payload['certificateType'] as string | undefined) ?? 'CSMSRootCertificate';
        const certPem = (payload['certificate'] as string | undefined) ?? '';

        // Reject obviously invalid certificates (expired, unsigned, too short to be valid PEM)
        if (
          certPem.includes('EXPIRED') ||
          certPem.includes('UNSIGNED') ||
          (certPem.length < 50 && !certPem.startsWith('MII'))
        ) {
          return { status: 'Rejected' };
        }

        const installSerial = randomUUID().slice(0, 8);
        const issuerNameHash = randomUUID().replace(/-/g, '').slice(0, 40);
        const issuerKeyHash = randomUUID().replace(/-/g, '').slice(0, 40);

        this.installedCertificatesCache.set(installSerial, {
          certificateType: installType,
          certificateHashData: {
            hashAlgorithm: 'SHA256',
            issuerNameHash,
            issuerKeyHash,
            serialNumber: installSerial,
          },
        });

        console.log(
          `[${this.config.stationId}] InstallCertificate: ${installType} (${installSerial})`,
        );

        const certRowId = 'ccr_' + randomUUID().replace(/-/g, '').slice(0, 12);
        void this.sql`
          INSERT INTO css_installed_certificates (id, css_station_id, certificate_type, serial_number, hash_algorithm, issuer_name_hash, issuer_key_hash)
          VALUES (${certRowId}, ${this.config.id}, ${installType}, ${installSerial}, ${'SHA256'}, ${issuerNameHash}, ${issuerKeyHash})
          ON CONFLICT (css_station_id, serial_number) DO UPDATE
          SET certificate_type = EXCLUDED.certificate_type
        `.catch(() => {});

        return { status: 'Accepted' };
      }

      case 'GetLocalListVersion':
        return this.is16
          ? { listVersion: this.localAuthListVersion }
          : { versionNumber: this.localAuthListVersion };

      case 'SendLocalList': {
        const updateType = (payload['updateType'] as string | undefined) ?? 'Full';
        const listVersion =
          (payload['versionNumber'] as number | undefined) ??
          (payload['listVersion'] as number | undefined) ??
          0;
        const localAuthList =
          (payload['localAuthorizationList'] as Array<Record<string, unknown>> | undefined) ?? [];

        // Validate version for Differential updates
        // VersionMismatch when new version is not higher than current
        if (updateType === 'Differential' && listVersion <= this.localAuthListVersion) {
          return { status: 'VersionMismatch' };
        }

        // Check max list size (100 entries)
        const maxSize = 100;
        const totalAfterUpdate =
          updateType === 'Full'
            ? localAuthList.length
            : this.localAuthEntries.size + localAuthList.length;
        if (totalAfterUpdate > maxSize) {
          return { status: 'Failed' };
        }

        if (updateType === 'Full') {
          this.localAuthEntries.clear();
          // Clear DB entries
          void this.sql`
            DELETE FROM css_local_auth_entries WHERE css_station_id = ${this.config.id}
          `.catch(() => {});

          for (const entry of localAuthList) {
            const idTokenValue = this.is16
              ? (entry['idTag'] as string | undefined)
              : ((entry['idToken'] as Record<string, unknown> | undefined)?.['idToken'] as
                  | string
                  | undefined);
            if (idTokenValue != null) {
              this.localAuthEntries.set(idTokenValue, entry);
              const localAuthId = 'cla_' + randomUUID().replace(/-/g, '').slice(0, 12);
              void this.sql`
                INSERT INTO css_local_auth_entries (id, css_station_id, id_token, token_type, auth_status, list_version)
                VALUES (${localAuthId}, ${this.config.id}, ${idTokenValue}, ${'ISO14443'}, ${'Accepted'}, ${listVersion})
                ON CONFLICT (css_station_id, id_token) DO UPDATE
                SET auth_status = EXCLUDED.auth_status, list_version = EXCLUDED.list_version
              `.catch(() => {});
            }
          }
        } else {
          for (const entry of localAuthList) {
            const idTokenValue = this.is16
              ? (entry['idTag'] as string | undefined)
              : ((entry['idToken'] as Record<string, unknown> | undefined)?.['idToken'] as
                  | string
                  | undefined);
            if (idTokenValue == null) continue;
            const hasStatus = this.is16 ? entry['idTagInfo'] != null : entry['idTokenInfo'] != null;
            if (hasStatus) {
              this.localAuthEntries.set(idTokenValue, entry);
              const localAuthId = 'cla_' + randomUUID().replace(/-/g, '').slice(0, 12);
              void this.sql`
                INSERT INTO css_local_auth_entries (id, css_station_id, id_token, token_type, auth_status, list_version)
                VALUES (${localAuthId}, ${this.config.id}, ${idTokenValue}, ${'ISO14443'}, ${'Accepted'}, ${listVersion})
                ON CONFLICT (css_station_id, id_token) DO UPDATE
                SET auth_status = EXCLUDED.auth_status, list_version = EXCLUDED.list_version
              `.catch(() => {});
            } else {
              this.localAuthEntries.delete(idTokenValue);
              void this.sql`
                DELETE FROM css_local_auth_entries
                WHERE css_station_id = ${this.config.id} AND id_token = ${idTokenValue}
              `.catch(() => {});
            }
          }
        }

        this.localAuthListVersion = listVersion;
        console.log(
          `[${this.config.stationId}] SendLocalList ${updateType}: ${String(this.localAuthEntries.size)} entries, version ${String(listVersion)}`,
        );
        return { status: 'Accepted' };
      }

      case 'UpdateFirmware': {
        let fwLocation: string;
        if (this.is16) {
          fwLocation = payload['location'] as string;
        } else {
          const firmware = payload['firmware'] as Record<string, unknown> | undefined;
          fwLocation =
            (firmware?.['location'] as string | undefined) ?? (payload['location'] as string);
        }
        void this.simulateFirmwareUpdate(fwLocation).catch(() => {});
        return this.is16 ? {} : { status: 'Accepted' };
      }

      case 'PublishFirmware':
        return { status: 'Accepted' };

      case 'UnpublishFirmware':
        return { status: 'Unpublished' };

      case 'GetLog': {
        const logRequestId = payload['requestId'] as number;
        const logObj = payload['log'] as Record<string, unknown> | undefined;
        const logLocation = (logObj?.['remoteLocation'] as string | undefined) ?? '';
        const logFilename = `diagnostics-${this.config.stationId}-${String(Date.now())}.log`;

        // If there is an active upload, a second request cancels it
        if (this.activeLogUploadRequestId != null) {
          this.activeLogUploadRequestId = logRequestId;
          void this.simulateLogUpload(logRequestId, logLocation).catch(() => {});
          return { status: 'AcceptedCanceled', filename: logFilename };
        }

        this.activeLogUploadRequestId = logRequestId;
        void this.simulateLogUpload(logRequestId, logLocation).catch(() => {});
        return { status: 'Accepted', filename: logFilename };
      }

      case 'GetMonitoringReport': {
        const monReportRequestId = payload['requestId'] as number;
        const monCriteria = payload['monitoringCriteria'] as string[] | undefined;
        const monCompVar = payload['componentVariable'] as
          | Array<Record<string, unknown>>
          | undefined;

        if (!this.is16) {
          // Validate criteria values
          const validCriteria = ['ThresholdMonitoring', 'DeltaMonitoring', 'PeriodicMonitoring'];
          if (monCriteria != null && monCriteria.some((c) => !validCriteria.includes(c))) {
            return { status: 'NotSupported' };
          }

          // Filter monitors
          let matchingMonitors = Array.from(this.variableMonitors.values());

          // Filter by criteria (monitor type mapping)
          if (monCriteria != null && monCriteria.length > 0) {
            const criteriaTypeMap: Record<string, string[]> = {
              ThresholdMonitoring: ['UpperThreshold', 'LowerThreshold'],
              DeltaMonitoring: ['Delta'],
              PeriodicMonitoring: ['Periodic', 'PeriodicClockAligned'],
            };
            const allowedTypes = monCriteria.flatMap((c) => criteriaTypeMap[c] ?? []);
            matchingMonitors = matchingMonitors.filter((m) => allowedTypes.includes(m.type));
          }

          // Filter by componentVariable
          if (monCompVar != null && monCompVar.length > 0) {
            matchingMonitors = matchingMonitors.filter((m) => {
              return monCompVar.some((cv) => {
                const comp = cv['component'] as Record<string, unknown>;
                const variable = cv['variable'] as Record<string, unknown>;
                const compMatch =
                  (m.component['name'] as string) === (comp['name'] as string) &&
                  JSON.stringify(m.component['evse'] ?? null) ===
                    JSON.stringify(comp['evse'] ?? null);
                const varMatch = (m.variable['name'] as string) === (variable['name'] as string);
                return compMatch && varMatch;
              });
            });
          }

          if (matchingMonitors.length === 0) {
            return { status: 'EmptyResultSet' };
          }

          // Send report asynchronously
          const reportMonitors = matchingMonitors.map((m) => ({
            component: m.component,
            variable: m.variable,
            variableMonitoring: [
              {
                id: m.id,
                transaction: false,
                value: 0,
                type: m.type,
                severity: m.severity,
                eventNotificationType: m.isHardwired ? 'HardWiredMonitor' : 'CustomMonitor',
              },
            ],
          }));
          setTimeout(() => {
            void this.sendNotifyMonitoringReport(monReportRequestId, reportMonitors).catch(
              () => {},
            );
          }, 200);
          return { status: 'Accepted' };
        }
        return { status: 'Accepted' };
      }

      case 'SetMonitoringBase': {
        const monBase = payload['monitoringBase'] as string;
        const validBases = ['All', 'FactoryDefault', 'HardWiredOnly'];
        if (!validBases.includes(monBase)) {
          return { status: 'NotSupported' };
        }
        if (monBase === 'HardWiredOnly') {
          // Remove all non-hardwired monitors
          for (const [id, mon] of this.variableMonitors) {
            if (!mon.isHardwired) {
              this.variableMonitors.delete(id);
            }
          }
        } else if (monBase === 'FactoryDefault') {
          // Remove all non-hardwired monitors and re-seed factory defaults
          for (const [id, mon] of this.variableMonitors) {
            if (!mon.isHardwired) {
              this.variableMonitors.delete(id);
            }
          }
          this.seedDefaultMonitors();
        }
        return { status: 'Accepted' };
      }

      case 'SetMonitoringLevel': {
        const monSeverity = payload['severity'] as number;
        if (monSeverity < 0 || monSeverity > 9) {
          return { status: 'Rejected' };
        }
        this.monitoringLevel = monSeverity;
        return { status: 'Accepted' };
      }

      case 'SetVariableMonitoring': {
        const setMonData = (payload['setMonitoringData'] ?? []) as Array<Record<string, unknown>>;
        return {
          setMonitoringResult: setMonData.map((item) => {
            const comp = item['component'] as Record<string, unknown>;
            const variable = item['variable'] as Record<string, unknown>;
            const monType = item['type'] as string;
            const monValue = item['value'] as number;
            const monSeverity = item['severity'] as number;

            // Validate component exists
            if (!this.isKnownComponent(comp)) {
              return {
                status: 'UnknownComponent',
                type: monType,
                severity: monSeverity,
                component: comp,
                variable,
                id: 0,
              };
            }

            // Validate variable exists on component
            if (!this.isKnownVariable(comp, variable)) {
              return {
                status: 'UnknownVariable',
                type: monType,
                severity: monSeverity,
                component: comp,
                variable,
                id: 0,
              };
            }

            // Validate value ranges
            if (monType === 'Delta' && monValue < 0) {
              return {
                status: 'Rejected',
                type: monType,
                severity: monSeverity,
                component: comp,
                variable,
                id: 0,
              };
            }
            if (
              (monType === 'UpperThreshold' || monType === 'LowerThreshold') &&
              monValue > 100000
            ) {
              return {
                status: 'Rejected',
                type: monType,
                severity: monSeverity,
                component: comp,
                variable,
                id: 0,
              };
            }

            // Create monitor
            const monId = ++this.monitorIdCounter;
            this.variableMonitors.set(monId, {
              id: monId,
              type: monType,
              severity: monSeverity,
              component: comp,
              variable,
              isHardwired: false,
            });

            return {
              status: 'Accepted',
              type: monType,
              severity: monSeverity,
              component: comp,
              variable,
              id: monId,
            };
          }),
        };
      }

      case 'ClearVariableMonitoring': {
        const monitorIds = (payload['id'] ?? []) as number[];
        return {
          clearMonitoringResult: monitorIds.map((id) => {
            const monitor = this.variableMonitors.get(id);
            if (monitor == null) {
              return { status: 'NotFound', id };
            }
            if (monitor.isHardwired) {
              return { status: 'Rejected', id };
            }
            this.variableMonitors.delete(id);
            return { status: 'Accepted', id };
          }),
        };
      }

      case 'SetNetworkProfile': {
        const configSlot = payload['configurationSlot'] as number | undefined;
        if (configSlot == null || configSlot < 1 || configSlot > 10) {
          return { status: 'Rejected' };
        }

        const connData = payload['connectionData'] as Record<string, unknown> | undefined;
        const newSecProfile = connData?.['securityProfile'] as number | undefined;
        const currentSecProfile = Number(
          this.configVariables.get('SecurityCtrlr.SecurityProfile')?.value ?? '0',
        );
        const allowDowngrade =
          this.configVariables.get('SecurityCtrlr.AllowSecurityDowngrade')?.value === 'true';

        // Reject security downgrade unless explicitly allowed
        if (newSecProfile != null && newSecProfile < currentSecProfile && !allowDowngrade) {
          return { status: 'Rejected' };
        }

        // Store connection data in device model
        if (connData != null) {
          const slot = String(configSlot);
          const fields: Array<[string, string | undefined]> = [
            ['OcppCsmsUrl', connData['ocppCsmsUrl'] as string | undefined],
            ['OcppInterface', connData['ocppInterface'] as string | undefined],
            ['OcppTransport', connData['ocppTransport'] as string | undefined],
            ['OcppVersion', connData['ocppVersion'] as string | undefined],
            [
              'MessageTimeout',
              connData['messageTimeout'] != null
                ? String(connData['messageTimeout'] as number)
                : undefined,
            ],
            ['SecurityProfile', newSecProfile != null ? String(newSecProfile) : undefined],
            ['VpnEnabled', 'false'],
            ['ApnEnabled', 'false'],
          ];
          for (const [varName, value] of fields) {
            if (value != null) {
              this.configVariables.set(`NetworkConfiguration.${varName}#${slot}`, {
                value,
                readonly: false,
              });
            }
          }
        }

        return { status: 'Accepted' };
      }

      case 'ClearDisplayMessage': {
        const clearMsgId = payload['id'] as number;
        if (this.displayMessagesCache.has(clearMsgId)) {
          this.displayMessagesCache.delete(clearMsgId);
          void this.sql`
            DELETE FROM css_display_messages
            WHERE css_station_id = ${this.config.id} AND message_id = ${clearMsgId}
          `.catch(() => {});
          return { status: 'Accepted' };
        }
        return { status: 'Unknown' };
      }

      case 'GetDisplayMessages': {
        const getRequestId = payload['requestId'] as number;
        const filterIds = payload['id'] as number[] | undefined;
        const filterPriority = payload['priority'] as string | undefined;
        const filterState = payload['state'] as string | undefined;

        // Use in-memory cache (DB may not have rows from current test session)
        let messages = Array.from(this.displayMessagesCache.values());

        if (filterIds != null) {
          const idSet = new Set(filterIds);
          messages = messages.filter((m) => idSet.has(m['id'] as number));
        }
        if (filterPriority != null) {
          messages = messages.filter((m) => m['priority'] === filterPriority);
        }
        if (filterState != null) {
          messages = messages.filter((m) => m['state'] === filterState);
        }

        if (messages.length > 0) {
          void this.sendNotifyDisplayMessages(getRequestId, messages).catch(() => {});
        }

        return { status: messages.length > 0 ? 'Accepted' : 'Unknown' };
      }

      case 'SetDisplayMessage': {
        const msgInfo = payload['message'] as Record<string, unknown>;
        const msgId = msgInfo['id'] as number;
        const msgPriority = msgInfo['priority'] as string | undefined;
        const msgState = msgInfo['state'] as string | undefined;
        const msgTransactionId = msgInfo['transactionId'] as string | undefined;

        // Validate priority
        const supportedPriorities = ['AlwaysFront', 'InFront', 'NormalCycle'];
        if (msgPriority != null && !supportedPriorities.includes(msgPriority)) {
          return { status: 'NotSupportedPriority' };
        }

        // Validate state
        const supportedStates = ['Charging', 'Faulted', 'Idle', 'Unavailable'];
        if (msgState != null && !supportedStates.includes(msgState)) {
          return { status: 'NotSupportedState' };
        }

        // Validate transactionId if provided: check if any transaction is active
        if (msgTransactionId != null) {
          let anyTxActive = false;
          for (const evse of this.config.evses) {
            const tx = await this.getActiveTransaction(evse.evseId);
            if (tx != null) {
              anyTxActive = true;
              break;
            }
          }
          if (!anyTxActive) {
            return { status: 'UnknownTransaction' };
          }
        }

        // If AlwaysFront with transaction, replace existing AlwaysFront for same transaction
        if (msgPriority === 'AlwaysFront' && msgTransactionId != null) {
          for (const [existingId, existingMsg] of this.displayMessagesCache) {
            if (
              existingId !== msgId &&
              existingMsg['priority'] === 'AlwaysFront' &&
              existingMsg['transactionId'] === msgTransactionId
            ) {
              this.displayMessagesCache.delete(existingId);
              void this.sql`
                DELETE FROM css_display_messages
                WHERE css_station_id = ${this.config.id} AND message_id = ${existingId}
              `.catch(() => {});
            }
          }
        }

        this.displayMessagesCache.set(msgId, msgInfo);

        const displayMsgRowId = 'cdm_' + randomUUID().replace(/-/g, '').slice(0, 12);
        void this.sql`
          INSERT INTO css_display_messages (id, css_station_id, message_id, message_data)
          VALUES (${displayMsgRowId}, ${this.config.id}, ${msgId}, ${JSON.stringify(msgInfo)})
          ON CONFLICT (css_station_id, message_id) DO UPDATE
          SET message_data = EXCLUDED.message_data
        `.catch(() => {});

        return { status: 'Accepted' };
      }

      case 'CostUpdated':
        return {};

      case 'CustomerInformation': {
        const custRequestId = payload['requestId'] as number;
        const custReport = payload['report'] as boolean;
        const custClear = payload['clear'] as boolean;
        const custIdToken = payload['idToken'] as Record<string, unknown> | undefined;
        const custIdentifier = payload['customerIdentifier'] as string | undefined;
        const custCert = payload['customerCertificate'] as Record<string, unknown> | undefined;

        // Must have at least one of idToken, customerIdentifier, or customerCertificate
        if (custIdToken == null && custIdentifier == null && custCert == null) {
          return { status: 'Invalid' };
        }

        if (!this.is16) {
          // Determine the lookup key
          let custKey: string | null = null;
          if (custIdToken != null) {
            custKey = custIdToken['idToken'] as string;
          } else if (custIdentifier != null) {
            custKey = custIdentifier;
          } else if (custCert != null) {
            const serialNum = custCert['serialNumber'] as string | undefined;
            custKey = `cert:${serialNum ?? 'unknown'}`;
          }

          const custData = custKey != null ? (this.customerDataStore.get(custKey) ?? '') : '';

          if (custReport) {
            setTimeout(() => {
              void this.sendNotifyCustomerInformation(custRequestId, custData).catch(() => {});
            }, 200);
          }

          // Clear customer data if requested
          if (custClear && custKey != null) {
            this.customerDataStore.delete(custKey);
          }
        }
        return { status: 'Accepted' };
      }

      case 'GetTransactionStatus': {
        const txIdQuery = payload['transactionId'] as string | undefined;
        if (txIdQuery != null) {
          // Look up whether this specific transaction is ongoing
          let ongoing = false;
          for (const [, id] of this.activeTransactionIds) {
            if (id === txIdQuery) {
              ongoing = true;
              break;
            }
          }
          return { messagesInQueue: false, ongoingIndicator: ongoing };
        }
        // No transactionId: return messagesInQueue only, omit ongoingIndicator
        return { messagesInQueue: false };
      }

      case 'DataTransfer':
        // Unknown vendor/message: return UnknownVendorId per OCPP spec
        return { status: 'UnknownVendorId' };

      case 'SetDefaultTariff': {
        if (this.is16) return { status: 'Rejected' };
        const sdt_evseId = payload['evseId'] as number;
        const sdt_tariff = payload['tariff'] as Record<string, unknown>;
        const sdt_tariffId = sdt_tariff['tariffId'] as string;
        this.defaultTariffs.set(sdt_tariffId, {
          evseId: sdt_evseId,
          tariff: sdt_tariff,
          inUse: false,
        });
        return { status: 'Accepted' };
      }

      case 'GetTariffs': {
        if (this.is16) return { status: 'Rejected' };
        const gt_evseId = payload['evseId'] as number | undefined;
        const assignments: Array<Record<string, unknown>> = [];
        for (const [tariffId, entry] of this.defaultTariffs) {
          // Filter by evseId if specified (0 matches global tariffs)
          if (gt_evseId != null && entry.evseId !== gt_evseId && entry.evseId !== 0) continue;
          assignments.push({
            tariffId,
            tariffKind: 'DefaultTariff',
            evseIds: entry.evseId === 0 ? this.config.evses.map((e) => e.evseId) : [entry.evseId],
          });
        }
        // Include driver tariffs
        for (const [evse, dt] of this.driverTariffs) {
          if (gt_evseId != null && evse !== gt_evseId && evse !== 0) continue;
          assignments.push({
            tariffId: dt.tariffId,
            tariffKind: 'DriverTariff',
            evseIds: evse === 0 ? this.config.evses.map((e) => e.evseId) : [evse],
          });
        }
        if (assignments.length === 0) {
          return { status: 'NoTariff' };
        }
        // Return most recently added tariff first (last inserted = most recent)
        assignments.reverse();
        return { status: 'Accepted', tariffAssignments: assignments };
      }

      case 'ClearTariffs': {
        if (this.is16) return { clearTariffsResult: [{ status: 'Rejected' }] };
        const ct_tariffIds = payload['tariffIds'] as string[] | undefined;
        const ct_results: Array<Record<string, unknown>> = [];
        if (ct_tariffIds != null && ct_tariffIds.length > 0) {
          // Clear specific tariffs
          for (const tid of ct_tariffIds) {
            const entry = this.defaultTariffs.get(tid);
            if (entry != null) {
              // If tariff is in use, mark for clearing but keep in store
              if (entry.inUse) {
                // Keep the tariff but mark it as cleared (will be removed after tx ends)
                ct_results.push({ tariffId: tid, status: 'Accepted' });
              } else {
                this.defaultTariffs.delete(tid);
                ct_results.push({ tariffId: tid, status: 'Accepted' });
              }
            } else {
              ct_results.push({ tariffId: tid, status: 'Unknown' });
            }
          }
        } else {
          // Clear all tariffs
          for (const [tid, entry] of this.defaultTariffs) {
            ct_results.push({ tariffId: tid, status: 'Accepted' });
            if (!entry.inUse) {
              this.defaultTariffs.delete(tid);
            }
          }
        }
        return { clearTariffsResult: ct_results };
      }

      case 'UsePriorityCharging':
        return { status: 'Accepted' };

      case 'UpdateDynamicSchedule':
        return { status: 'Accepted' };

      case 'ChangeTransactionTariff': {
        if (this.is16) return { status: 'Rejected' };
        // If local cost calculation is not supported, return CALLERROR NotSupported
        const ctt_localCostSupported =
          this.getConfigValue('TariffCostCtrlr.LocalCostSupported') ?? 'true';
        if (ctt_localCostSupported !== 'true') {
          throw new Error('NotSupported');
        }
        const ctt_txId = payload['transactionId'] as string;
        const ctt_tariff = payload['tariff'] as Record<string, unknown>;
        const ctt_tariffId = ctt_tariff['tariffId'] as string;
        const ctt_currency = ctt_tariff['currency'] as string;

        // Check if transaction exists
        const ctt_evseId = await this.findEvseForTransaction(ctt_txId);
        if (ctt_evseId == null) {
          // Also check in-memory transaction IDs
          let found = false;
          for (const [, txId] of this.activeTransactionIds) {
            if (txId === ctt_txId) {
              found = true;
              break;
            }
          }
          if (!found) return { status: 'TxNotFound' };
        }

        // Check TariffMaxElements: count total price elements
        const ctt_maxElements = Number(
          this.configVariables.get('TariffCostCtrlr.MaxElements#Tariff')?.value ?? '10',
        );
        let ctt_elementCount = 0;
        for (const key of [
          'energy',
          'chargingTime',
          'idleTime',
          'fixedFee',
          'reservationTime',
          'reservationFixed',
        ]) {
          const section = ctt_tariff[key] as Record<string, unknown> | undefined;
          if (section != null) {
            const prices = section['prices'] as Array<unknown> | undefined;
            if (prices != null) ctt_elementCount += prices.length;
          }
        }
        if (ctt_elementCount > ctt_maxElements) {
          return { status: 'TooManyElements' };
        }

        // Check ConditionNotSupported: if any price element has complex conditions
        // we report ConditionNotSupported (simplified check -- our simulator does not support conditions)
        let ctt_hasConditions = false;
        for (const key of [
          'energy',
          'chargingTime',
          'idleTime',
          'fixedFee',
          'reservationTime',
          'reservationFixed',
        ]) {
          const section = ctt_tariff[key] as Record<string, unknown> | undefined;
          if (section != null) {
            const prices = (section['prices'] ?? []) as Array<Record<string, unknown>>;
            for (const p of prices) {
              const cond = p['conditions'] as Record<string, unknown> | undefined;
              if (cond != null) {
                // Check for conditions beyond simple time-of-day
                const condKeys = Object.keys(cond);
                const complexKeys = condKeys.filter(
                  (k) => k !== 'startTimeOfDay' && k !== 'endTimeOfDay' && k !== 'evseKind',
                );
                if (complexKeys.length > 0) {
                  ctt_hasConditions = true;
                  break;
                }
              }
            }
          }
          if (ctt_hasConditions) break;
        }
        if (ctt_hasConditions) {
          return { status: 'ConditionNotSupported' };
        }

        // Check currency change
        const ctt_existingCurrency = this.transactionTariffCurrency.get(ctt_txId);
        if (ctt_existingCurrency != null && ctt_existingCurrency !== ctt_currency) {
          return { status: 'NoCurrencyChange' };
        }

        // Accept and store
        this.transactionTariffCurrency.set(ctt_txId, ctt_currency);

        // Send TariffChanged TransactionEvent
        const ctt_evse = ctt_evseId ?? 1;
        setTimeout(() => {
          void this.client
            .sendCall('TransactionEvent', {
              eventType: 'Updated',
              timestamp: new Date().toISOString(),
              triggerReason: 'TariffChanged',
              seqNo: (this.evseSeqNo.get(ctt_evse) ?? 0) + 1,
              transactionInfo: {
                transactionId: ctt_txId,
                tariffId: ctt_tariffId,
              },
            })
            .catch(() => {});
        }, 200);

        return { status: 'Accepted' };
      }

      case 'AFRRSignal':
        return { status: 'Accepted' };

      case 'AdjustPeriodicEventStream':
        return { status: 'Accepted' };

      case 'ClosePeriodicEventStream':
        return {};

      case 'OpenPeriodicEventStream':
        return { status: 'Accepted' };

      case 'GetPeriodicEventStream':
        return {
          constantStreamData: [
            {
              id: 1,
              variableMonitoringId: 100,
              params: { interval: 60, values: 10 },
            },
          ],
        };

      case 'ClearDERControl':
        return { status: 'Accepted' };

      case 'GetDERControl':
        return { status: 'Accepted' };

      case 'SetDERControl':
        return { status: 'Accepted' };

      case 'RequestBatterySwap':
        return { status: 'Accepted' };

      case 'VatNumberValidation':
        return {
          status: 'Accepted',
          vatNumber: payload['vatNumber'] as string,
          evseId: (payload['evseId'] as number | undefined) ?? 1,
          company: {
            name: 'Simulated Company B.V.',
            address1: '123 Charging Street',
            city: 'Amsterdam',
            country: 'Netherlands',
          },
        };

      case 'GetDiagnostics': {
        const diagLocation = payload['location'] as string;
        void this.simulateDiagnosticsUpload(diagLocation).catch(() => {});
        return { fileName: 'diagnostics.txt' };
      }

      default:
        console.log(`[${this.config.stationId}] Unhandled action: ${action}`);
        return { status: 'NotSupported' };
    }
  }

  // ---------------------------------------------------------------------------
  // TriggerMessage dispatch
  // ---------------------------------------------------------------------------

  private async handleTriggerMessage(
    requestedMessage: string,
    triggerPayload: Record<string, unknown>,
  ): Promise<void> {
    const evseObj = triggerPayload['evse'] as Record<string, unknown> | undefined;
    const triggerEvseId = evseObj?.['id'] as number | undefined;
    const triggerConnectorId =
      (triggerPayload['connectorId'] as number | undefined) ??
      (evseObj?.['connectorId'] as number | undefined);

    try {
      switch (requestedMessage) {
        case 'BootNotification':
          await this.sendBootNotification('Triggered');
          break;
        case 'Heartbeat':
          await this.sendHeartbeat();
          break;
        case 'StatusNotification': {
          const snEvseId = triggerEvseId ?? 1;
          const snConnId = triggerConnectorId ?? 1;
          // Send actual connector status, not always Available
          const currentStatus = this.evseConnectorStatus.get(snEvseId) ?? 'Available';
          await this.sendStatusNotification(snEvseId, snConnId, currentStatus);
          break;
        }
        case 'MeterValues': {
          const targetEvseId = triggerEvseId ?? 1;
          const gen = this.meterGens.get(targetEvseId);
          if (gen == null) break;

          const tx = await this.getActiveTransaction(targetEvseId);
          const isIdle = tx == null || (this.evseIdle.get(targetEvseId) ?? false);
          gen.tick(isIdle, this.evsePowerLimits.get(targetEvseId) ?? null);

          const measurands = tx != null ? this.getSampledMeasurands() : this.getAlignedMeasurands();
          const sampledValues = gen.generate(
            measurands.length > 0
              ? measurands
              : ['Energy.Active.Import.Register', 'Power.Active.Import'],
            this.is16,
          );

          // Add context: 'Trigger' to all sampled values
          for (const sv of sampledValues) {
            (sv as unknown as Record<string, unknown>)['context'] = 'Trigger';
          }

          await this.sendMeterValues(
            targetEvseId,
            sampledValues as unknown as Array<Record<string, unknown>>,
            tx?.transactionId,
          );
          break;
        }
        case 'FirmwareStatusNotification':
          await this.sendFirmwareStatusNotification(this.firmwareUpdateStatus);
          break;
        case 'DiagnosticsStatusNotification':
          await this.sendDiagnosticsStatusNotification('Idle');
          break;
        case 'LogStatusNotification':
          await this.sendLogStatusNotification(this.logUploadStatus);
          break;
        case 'TransactionEvent': {
          // Find any EVSE with an active transaction (prefer triggerEvseId if given)
          const evseList =
            triggerEvseId != null
              ? this.config.evses.filter((e) => e.evseId === triggerEvseId)
              : this.config.evses;
          for (const evse of evseList) {
            const tx = await this.getActiveTransaction(evse.evseId);
            if (tx != null) {
              // Include chargingState and meterValue per OCPP spec
              const chState = this.evseChargingState.get(evse.evseId) ?? 'Charging';
              const txGen = this.meterGens.get(evse.evseId);
              let txMeterValue: Array<Record<string, unknown>> | undefined;
              if (txGen != null) {
                const txIdle = this.evseIdle.get(evse.evseId) ?? false;
                txGen.tick(txIdle, this.evsePowerLimits.get(evse.evseId) ?? null);
                const txMeasurands = this.getSampledMeasurands();
                const txSampled = txGen.generate(
                  txMeasurands.length > 0
                    ? txMeasurands
                    : ['Energy.Active.Import.Register', 'Power.Active.Import'],
                  this.is16,
                );
                txMeterValue = [
                  {
                    timestamp: new Date().toISOString(),
                    sampledValue: txSampled,
                  },
                ];
              }
              const txEventOpts: {
                triggerReason: string;
                transactionId: string;
                chargingState: string;
                meterValue?: Array<Record<string, unknown>>;
              } = {
                triggerReason: 'Trigger',
                transactionId: tx.transactionId,
                chargingState: chState,
              };
              if (txMeterValue != null) {
                txEventOpts.meterValue = txMeterValue;
              }
              await this.sendTransactionEvent(evse.evseId, 'Updated', txEventOpts);
              break;
            }
          }
          break;
        }
        case 'SignChargingStationCertificate':
          await this.sendSignCertificate('simulated-csr-data', 'ChargingStationCertificate');
          break;
        case 'PublishFirmwareStatusNotification':
          await this.sendPublishFirmwareStatusNotification('Idle');
          break;
        case 'CustomTrigger': {
          // Custom trigger: send a Heartbeat as the triggered response
          await this.sendHeartbeat();
          break;
        }
      }
    } catch {
      // Ignore errors from triggered messages
    }
  }

  // ---------------------------------------------------------------------------
  // Simulation helpers
  // ---------------------------------------------------------------------------

  private async simulateReset(resetType: string): Promise<void> {
    // Use version-appropriate stop reason
    let reason: string;
    if (this.is16) {
      reason = resetType === 'Immediate' ? 'HardReset' : 'SoftReset';
    } else {
      reason = resetType === 'Immediate' ? 'ImmediateReset' : 'SoftReset';
    }
    const bootReason = resetType === 'Immediate' ? 'RemoteReset' : 'ScheduledReset';

    // Stop all active transactions
    for (const evse of this.config.evses) {
      const tx = await this.getActiveTransaction(evse.evseId);
      if (tx != null) {
        await this.stopCharging(evse.evseId, reason);
      }
    }

    // Send StatusNotification Unavailable for all connectors before reboot
    for (const evse of this.config.evses) {
      try {
        await this.sendStatusNotification(evse.evseId, evse.connectorId, 'Unavailable');
      } catch {
        // May fail if connection is closing
      }
    }

    this.stopHeartbeat();

    await new Promise((resolve) => setTimeout(resolve, 500));
    if (this.destroyed) return;

    try {
      await this.sendBootNotification(bootReason);
      for (const evse of this.config.evses) {
        this.evseConnectorStatus.set(evse.evseId, 'Available');
        const ctx = this.evseContexts.get(evse.evseId) as EvseContext;
        ctx.state = 'Available';
        ctx.cablePlugged = false;
        ctx.authorizedToken = null;
        ctx.transactionId = null;
        await this.sendStatusNotification(evse.evseId, evse.connectorId, 'Available');
      }
    } catch {
      // Ignore errors during reset
    }
  }

  private isDestroyed(): boolean {
    return this.destroyed;
  }

  private startConnectionTimeoutTimer(evseId: number): void {
    this.cancelConnectionTimeoutTimer(evseId);
    const timeoutSec = Number(this.getConfigValue('ConnectionTimeOut') ?? '60');
    if (timeoutSec <= 0) return;
    const timer = setTimeout(() => {
      this.connectionTimeoutTimers.delete(evseId);
      const ctx = this.evseContexts.get(evseId);
      if (ctx == null || ctx.cablePlugged || ctx.transactionId != null) return;
      // Revert to Available
      ctx.state = 'Available';
      ctx.authorizedToken = null;
      ctx.authorizedTokenType = null;
      this.evseConnectorStatus.set(evseId, 'Available');
      const connectorId = this.getConnectorId(evseId);
      void this.sendStatusNotification(evseId, connectorId, 'Available').catch(() => {});
      void this.updateEvseStatus(evseId, 'Available').catch(() => {});
    }, timeoutSec * 1000);
    this.connectionTimeoutTimers.set(evseId, timer);
  }

  private cancelConnectionTimeoutTimer(evseId: number): void {
    const timer = this.connectionTimeoutTimers.get(evseId);
    if (timer != null) {
      clearTimeout(timer);
      this.connectionTimeoutTimers.delete(evseId);
    }
  }

  /** OCPP 2.1: Start an EVConnectionTimeout timer for a remote-started transaction
   *  where cable is not yet plugged in. When it fires the station ends the
   *  transaction with triggerReason EVConnectTimeout. */
  private startEvConnectTimeoutTimer(evseId: number, transactionId: string): void {
    this.cancelEvConnectTimeoutTimer(evseId);
    const timeoutSec = Number(
      this.getConfigValue('TxCtrlr.EVConnectionTimeOut') ??
        this.getConfigValue('ConnectionTimeOut') ??
        '60',
    );
    if (timeoutSec <= 0) return;
    const timer = setTimeout(() => {
      this.evConnectTimeoutTimers.delete(evseId);
      const ctx = this.evseContexts.get(evseId);
      if (ctx == null || ctx.cablePlugged) return;
      // End the transaction with EVConnectTimeout
      void (async () => {
        try {
          this.stopMeterLoop(evseId);
          const gen = this.meterGens.get(evseId);
          const meterStopWh = gen?.energyWh ?? 0;
          const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
          this.evseSeqNo.set(evseId, seqNo);
          await this.sendTransactionEvent(evseId, 'Ended', {
            triggerReason: 'EVConnectTimeout',
            transactionId,
            chargingState: 'Idle',
            stoppedReason: 'Timeout',
            seqNo,
          });
          await this.completeTransaction(transactionId, 'EVConnectTimeout', meterStopWh);
          // Reset EVSE state
          ctx.state = 'Available';
          ctx.transactionId = null;
          ctx.authorizedToken = null;
          ctx.authorizedTokenType = null;
          ctx.remoteStartId = null;
          this.evseConnectorStatus.set(evseId, 'Available');
          const connectorId = this.getConnectorId(evseId);
          await this.sendStatusNotification(evseId, connectorId, 'Available');
        } catch {
          // Best effort
        }
      })();
    }, timeoutSec * 1000);
    this.evConnectTimeoutTimers.set(evseId, timer);
  }

  private cancelEvConnectTimeoutTimer(evseId: number): void {
    const timer = this.evConnectTimeoutTimers.get(evseId);
    if (timer != null) {
      clearTimeout(timer);
      this.evConnectTimeoutTimers.delete(evseId);
    }
  }

  /** OCPP 2.1: Pre-transaction EVConnectionTimeout for remote start without cable.
   *  No transaction has been started yet. When the timer fires, the station creates
   *  a brief transaction (Started + Ended) with EVConnectTimeout. */
  private startEvConnectTimeoutTimerPreTx(evseId: number): void {
    this.cancelEvConnectTimeoutTimer(evseId);
    const timeoutSec = Number(
      this.getConfigValue('TxCtrlr.EVConnectionTimeOut') ??
        this.getConfigValue('ConnectionTimeOut') ??
        '60',
    );
    if (timeoutSec <= 0) return;
    const timer = setTimeout(() => {
      this.evConnectTimeoutTimers.delete(evseId);
      const ctx = this.evseContexts.get(evseId);
      if (ctx == null || ctx.cablePlugged) return;
      // No transaction was started. Create a minimal Started + Ended pair.
      void (async () => {
        try {
          const txId = randomUUID();
          this.evseSeqNo.set(evseId, 0);
          // TransactionEvent Started
          const startOpts: Parameters<typeof this.sendTransactionEvent>[2] = {
            triggerReason: ctx.remoteStartId != null ? 'RemoteStart' : 'Authorized',
            transactionId: txId,
            chargingState: 'EVConnected',
          };
          if (ctx.authorizedToken != null) {
            startOpts.idToken = ctx.authorizedToken;
            startOpts.tokenType = ctx.authorizedTokenType ?? 'ISO14443';
          }
          await this.sendTransactionEvent(evseId, 'Started', startOpts);
          // TransactionEvent Ended with EVConnectTimeout
          const seqNo = 1;
          this.evseSeqNo.set(evseId, seqNo);
          await this.sendTransactionEvent(evseId, 'Ended', {
            triggerReason: 'EVConnectTimeout',
            transactionId: txId,
            chargingState: 'Idle',
            stoppedReason: 'Timeout',
            seqNo,
          });
          // Reset EVSE state
          ctx.state = 'Available';
          ctx.transactionId = null;
          ctx.authorizedToken = null;
          ctx.authorizedTokenType = null;
          ctx.remoteStartId = null;
          this.evseSeqNo.set(evseId, 0);
          this.evseChargingState.set(evseId, null);
          this.evseConnectorStatus.set(evseId, 'Available');
          const connectorId = this.getConnectorId(evseId);
          await this.sendStatusNotification(evseId, connectorId, 'Available');
        } catch {
          // Best effort
        }
      })();
    }, timeoutSec * 1000);
    this.evConnectTimeoutTimers.set(evseId, timer);
  }

  private async simulateFirmwareUpdate(location: string): Promise<void> {
    const delay = () => new Promise((resolve) => setTimeout(resolve, 500));
    const send = async (status: string) => {
      if (this.isDestroyed()) return false;
      await delay();
      if (this.isDestroyed()) return false;
      this.firmwareUpdateStatus = status;
      await this.sendFirmwareStatusNotification(status);
      return true;
    };

    try {
      // Simulate download failure for unreachable/nonexistent URLs
      if (location.includes('does_not_exist')) {
        await send('Downloading');
        await send('DownloadFailed');
        this.firmwareUpdateStatus = 'Idle';
        return;
      }

      if (!(await send('Downloading'))) return;
      if (!(await send('Downloaded'))) return;

      // Simulate installation failure for invalid firmware
      if (location.includes('invalid_firmware')) {
        await send('InstallationFailed');
        this.firmwareUpdateStatus = 'Idle';
        return;
      }

      if (!(await send('Installing'))) return;

      // Reboot after installing (station sends BootNotification)
      await this.sendBootNotification(this.is16 ? 'FirmwareUpdate' : 'FirmwareUpdate');

      if (!(await send('Installed'))) return;
      this.firmwareUpdateStatus = 'Idle';
    } catch {
      // Connection lost during firmware update
      this.firmwareUpdateStatus = 'Idle';
    }
  }

  private async simulateLogUpload(requestId: number, remoteLocation: string): Promise<void> {
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // Simulate failure for nonexistent or redirect URLs
    if (remoteLocation.includes('nonexistent') || remoteLocation.includes('redirect')) {
      await delay(500);
      if (this.destroyed) return;
      this.logUploadStatus = 'UploadFailure';
      try {
        await this.sendLogStatusNotification('UploadFailure', requestId);
      } catch {
        // ignore
      }
      this.logUploadStatus = 'Idle';
      this.activeLogUploadRequestId = null;
      return;
    }

    const statuses = ['Uploading', 'Uploaded'];
    const delays = [500, 1000];

    for (let i = 0; i < statuses.length; i++) {
      await delay(delays[i] as number);
      if (this.destroyed) return;
      try {
        this.logUploadStatus = statuses[i] as string;
        await this.sendLogStatusNotification(statuses[i] as string, requestId);
      } catch {
        return;
      }
    }
    this.logUploadStatus = 'Idle';
    this.activeLogUploadRequestId = null;
  }

  private seedDefaultMonitors(): void {
    // Seed custom (factory-default) Delta monitors on AvailabilityState.
    // These are custom monitors that can be cleared by HardWiredOnly.
    const csMonId = ++this.monitorIdCounter;
    this.variableMonitors.set(csMonId, {
      id: csMonId,
      type: 'Delta',
      severity: 8,
      component: { name: 'ChargingStation' },
      variable: { name: 'AvailabilityState' },
      isHardwired: false,
    });

    for (const evse of this.config.evses) {
      const evseMonId = ++this.monitorIdCounter;
      this.variableMonitors.set(evseMonId, {
        id: evseMonId,
        type: 'Delta',
        severity: 8,
        component: { name: 'EVSE', evse: { id: evse.evseId } },
        variable: { name: 'AvailabilityState' },
        isHardwired: false,
      });
    }

    // Seed one hardwired monitor at high ID (for TC_N_44 clear-rejected test)
    const hwId = 1000;
    this.variableMonitors.set(hwId, {
      id: hwId,
      type: 'PeriodicClockAligned',
      severity: 0,
      component: { name: 'Connector', evse: { id: 1, connectorId: 1 } },
      variable: { name: 'Available' },
      isHardwired: true,
    });
  }

  private isKnownComponent(component: Record<string, unknown>): boolean {
    const name = component['name'] as string;
    if (name === 'ChargingStation') return true;
    if (name === 'EVSE') {
      const evse = component['evse'] as Record<string, unknown> | undefined;
      if (evse != null) {
        const evseId = evse['id'] as number;
        return this.config.evses.some((e) => e.evseId === evseId);
      }
      return true;
    }
    if (name === 'Connector') return true;
    return false;
  }

  private isKnownVariable(
    component: Record<string, unknown>,
    variable: Record<string, unknown>,
  ): boolean {
    const compName = component['name'] as string;
    const varName = variable['name'] as string;
    const knownVars: Record<string, string[]> = {
      ChargingStation: ['AvailabilityState', 'Model', 'VendorName'],
      EVSE: ['AvailabilityState', 'Power'],
      Connector: ['Available', 'ConnectorType'],
    };
    const vars = knownVars[compName];
    if (vars == null) return false;
    return vars.includes(varName);
  }

  private async simulateDiagnosticsUpload(location: string): Promise<void> {
    const delay = () => new Promise((resolve) => setTimeout(resolve, 500));
    try {
      // Simulate upload failure for unreachable locations
      if (location.includes('failedLocation') || location.includes('127.0.0.1')) {
        await delay();
        if (this.isDestroyed()) return;
        await this.sendDiagnosticsStatusNotification('Uploading');
        await delay();
        if (this.isDestroyed()) return;
        await this.sendDiagnosticsStatusNotification('UploadFailed');
        return;
      }
      await delay();
      if (this.isDestroyed()) return;
      await this.sendDiagnosticsStatusNotification('Uploading');
      await delay();
      if (this.isDestroyed()) return;
      await this.sendDiagnosticsStatusNotification('Uploaded');
    } catch {
      // Connection lost during upload
    }
  }

  private async onReconnect(): Promise<void> {
    try {
      await this.updateStationStatus('booting');
      await this.sendBootNotification('PowerUp');
      // Report actual connector status (may have changed while offline)
      for (const evse of this.config.evses) {
        const ctx = this.evseContexts.get(evse.evseId);
        const preserved = this.preservedTransactions.get(evse.evseId);
        // If we have a preserved transaction, report Occupied (cable still connected)
        const currentStatus =
          preserved != null
            ? 'Occupied'
            : (this.evseConnectorStatus.get(evse.evseId) ?? 'Available');
        if (preserved != null) {
          this.evseConnectorStatus.set(evse.evseId, 'Occupied');
          if (ctx != null) ctx.state = 'Occupied';
        }
        await this.sendStatusNotification(evse.evseId, evse.connectorId, currentStatus);
      }
      // Send SecurityEventNotification for startup (OCPP 2.1)
      if (!this.is16) {
        try {
          await this.sendSecurityEventNotification('StartupOfTheDevice');
        } catch {
          // Non-critical
        }
      }
      // Handle preserved transaction resumption (OCPP 2.1)
      if (!this.is16 && this.preservedTransactions.size > 0) {
        await this.handleTransactionResumption();
      }
      // Replay queued offline messages
      await this.replayOfflineQueue();
      await this.updateStationStatus('available');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.config.stationId}] Reconnect startup failed: ${msg}`);
    }
  }

  /**
   * Handle transaction resumption after power cycle (OCPP 2.1 only).
   * Checks TxCtrlr.ResumptionTimeout to decide whether to resume or end
   * each preserved transaction.
   */
  private async handleTransactionResumption(): Promise<void> {
    const resumptionTimeoutStr = this.getConfigValue('TxCtrlr.ResumptionTimeout');
    const allowEnergyResumption =
      this.getConfigValue('TxCtrlr.AllowEnergyTransferResumption') === 'true';

    for (const [evseId, preserved] of this.preservedTransactions) {
      const elapsedSec = (Date.now() - preserved.powerLossTime) / 1000;

      // Determine if we should resume
      let shouldResume = false;
      if (resumptionTimeoutStr == null) {
        // Absent: station does not support resumption (E_114)
        shouldResume = false;
      } else {
        const resumptionTimeout = Number(resumptionTimeoutStr);
        if (resumptionTimeout === 0) {
          // Timeout=0: never resume (E_115)
          shouldResume = false;
        } else if (elapsedSec < resumptionTimeout) {
          // Within timeout: resume (E_112, E_113)
          shouldResume = true;
        } else {
          // Expired: do not resume (E_116)
          shouldResume = false;
        }
      }

      if (shouldResume) {
        // Resume the transaction: send TransactionEvent Updated with TxResumed
        const chargingState = allowEnergyResumption ? 'Charging' : 'SuspendedEVSE';
        const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
        this.evseSeqNo.set(evseId, seqNo);
        this.evseChargingState.set(evseId, chargingState);
        await this.sendTransactionEvent(evseId, 'Updated', {
          triggerReason: 'TxResumed',
          transactionId: preserved.transactionId,
          chargingState,
          seqNo,
        });
        // If energy transfer is allowed, restart the meter loop
        if (allowEnergyResumption) {
          this.startMeterLoop(evseId);
        }
      } else {
        // End the transaction: send TransactionEvent Ended with AbnormalCondition
        const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
        this.evseSeqNo.set(evseId, seqNo);
        await this.sendTransactionEvent(evseId, 'Ended', {
          triggerReason: 'AbnormalCondition',
          transactionId: preserved.transactionId,
          stoppedReason: 'PowerLoss',
          seqNo,
        });
        // Complete the transaction in DB
        const gen = this.meterGens.get(evseId);
        const meterStopWh = gen?.energyWh ?? 0;
        await this.completeTransaction(preserved.transactionId, 'PowerLoss', meterStopWh);
        // Clean up EVSE context
        const ctx = this.evseContexts.get(evseId);
        if (ctx != null) {
          ctx.transactionId = null;
          ctx.authorizedToken = null;
          ctx.authorizedTokenType = null;
          ctx.remoteStartId = null;
        }
        this.evsePowerLimits.set(evseId, null);
        this.evseIdle.set(evseId, false);
        this.evseChargingState.set(evseId, null);
        this.evseSeqNo.set(evseId, 0);
        this.evseMeterTick.set(evseId, 0);
        this.evseTransactionLimits.delete(evseId);
        this.evseTotalCost.delete(evseId);
        this.evseTransactionStartTime.delete(evseId);
        this.evseLimitReached.delete(evseId);
        this.evseLastDriverLimits.delete(evseId);
        this.evseLastLocalCost.delete(evseId);

        // For E_116: after ending, if cable is still plugged, start a new transaction
        if (ctx?.cablePlugged === true) {
          const newTxId = randomUUID();
          const newSeqNo = 1;
          this.evseSeqNo.set(evseId, newSeqNo);
          this.evseChargingState.set(evseId, 'EVConnected');
          {
            ctx.transactionId = newTxId;
            ctx.state = 'EVConnected';
          }
          this.evseConnectorStatus.set(evseId, 'Occupied');
          await this.createTransaction(evseId, newTxId, '', '', 0);
          await this.sendTransactionEvent(evseId, 'Started', {
            triggerReason: 'CablePluggedIn',
            transactionId: newTxId,
            chargingState: 'EVConnected',
            seqNo: newSeqNo,
          });
        } else {
          // No cable: set connector to Available
          const connectorId = this.getConnectorId(evseId);
          this.evseConnectorStatus.set(evseId, 'Available');
          if (ctx != null) ctx.state = 'Available';
          await this.sendStatusNotification(evseId, connectorId, 'Available');
        }
      }
    }

    // Clear preserved transactions
    this.preservedTransactions = new Map();
  }

  private async replayOfflineQueue(): Promise<void> {
    while (this.offlineMessageQueue.length > 0) {
      const msg = this.offlineMessageQueue.shift();
      if (msg == null) break;
      try {
        console.log(`[${this.config.stationId}] Replaying queued ${msg.action}`);
        const response = await this.client.sendCall(msg.action, msg.payload);

        // Handle StartTransaction response (1.6): check if CS rejected the idTag
        if (msg.action === 'StartTransaction' && this.is16) {
          const idTagInfo = response['idTagInfo'] as Record<string, unknown> | undefined;
          const txId = response['transactionId'] as number | undefined;
          if (idTagInfo != null && idTagInfo['status'] !== 'Accepted' && txId != null) {
            const evseId = msg.payload['connectorId'] as number;
            const stopOnInvalid = this.getConfigValue('StopTransactionOnInvalidId') === 'true';
            if (stopOnInvalid) {
              // Stop the transaction with DeAuthorized reason
              await this.stopCharging(evseId, 'DeAuthorized');
            } else {
              // Suspend EVSE
              const connectorId = this.getConnectorId(evseId);
              this.evseConnectorStatus.set(evseId, 'SuspendedEVSE');
              await this.sendStatusNotification(evseId, connectorId, 'SuspendedEVSE');
            }
          }
        }

        // Handle TransactionEvent response (2.1): check if CS rejected the idToken
        if (msg.action === 'TransactionEvent' && !this.is16) {
          const idTokenInfo = response['idTokenInfo'] as Record<string, unknown> | undefined;
          if (idTokenInfo != null && idTokenInfo['status'] !== 'Accepted') {
            // Update auth cache with the CSMS response
            const idTokenObj = msg.payload['idToken'] as Record<string, unknown> | undefined;
            const tokenValue = idTokenObj?.['idToken'] as string | undefined;
            if (tokenValue != null) {
              this.authCache.set(tokenValue, idTokenInfo);
            }
            // Find the evseId from the payload
            const evseObj = msg.payload['evse'] as Record<string, unknown> | undefined;
            const evseId = (evseObj?.['id'] as number | undefined) ?? 1;
            const stopOnInvalid = this.getConfigValue('TxCtrlr.StopTxOnInvalidId') === 'true';
            const maxEnergy = Number(this.getConfigValue('TxCtrlr.MaxEnergyOnInvalidId') ?? '0');
            if (stopOnInvalid && maxEnergy <= 0) {
              // Stop the transaction with Deauthorized
              await this.stopCharging(evseId, 'DeAuthorized');
            } else if (!stopOnInvalid && maxEnergy <= 0) {
              // Suspend EVSE (do not stop transaction)
              const connectorId = this.getConnectorId(evseId);
              this.evseConnectorStatus.set(evseId, 'SuspendedEVSE');
              await this.sendStatusNotification(evseId, connectorId, 'SuspendedEVSE');
              // Send TransactionEvent Updated with SuspendedEVSE chargingState
              const ctx = this.evseContexts.get(evseId);
              if (ctx?.transactionId != null) {
                const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
                this.evseSeqNo.set(evseId, seqNo);
                await this.sendTransactionEvent(evseId, 'Updated', {
                  triggerReason: 'ChargingStateChanged',
                  transactionId: ctx.transactionId,
                  chargingState: 'SuspendedEVSE',
                  seqNo,
                });
              }
            }
            // When maxEnergy > 0: continue charging with limited energy (handled by meter gen)
            // When stopOnInvalid && maxEnergy > 0: deauthorize after delivering maxEnergy
            if (stopOnInvalid && maxEnergy > 0) {
              // For simplicity, deauthorize immediately (real station would wait until energy limit)
              await this.stopCharging(evseId, 'DeAuthorized');
            }
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[${this.config.stationId}] Failed to replay ${msg.action}: ${errMsg}`);
      }
    }
  }

  /** Queue a message for later replay when back online. */
  private queueOfflineMessage(action: string, payload: Record<string, unknown>): void {
    this.offlineMessageQueue.push({ action, payload });
    console.log(
      `[${this.config.stationId}] Queued ${action} (${String(this.offlineMessageQueue.length)} in queue)`,
    );
  }

  /** Simulate a power cycle: stop active transactions, disconnect, reconnect. */
  async simulatePowerCycle(reason: string = 'PowerLoss'): Promise<void> {
    // Stop all active transactions with the given reason
    for (const evse of this.config.evses) {
      const ctx = this.evseContexts.get(evse.evseId);
      if (ctx?.transactionId != null) {
        try {
          await this.stopCharging(evse.evseId, reason);
        } catch {
          // May fail if already stopped or offline
        }
      }
    }
    // Drop connection (simulates reboot). Auto-reconnect will trigger onReconnect.
    this.client.simulateConnectionLoss();
  }

  /**
   * Simulate a power cycle that preserves transaction state (OCPP 2.1 only).
   * On reconnect, the station checks TxCtrlr.ResumptionTimeout to decide
   * whether to resume or end the transaction. Used for E_112-E_116 tests.
   */
  async simulatePowerCyclePreserveTransactions(): Promise<void> {
    if (this.is16) {
      // 1.6 does not support transaction resumption
      await this.simulatePowerCycle('PowerLoss');
      return;
    }

    // Save transaction state per EVSE before disconnecting
    const preservedTransactions = new Map<
      number,
      { transactionId: string; idToken: string; tokenType: string; powerLossTime: number }
    >();
    for (const evse of this.config.evses) {
      const ctx = this.evseContexts.get(evse.evseId);
      if (ctx?.transactionId != null) {
        preservedTransactions.set(evse.evseId, {
          transactionId: ctx.transactionId,
          idToken: ctx.authorizedToken ?? '',
          tokenType: ctx.authorizedTokenType ?? 'ISO14443',
          powerLossTime: Date.now(),
        });
        // Stop meter loop but do NOT send TransactionEvent Ended or clear state
        this.stopMeterLoop(evse.evseId);
      }
    }

    // Store preserved transactions for onReconnect
    this.preservedTransactions = preservedTransactions;

    // Drop connection (simulates reboot). Auto-reconnect will trigger onReconnect.
    this.client.simulateConnectionLoss();
  }

  /** Simulate a connector lock failure by sending a NotifyEvent with
   *  ConnectorPlugRetentionLock Problem = true. OCPP 2.1 only. */
  async simulateLockFailure(evseId: number, connectorId: number = 1): Promise<void> {
    if (this.is16) return;
    await this.sendNotifyEvent([
      {
        eventId: Date.now(),
        timestamp: new Date().toISOString(),
        trigger: 'Delta',
        actualValue: 'true',
        component: { name: 'ConnectorPlugRetentionLock', evse: { id: evseId, connectorId } },
        variable: { name: 'Problem' },
        eventNotificationType: 'HardWiredNotification',
      },
    ]);
  }

  // ---------------------------------------------------------------------------
  // Meter loop (private)
  // ---------------------------------------------------------------------------

  private startMeterLoop(evseId: number): void {
    this.stopMeterLoop(evseId);

    const gen = this.meterGens.get(evseId);
    if (gen == null) return;

    let meterTick = 0;

    const sendTick = (): void => {
      meterTick++;
      this.evseMeterTick.set(evseId, meterTick);

      const idle = this.evseIdle.get(evseId) ?? false;

      // OCPP 2.1 chargingState lifecycle
      if (!this.is16) {
        const txResult = this.getActiveTransactionSync(evseId);
        if (txResult != null) {
          const currentState = this.evseChargingState.get(evseId);

          // Tick 1: EVConnected -> Charging
          if (meterTick === 1 && currentState === 'EVConnected') {
            this.evseChargingState.set(evseId, 'Charging');
            const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
            this.evseSeqNo.set(evseId, seqNo);
            void this.sendTransactionEvent(evseId, 'Updated', {
              triggerReason: 'ChargingStateChanged',
              transactionId: txResult,
              chargingState: 'Charging',
              seqNo,
            }).catch(() => {});
          }
        }
      }

      // Advance simulation state
      gen.tick(idle, this.evsePowerLimits.get(evseId) ?? null);

      // Read configured measurands
      const measurands = this.getSampledMeasurands();
      const sampledValues = gen.generate(measurands, this.is16);

      // Get active transaction for this EVSE (sync check using cached state)
      const txId = this.getActiveTransactionSync(evseId);

      // OCPP 2.1: send TransactionEvent Updated with MeterValuePeriodic during tx
      if (!this.is16 && txId != null) {
        const periodicValues = sampledValues.map((sv) => ({
          ...sv,
          context: 'Sample.Periodic',
        }));
        const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
        this.evseSeqNo.set(evseId, seqNo);
        void this.sendTransactionEvent(evseId, 'Updated', {
          triggerReason: 'MeterValuePeriodic',
          transactionId: txId,
          chargingState: this.evseChargingState.get(evseId) ?? 'Charging',
          seqNo,
          meterValue: [
            {
              timestamp: new Date().toISOString(),
              sampledValue: periodicValues,
            },
          ] as unknown as Array<Record<string, unknown>>,
        }).catch(() => {});
      } else {
        void this.sendMeterValues(
          evseId,
          sampledValues as unknown as Array<Record<string, unknown>>,
          txId ?? undefined,
        ).catch(() => {});
      }

      // Update transaction in DB periodically
      if (txId != null) {
        void this.updateTransaction(txId, {
          currentPowerW: gen.currentPowerW,
          currentSoc: null,
          chargingState: this.evseChargingState.get(evseId) ?? null,
          seqNo: this.evseSeqNo.get(evseId) ?? 0,
        }).catch(() => {});
      }

      // OCPP 2.1: check for driver-set limit changes and send LimitSet
      if (!this.is16 && txId != null) {
        void this.checkDriverSetLimitChanges(evseId, txId).catch(() => {});
      }

      // OCPP 2.1: send RunningCost event if local cost calculation is active
      if (!this.is16 && txId != null) {
        void this.sendRunningCostIfNeeded(evseId, txId, gen).catch(() => {});
      }

      // OCPP 2.1: check transaction limits (energy, time, cost)
      if (!this.is16 && txId != null && !(this.evseLimitReached.get(evseId) ?? false)) {
        void this.checkTransactionLimits(evseId, txId, gen).catch(() => {});
      }
    };

    const intervalMs = this.getSampledIntervalMs();
    sendTick();
    this.meterTimers.set(evseId, setInterval(sendTick, intervalMs));
  }

  private stopMeterLoop(evseId: number): void {
    const timer = this.meterTimers.get(evseId);
    if (timer != null) {
      clearInterval(timer);
      this.meterTimers.delete(evseId);
    }
  }

  /**
   * Check transaction limits (energy, time, cost) and send limit-reached events.
   * Called from the meter loop on each tick for OCPP 2.1 transactions.
   */
  /**
   * Check if driver-set limits (from config variables) changed since last report.
   * If changed, send a LimitSet TransactionEvent.
   */
  private async checkDriverSetLimitChanges(evseId: number, txId: string): Promise<void> {
    const current = this.getDriverSetLimits();
    const previous = this.evseLastDriverLimits.get(evseId) ?? null;

    // Compare: detect changes
    const changed =
      current?.maxEnergy !== previous?.maxEnergy ||
      current?.maxTime !== previous?.maxTime ||
      current?.maxCost !== previous?.maxCost;

    if (!changed) return;

    this.evseLastDriverLimits.set(evseId, current != null ? { ...current } : null);

    if (current == null) return;

    // Merge CSMS limits with driver limits to report the combined limit
    const csmsLimits = this.evseTransactionLimits.get(evseId);
    const combined: { maxEnergy?: number; maxTime?: number; maxCost?: number } = {};
    const mergedEnergy = this.pickMostRestrictive(current.maxEnergy, csmsLimits?.maxEnergy);
    if (mergedEnergy != null) combined.maxEnergy = mergedEnergy;
    const mergedTime = this.pickMostRestrictive(current.maxTime, csmsLimits?.maxTime);
    if (mergedTime != null) combined.maxTime = mergedTime;
    const mergedCost = this.pickMostRestrictive(current.maxCost, csmsLimits?.maxCost);
    if (mergedCost != null) combined.maxCost = mergedCost;

    // Reset limit-reached flag when limits change
    this.evseLimitReached.set(evseId, false);

    const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
    this.evseSeqNo.set(evseId, seqNo);
    await this.sendTransactionEvent(evseId, 'Updated', {
      triggerReason: 'LimitSet',
      transactionId: txId,
      chargingState: this.evseChargingState.get(evseId) ?? 'Charging',
      seqNo,
      transactionLimit: combined,
    });
  }

  /**
   * Send a RunningCost TransactionEvent if local cost calculation is active
   * and the cost has changed since last report.
   */
  private async sendRunningCostIfNeeded(
    evseId: number,
    txId: string,
    gen: MeterValueGenerator,
  ): Promise<void> {
    const localCost = this.calculateLocalCost(evseId, gen);
    if (localCost == null) return;

    const lastCost = this.evseLastLocalCost.get(evseId) ?? -1;
    // Only send if cost changed by at least 0.01 (avoid spamming)
    if (Math.abs(localCost - lastCost) < 0.01) return;

    this.evseLastLocalCost.set(evseId, localCost);

    // Find the tariff to get currency
    let currency = 'EUR';
    for (const entry of this.defaultTariffs.values()) {
      if (entry.evseId === 0 || entry.evseId === evseId) {
        currency = (entry.tariff['currency'] as string | undefined) ?? 'EUR';
        break;
      }
    }

    const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
    this.evseSeqNo.set(evseId, seqNo);
    await this.sendTransactionEvent(evseId, 'Updated', {
      triggerReason: 'RunningCost',
      transactionId: txId,
      chargingState: this.evseChargingState.get(evseId) ?? 'Charging',
      seqNo,
      costDetails: {
        totalCost: Math.round(localCost * 100) / 100,
        currency,
        totalEnergy: Math.round((gen.energyWh / 1000) * 100) / 100,
      },
    });
  }

  private async checkTransactionLimits(
    evseId: number,
    txId: string,
    gen: MeterValueGenerator,
  ): Promise<void> {
    const limits = this.evseTransactionLimits.get(evseId);
    const csLimits = this.getDriverSetLimits();
    if (limits == null && csLimits == null) return;

    // Merge CSMS limits and driver-set limits (use the most restrictive)
    const effectiveMaxEnergy = this.pickMostRestrictive(limits?.maxEnergy, csLimits?.maxEnergy);
    const effectiveMaxTime = this.pickMostRestrictive(limits?.maxTime, csLimits?.maxTime);
    const effectiveMaxCost = this.pickMostRestrictive(limits?.maxCost, csLimits?.maxCost);

    // Check energy limit (energyWh is cumulative in Wh, maxEnergy is also in Wh)
    if (effectiveMaxEnergy != null && gen.energyWh >= effectiveMaxEnergy) {
      this.evseLimitReached.set(evseId, true);
      await this.sendLimitReachedEvent(evseId, txId, 'EnergyLimitReached');
      return;
    }

    // Check time limit (maxTime in seconds)
    if (effectiveMaxTime != null) {
      const startTime = this.evseTransactionStartTime.get(evseId);
      if (startTime != null) {
        const elapsedSecs = (Date.now() - startTime) / 1000;
        if (elapsedSecs >= effectiveMaxTime) {
          this.evseLimitReached.set(evseId, true);
          await this.sendLimitReachedEvent(evseId, txId, 'TimeLimitReached');
          return;
        }
      }
    }

    // Check cost limit (using CSMS-provided totalCost)
    if (effectiveMaxCost != null) {
      const totalCost = this.evseTotalCost.get(evseId);
      const localCost = this.calculateLocalCost(evseId, gen);
      const currentCost = totalCost ?? localCost;
      if (currentCost != null && currentCost >= effectiveMaxCost) {
        this.evseLimitReached.set(evseId, true);
        await this.sendLimitReachedEvent(evseId, txId, 'CostLimitReached');
        return;
      }
    }
  }

  /** Return the smaller of two optional limit values. */
  private pickMostRestrictive(a?: number, b?: number): number | undefined {
    if (a == null) return b;
    if (b == null) return a;
    return Math.min(a, b);
  }

  /** Get driver-set limits from configuration variables. */
  private getDriverSetLimits(): { maxEnergy?: number; maxTime?: number; maxCost?: number } | null {
    const maxEnergy = this.getConfigValue('TxCtrlr.MaxEnergyLimit');
    const maxTime = this.getConfigValue('TxCtrlr.MaxTimeLimit');
    const maxCost = this.getConfigValue('TxCtrlr.MaxCostLimit');
    if (maxEnergy == null && maxTime == null && maxCost == null) return null;
    const result: { maxEnergy?: number; maxTime?: number; maxCost?: number } = {};
    if (maxEnergy != null) result.maxEnergy = Number(maxEnergy);
    if (maxTime != null) result.maxTime = Number(maxTime);
    if (maxCost != null) result.maxCost = Number(maxCost);
    return result;
  }

  /**
   * Calculate local cost from the active tariff. Returns the running cost in currency units
   * or null if no tariff is configured.
   */
  private calculateLocalCost(evseId: number, gen: MeterValueGenerator): number | null {
    // Find applicable tariff for this EVSE
    let tariff: Record<string, unknown> | null = null;
    for (const entry of this.defaultTariffs.values()) {
      if (entry.evseId === 0 || entry.evseId === evseId) {
        tariff = entry.tariff;
        break;
      }
    }
    if (tariff == null) return null;

    const startTime = this.evseTransactionStartTime.get(evseId);
    if (startTime == null) return null;

    const elapsedMinutes = (Date.now() - startTime) / 60000;
    let cost = 0;

    // Calculate charging time cost
    const chargingTime = tariff['chargingTime'] as Record<string, unknown> | undefined;
    if (chargingTime != null) {
      const prices = chargingTime['prices'] as Array<Record<string, unknown>> | undefined;
      if (prices != null && prices.length > 0) {
        const firstPrice = prices[0];
        const pricePerMinute = (firstPrice?.['priceMinute'] as number | undefined) ?? 0;
        cost += pricePerMinute * elapsedMinutes;
      }
    }

    // Calculate energy cost
    const energy = tariff['energy'] as Record<string, unknown> | undefined;
    if (energy != null) {
      const prices = energy['prices'] as Array<Record<string, unknown>> | undefined;
      if (prices != null && prices.length > 0) {
        const firstEnergyPrice = prices[0];
        const pricePerKwh = (firstEnergyPrice?.['priceKwh'] as number | undefined) ?? 0;
        cost += pricePerKwh * (gen.energyWh / 1000);
      }
    }

    return cost;
  }

  /**
   * Send a TransactionEvent Updated with a limit-reached trigger reason.
   * Suspends the EVSE after sending.
   */
  private async sendLimitReachedEvent(
    evseId: number,
    txId: string,
    triggerReason: string,
  ): Promise<void> {
    // Change charging state to SuspendedEVSE
    this.evseChargingState.set(evseId, 'SuspendedEVSE');
    const connectorId = this.getConnectorId(evseId);
    await this.sendStatusNotification(evseId, connectorId, 'Occupied');

    const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
    this.evseSeqNo.set(evseId, seqNo);
    await this.sendTransactionEvent(evseId, 'Updated', {
      triggerReason,
      transactionId: txId,
      chargingState: 'SuspendedEVSE',
      seqNo,
    });

    // Stop meter loop since charging is suspended
    this.stopMeterLoop(evseId);
  }

  // ---------------------------------------------------------------------------
  // Config helpers
  // ---------------------------------------------------------------------------

  private getConfigValue(key: string): string | undefined {
    return this.configVariables.get(key)?.value;
  }

  /** Set a config variable directly, bypassing read-only checks. For testing. */
  setConfigValue(key: string, value: string): void {
    const existing = this.configVariables.get(key);
    if (existing != null) {
      existing.value = value;
    } else {
      this.configVariables.set(key, { value, readonly: false });
    }
    // Restart clock-aligned timer if interval changed
    if (
      key === 'AlignedDataCtrlr.Interval' ||
      key === 'AlignedDataCtrlr.Measurands' ||
      key === 'ClockAlignedDataInterval'
    ) {
      this.startClockAlignedTimer();
    }
    // Seed test transaction for OCTT tariff tests
    if (key === '_seedTestTransaction' && value === 'true') {
      this.activeTransactionIds.set(1, 'test-tx');
      this.transactionTariffCurrency.set('test-tx', 'EUR');
    }
  }

  /** Delete a config variable. For testing (e.g., simulating absent TxCtrlr.ResumptionTimeout). */
  deleteConfigValue(key: string): void {
    this.configVariables.delete(key);
  }

  private getSampledMeasurands(): string[] {
    if (this.is16) {
      const val = this.getConfigValue('MeterValuesSampledData') ?? '';
      return val.split(',').filter(Boolean);
    }
    const val = this.getConfigValue('SampledDataCtrlr.TxUpdatedMeasurands') ?? '';
    return val.split(',').filter(Boolean);
  }

  private getSampledIntervalMs(): number {
    if (this.is16) {
      const secs = Number(this.getConfigValue('MeterValueSampleInterval') ?? '10');
      return (isNaN(secs) || secs <= 0 ? 10 : secs) * 1000;
    }
    const secs = Number(this.getConfigValue('SampledDataCtrlr.TxUpdatedInterval') ?? '10');
    return (isNaN(secs) || secs <= 0 ? 10 : secs) * 1000;
  }

  private getAlignedMeasurands(): string[] {
    if (this.is16) {
      const val = this.getConfigValue('MeterValuesAlignedData') ?? '';
      return val.split(',').filter(Boolean);
    }
    const val = this.getConfigValue('AlignedDataCtrlr.Measurands') ?? '';
    return val.split(',').filter(Boolean);
  }

  // ---------------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------------

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat().catch(() => {});
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer != null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // EVSE helpers
  // ---------------------------------------------------------------------------

  private getConnectorId(evseId: number): number {
    const evse = this.config.evses.find((e) => e.evseId === evseId);
    return evse?.connectorId ?? 1;
  }

  // Synchronous check using cached transaction ID for meter loop
  // We store per-EVSE txId in memory when startCharging/stopCharging is called
  private readonly activeTransactionIds = new Map<number, string>();

  private getActiveTransactionSync(evseId: number): string | null {
    return this.activeTransactionIds.get(evseId) ?? null;
  }

  // ---------------------------------------------------------------------------
  // DB helpers
  // ---------------------------------------------------------------------------

  private async updateStationStatus(status: string): Promise<void> {
    try {
      await this.sql`
        UPDATE css_stations SET status = ${status}, updated_at = NOW()
        WHERE id = ${this.config.id}
      `;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.config.stationId}] Failed to update station status: ${msg}`);
    }
  }

  private async updateEvseStatus(evseId: number, status: string): Promise<void> {
    try {
      await this.sql`
        UPDATE css_evses SET status = ${status}
        WHERE css_station_id = ${this.config.id} AND evse_id = ${evseId}
      `;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.config.stationId}] Failed to update EVSE status: ${msg}`);
    }
  }

  private async loadConfigVariables(): Promise<void> {
    if (this.configLoaded) return;

    try {
      const rows = await this.sql`
        SELECT key, value, readonly FROM css_config_variables
        WHERE css_station_id = ${this.config.id}
      `;

      for (const row of rows) {
        this.configVariables.set(row.key as string, {
          value: row.value as string,
          readonly: row.readonly as boolean,
        });
      }
    } catch {
      // DB may not have rows yet, load defaults
    }

    // Seed defaults if not loaded from DB
    if (this.configVariables.size === 0) {
      this.seedDefaultConfigVariables();
    }

    this.configLoaded = true;

    // Load installed certificates from DB into cache, then seed defaults if empty
    try {
      const certRows = await this.sql<
        Array<{
          certificate_type: string;
          hash_algorithm: string;
          issuer_name_hash: string;
          issuer_key_hash: string;
          serial_number: string;
        }>
      >`
        SELECT certificate_type, hash_algorithm, issuer_name_hash, issuer_key_hash, serial_number
        FROM css_installed_certificates
        WHERE css_station_id = ${this.config.id}
      `;
      for (const row of certRows) {
        this.installedCertificatesCache.set(row.serial_number, {
          certificateType: row.certificate_type,
          certificateHashData: {
            hashAlgorithm: row.hash_algorithm,
            issuerNameHash: row.issuer_name_hash,
            issuerKeyHash: row.issuer_key_hash,
            serialNumber: row.serial_number,
          },
        });
      }
    } catch {
      // DB may not be available
    }
    if (this.installedCertificatesCache.size === 0) {
      this.seedDefaultCertificates();
    }
  }

  private seedDefaultCertificates(): void {
    const defaults = [
      {
        serial: '01',
        certificateType: 'CSMSRootCertificate',
        certificateHashData: {
          hashAlgorithm: 'SHA256',
          issuerNameHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
          issuerKeyHash: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
          serialNumber: '01',
        },
      },
      {
        serial: '02',
        certificateType: 'ManufacturerRootCertificate',
        certificateHashData: {
          hashAlgorithm: 'SHA256',
          issuerNameHash: 'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
          issuerKeyHash: 'd4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5',
          serialNumber: '02',
        },
      },
      {
        serial: '03',
        certificateType: 'V2GCertificateChain',
        certificateHashData: {
          hashAlgorithm: 'SHA256',
          issuerNameHash: 'e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6',
          issuerKeyHash: 'f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1',
          serialNumber: '03',
        },
      },
      {
        serial: '04',
        certificateType: 'V2GRootCertificate',
        certificateHashData: {
          hashAlgorithm: 'SHA256',
          issuerNameHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
          issuerKeyHash: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
          serialNumber: '04',
        },
      },
      {
        serial: '05',
        certificateType: 'MORootCertificate',
        certificateHashData: {
          hashAlgorithm: 'SHA256',
          issuerNameHash: 'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
          issuerKeyHash: 'd4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5',
          serialNumber: '05',
        },
      },
    ];
    for (const d of defaults) {
      this.installedCertificatesCache.set(d.serial, {
        certificateType: d.certificateType,
        certificateHashData: d.certificateHashData,
      });
    }
  }

  private seedDefaultConfigVariables(): void {
    if (this.is16) {
      const defaults: Array<[string, string, boolean]> = [
        ['NumberOfConnectors', String(this.config.evses.length), true],
        ['HeartbeatInterval', '300', false],
        ['MeterValueSampleInterval', '10', false],
        ['MeterValuesSampledData', 'Energy.Active.Import.Register,Power.Active.Import', false],
        ['AuthorizationCacheEnabled', 'true', false],
        ['LocalPreAuthorize', 'false', false],
        ['LocalAuthorizeOffline', 'true', false],
        ['AllowOfflineTxForUnknownId', 'false', false],
        ['ClockAlignedDataInterval', '900', false],
        ['ConnectionTimeOut', '60', false],
        ['LocalAuthListEnabled', 'true', false],
        ['LocalAuthListMaxLength', '100', true],
        ['MeterValuesAlignedData', 'Energy.Active.Import.Register,Voltage', false],
        ['ResetRetries', '3', false],
        ['TransactionMessageAttempts', '3', false],
        ['TransactionMessageRetryInterval', '30', false],
        ['StopTransactionOnEVSideDisconnect', 'true', false],
        ['StopTransactionOnInvalidId', 'true', false],
        ['WebSocketPingInterval', '30', false],
        [
          'SupportedFeatureProfiles',
          'Core,FirmwareManagement,LocalAuthListManagement,Reservation,SmartCharging,RemoteTrigger',
          true,
        ],
        ['ChargeProfileMaxStackLevel', '5', true],
        ['ChargingScheduleAllowedChargingRateUnit', 'Current,Power', true],
        ['ChargingScheduleMaxPeriods', '24', true],
        ['MaxChargingProfilesInstalled', '10', true],
        ['ConnectorPhaseRotation', '1.RST', true],
        ['GetConfigurationMaxKeys', '50', true],
        ['AuthorizationKey', '', false],
        ['ChargePointVendor', this.config.vendorName, true],
        ['ChargePointModel', this.config.model, true],
        ['ChargePointSerialNumber', this.config.serialNumber, true],
        ['FirmwareVersion', this.config.firmwareVersion, true],
      ];
      for (const [key, value, readonly] of defaults) {
        this.configVariables.set(key, { value, readonly });
      }
    } else {
      const defaults: Array<[string, string, boolean]> = [
        ['OCPPCommCtrlr.HeartbeatInterval', '300', false],
        ['OCPPCommCtrlr.NetworkConfigurationPriority', '1', false],
        ['OCPPCommCtrlr.OfflineThreshold', '60', false],
        ['OCPPCommCtrlr.MessageTimeout', '30', true],
        ['OCPPCommCtrlr.RetryBackOffWaitMinimum', '10', false],
        ['OCPPCommCtrlr.RetryBackOffRandomRange', '5', false],
        ['ChargingStation.VendorName', this.config.vendorName, true],
        ['ChargingStation.Model', this.config.model, true],
        ['ChargingStation.SerialNumber', this.config.serialNumber, true],
        ['ChargingStation.FirmwareVersion', this.config.firmwareVersion, true],
        ['ChargingStation.AvailabilityState', 'Available', false],
        ['SecurityCtrlr.SecurityProfile', String(this.config.securityProfile), false],
        ['SecurityCtrlr.Identity', this.config.stationId, false],
        ['SecurityCtrlr.BasicAuthPassword', '', false],
        ['SecurityCtrlr.AllowSecurityDowngrade', 'false', false],
        // NetworkConfiguration per slot (instance = slot number)
        ['NetworkConfiguration.OcppCsmsUrl#1', this.config.targetUrl, false],
        ['NetworkConfiguration.OcppInterface#1', 'Any', false],
        ['NetworkConfiguration.OcppTransport#1', 'JSON', false],
        ['NetworkConfiguration.OcppVersion#1', 'OCPP21', false],
        ['NetworkConfiguration.MessageTimeout#1', '30', false],
        ['NetworkConfiguration.SecurityProfile#1', String(this.config.securityProfile), false],
        ['NetworkConfiguration.BasicAuthPassword#1', '', false],
        ['NetworkConfiguration.VpnEnabled#1', 'false', false],
        ['NetworkConfiguration.ApnEnabled#1', 'false', false],
        // Slot 2 (non-active, writable for tests)
        ['NetworkConfiguration.OcppCsmsUrl#2', '', false],
        ['NetworkConfiguration.OcppInterface#2', 'Any', false],
        ['NetworkConfiguration.OcppTransport#2', 'JSON', false],
        ['NetworkConfiguration.OcppVersion#2', 'OCPP21', false],
        ['NetworkConfiguration.MessageTimeout#2', '30', false],
        ['NetworkConfiguration.SecurityProfile#2', String(this.config.securityProfile), false],
        ['NetworkConfiguration.BasicAuthPassword#2', '', false],
        ['NetworkConfiguration.VpnEnabled#2', 'false', false],
        ['NetworkConfiguration.ApnEnabled#2', 'false', false],
        ['AuthCtrlr.Enabled', 'true', false],
        ['AuthCtrlr.AuthorizeRemoteStart', 'true', false],
        ['AuthCtrlr.DisableRemoteAuthorization', 'false', false],
        ['AuthCtrlr.LocalAuthorizeOffline', 'true', false],
        ['AuthCtrlr.LocalPreAuthorize', 'false', false],
        ['AuthCacheCtrlr.Enabled', 'true', false],
        ['AuthCacheCtrlr.DisablePostAuthorize', 'false', false],
        ['LocalAuthListCtrlr.DisablePostAuthorize', 'false', false],
        ['AuthCacheCtrlr.LifeTime', '86400', false],
        ['ClockCtrlr.TimeSource', 'NTP', true],
        ['Connector.Available', 'true', false],
        ['Connector.ConnectorType', 'cType2', true],
        ['Connector.SupplyPhases', '3', true],
        ['EVSE.AvailabilityState', 'Available', false],
        ['EVSE.Power', String(this.config.evses[0]?.maxPowerW ?? 22000), true],
        ['SampledDataCtrlr.TxUpdatedInterval', '10', false],
        [
          'SampledDataCtrlr.TxUpdatedMeasurands',
          'Energy.Active.Import.Register,Power.Active.Import,Voltage,Current.Import',
          false,
        ],
        ['TxCtrlr.EVConnectionTimeOut', '60', false],
        ['TxCtrlr.StopTxOnInvalidId', 'true', false],
        ['TxCtrlr.MaxEnergyOnInvalidId', '0', false],
        ['TxCtrlr.StopTxOnEVSideDisconnect', 'true', false],
        ['TxCtrlr.ResumptionTimeout', '0', false],
        ['MonitoringCtrlr.Enabled', 'true', false],
        ['DeviceDataCtrlr.ItemsPerMessage', '50', true],
        ['DeviceDataCtrlr.ItemsPerMessage#GetReport', '50', true],
        ['DeviceDataCtrlr.ItemsPerMessage#NotifyReport', '50', true],
        ['DeviceDataCtrlr.ItemsPerMessage#SetVariables', '50', true],
        ['DeviceDataCtrlr.ItemsPerMessage#GetVariables', '50', true],
        ['DeviceDataCtrlr.BytesPerMessage', '65536', true],
        ['DeviceDataCtrlr.BytesPerMessage#GetReport', '65536', true],
        ['DeviceDataCtrlr.BytesPerMessage#NotifyReport', '65536', true],
        ['AlignedDataCtrlr.Interval', '900', false],
        ['AlignedDataCtrlr.Measurands', 'Energy.Active.Import.Register,Voltage', false],
        ['CustomizationCtrlr.CustomTriggers', 'DiagnosticsLog,SecurityAudit', true],
        ['TariffCostCtrlr.Enabled', 'true', false],
        ['TariffCostCtrlr.TariffFallbackMessage', 'See operator for pricing', false],
        ['TariffCostCtrlr.Currency', 'EUR', false],
        ['TariffCostCtrlr.MaxElements#Tariff', '10', true],
      ];
      for (const [key, value, readonly] of defaults) {
        this.configVariables.set(key, { value, readonly });
      }
    }

    // Seed default charging profiles for OCPP 2.1 (TxDefaultProfile on each EVSE)
    if (!this.is16) {
      for (const evse of this.config.evses) {
        const profileId = evse.evseId;
        this.chargingProfilesCache.set(profileId, {
          id: profileId,
          chargingProfileId: profileId,
          stackLevel: 0,
          chargingProfilePurpose: 'TxDefaultProfile',
          chargingProfileKind: 'Absolute',
          _evseId: evse.evseId,
          chargingSchedule: [
            {
              id: profileId,
              chargingRateUnit: 'A',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 32, numberPhases: 3 }],
            },
          ],
        });
      }
      // Note: test-tx transaction for OCTT tariff tests is seeded via
      // setConfigValue('_seedTestTransaction', 'true') from the test, not on every boot
    }

    // Persist defaults to DB (verify station exists first to avoid FK violations)
    void (async () => {
      try {
        const rows = await this.sql`
          SELECT 1 FROM css_stations WHERE id = ${this.config.id} LIMIT 1
        `;
        if (rows.length === 0) return;
        for (const [key, entry] of this.configVariables) {
          await this.saveConfigVariable(key, entry.value, entry.readonly);
        }
      } catch {
        // Station may have been deleted between check and save; ignore
      }
    })();
  }

  private async saveConfigVariable(
    key: string,
    value: string,
    readonly: boolean = false,
  ): Promise<void> {
    try {
      const configVarId = 'ccv_' + randomUUID().replace(/-/g, '').slice(0, 12);
      await this.sql`
        INSERT INTO css_config_variables (id, css_station_id, key, value, readonly)
        VALUES (${configVarId}, ${this.config.id}, ${key}, ${value}, ${readonly})
        ON CONFLICT (css_station_id, key) DO UPDATE
        SET value = EXCLUDED.value
      `;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // FK violations mean the station was deleted; silently ignore
      if (!msg.includes('foreign key')) {
        console.warn(`[${this.config.stationId}] Failed to save config variable ${key}: ${msg}`);
      }
    }
  }

  private async getActiveTransaction(
    evseId: number,
  ): Promise<{ transactionId: string; meterStartWh: number; idToken: string } | null> {
    try {
      const rows = await this.sql`
        SELECT transaction_id, meter_start_wh, id_token FROM css_transactions
        WHERE css_station_id = ${this.config.id} AND evse_id = ${evseId} AND status = 'active'
        ORDER BY started_at DESC LIMIT 1
      `;
      const row = rows[0];
      if (row == null) return null;
      return {
        transactionId: row.transaction_id as string,
        meterStartWh: row.meter_start_wh as number,
        idToken: (row.id_token as string | null) ?? '',
      };
    } catch {
      return null;
    }
  }

  private async findEvseForTransaction(transactionId: string): Promise<number | null> {
    try {
      const rows = await this.sql`
        SELECT evse_id FROM css_transactions
        WHERE css_station_id = ${this.config.id} AND transaction_id = ${transactionId} AND status = 'active'
        LIMIT 1
      `;
      const row = rows[0];
      if (row == null) return null;
      return row.evse_id as number;
    } catch {
      return null;
    }
  }

  private async hasAnyActiveTransaction(): Promise<boolean> {
    // Check in-memory context first (works even when DB is unavailable)
    for (const ctx of this.evseContexts.values()) {
      if (ctx.transactionId != null) return true;
    }
    try {
      const rows = await this.sql`
        SELECT 1 FROM css_transactions
        WHERE css_station_id = ${this.config.id} AND status = 'active'
        LIMIT 1
      `;
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  private async createTransaction(
    evseId: number,
    txId: string,
    idToken: string,
    tokenType: string,
    meterStartWh: number,
  ): Promise<void> {
    // Track in memory for sync access
    this.activeTransactionIds.set(evseId, txId);

    // Mark default tariffs as in use for this transaction (OCPP 2.1 only)
    if (!this.is16) {
      for (const entry of this.defaultTariffs.values()) {
        if (entry.evseId === 0 || entry.evseId === evseId) {
          entry.inUse = true;
        }
      }
    }

    try {
      const txRowId = 'ctx_' + randomUUID().replace(/-/g, '').slice(0, 12);
      await this.sql`
        INSERT INTO css_transactions (id, css_station_id, evse_id, transaction_id, id_token, token_type, meter_start_wh, charging_state)
        VALUES (${txRowId}, ${this.config.id}, ${evseId}, ${txId}, ${idToken}, ${tokenType}, ${meterStartWh}, ${'EVConnected'})
        ON CONFLICT (css_station_id, transaction_id) DO NOTHING
      `;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.config.stationId}] Failed to create transaction: ${msg}`);
    }
  }

  private async updateTransaction(
    txId: string,
    updates: {
      currentPowerW?: number;
      currentSoc?: number | null;
      chargingState?: string | null;
      seqNo?: number;
    },
  ): Promise<void> {
    try {
      const sets: string[] = [];
      const values: unknown[] = [];

      if (updates.currentPowerW != null) {
        sets.push('current_power_w');
        values.push(updates.currentPowerW);
      }
      if (updates.chargingState !== undefined) {
        sets.push('charging_state');
        values.push(updates.chargingState);
      }
      if (updates.seqNo != null) {
        sets.push('seq_no');
        values.push(updates.seqNo);
      }

      // Use a simpler update since tagged template literals
      // do not support dynamic column names easily
      await this.sql`
        UPDATE css_transactions
        SET current_power_w = ${updates.currentPowerW ?? 0},
            charging_state = ${updates.chargingState ?? null},
            seq_no = ${updates.seqNo ?? 0}
        WHERE css_station_id = ${this.config.id} AND transaction_id = ${txId} AND status = 'active'
      `;
    } catch {
      // Ignore update failures
    }
  }

  private async completeTransaction(
    txId: string,
    reason: string,
    meterStopWh: number,
  ): Promise<void> {
    // Remove from memory cache
    for (const [evseId, id] of this.activeTransactionIds) {
      if (id === txId) {
        this.activeTransactionIds.delete(evseId);
        break;
      }
    }

    try {
      await this.sql`
        UPDATE css_transactions
        SET status = 'completed', stopped_at = NOW(), stopped_reason = ${reason}, meter_stop_wh = ${meterStopWh}, current_power_w = 0
        WHERE css_station_id = ${this.config.id} AND transaction_id = ${txId}
      `;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.config.stationId}] Failed to complete transaction: ${msg}`);
    }
  }
}
