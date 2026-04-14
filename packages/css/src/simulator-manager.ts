// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type postgres from 'postgres';
import { StationSimulator, type StationConfig } from './station-simulator.js';
import { ClockAlignedScheduler } from './clock-aligned-scheduler.js';

interface CssCommand {
  commandId?: string;
  stationId: string;
  action: string;
  params: Record<string, unknown>;
}

export class SimulatorManager {
  readonly simulators = new Map<string, StationSimulator>();
  private readonly clockAlignedScheduler: ClockAlignedScheduler;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;
  private readonly sql: postgres.Sql;
  private readonly skippedTlsUrls = new Set<string>();

  constructor(sql: postgres.Sql) {
    this.sql = sql;
    this.clockAlignedScheduler = new ClockAlignedScheduler();
  }

  async start(): Promise<void> {
    await this.syncStations();
    this.pollTimer = setInterval(() => {
      this.syncStations().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[simulator-manager] syncStations error: ${msg}`);
      });
    }, 5000);
    this.clockAlignedScheduler.start();
  }

  async stop(): Promise<void> {
    if (this.pollTimer != null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.clockAlignedScheduler.stop();
    for (const sim of this.simulators.values()) {
      await sim.stop();
    }
    this.simulators.clear();
  }

  get simulatorCount(): number {
    return this.simulators.size;
  }

  async handleCommand(raw: string): Promise<void> {
    let cmd: CssCommand;
    try {
      cmd = JSON.parse(raw) as CssCommand;
    } catch {
      console.log('[simulator-manager] Failed to parse command JSON');
      return;
    }

    const sim = this.simulators.get(cmd.stationId);
    if (!sim) {
      console.log(`[simulator-manager] No simulator found for station: ${cmd.stationId}`);
      return;
    }

    await this.dispatchAction(sim, cmd.action, cmd.params);
  }

  private async syncStations(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      await this.syncStationsInner();
    } finally {
      this.syncing = false;
    }
  }

  private async syncStationsInner(): Promise<void> {
    const rows = await this.sql`
      SELECT
        s.id,
        s.station_id,
        s.ocpp_protocol,
        s.security_profile,
        s.target_url,
        s.password,
        s.vendor_name,
        s.model,
        s.serial_number,
        s.firmware_version,
        s.client_cert,
        s.client_key,
        s.ca_cert
      FROM css_stations s
      WHERE s.enabled = true
    `;

    const evseRows = await this.sql`
      SELECT
        e.css_station_id,
        e.evse_id,
        e.connector_id,
        e.connector_type,
        e.max_power_w,
        e.phases,
        e.voltage
      FROM css_evses e
      INNER JOIN css_stations s ON s.id = e.css_station_id
      WHERE s.enabled = true
      ORDER BY e.evse_id, e.connector_id
    `;

    // Build a map of evses grouped by station PK
    const evsesByStation = new Map<
      string,
      Array<{
        evseId: number;
        connectorId: number;
        connectorType: 'ac_type2' | 'ac_type1' | 'dc_ccs2' | 'dc_ccs1' | 'dc_chademo';
        maxPowerW: number;
        phases: number;
        voltage: number;
      }>
    >();

    for (const e of evseRows) {
      const stationPk = e.css_station_id as string;
      let list = evsesByStation.get(stationPk);
      if (!list) {
        list = [];
        evsesByStation.set(stationPk, list);
      }
      list.push({
        evseId: e.evse_id as number,
        connectorId: e.connector_id as number,
        connectorType: e.connector_type as
          | 'ac_type2'
          | 'ac_type1'
          | 'dc_ccs2'
          | 'dc_ccs1'
          | 'dc_chademo',
        maxPowerW: e.max_power_w as number,
        phases: e.phases as number,
        voltage: e.voltage as number,
      });
    }

    // Track which station IDs are currently in the DB
    const currentStationIds = new Set<string>();

    for (const row of rows) {
      const stationId = row.station_id as string;
      currentStationIds.add(stationId);

      // Skip if already running
      if (this.simulators.has(stationId)) continue;

      const targetUrl = row.target_url as string;

      // Skip TLS stations when the TLS server is not reachable
      if (targetUrl.startsWith('wss://')) {
        if (this.skippedTlsUrls.has(targetUrl)) continue;
        const reachable = await this.isTlsReachable(targetUrl);
        if (!reachable) {
          this.skippedTlsUrls.add(targetUrl);
          console.log(
            `[simulator-manager] TLS server ${targetUrl} not reachable, skipping ${stationId} and all TLS stations`,
          );
          continue;
        }
      }

      const stationPk = row.id as string;
      const passwordVal = row.password as string | null;
      const clientCertVal = row.client_cert as string | null;
      const clientKeyVal = row.client_key as string | null;
      const caCertVal = row.ca_cert as string | null;
      const config: StationConfig = {
        id: stationPk,
        stationId,
        ocppProtocol: row.ocpp_protocol as 'ocpp1.6' | 'ocpp2.1',
        securityProfile: row.security_profile as number,
        targetUrl: row.target_url as string,
        vendorName: row.vendor_name as string,
        model: row.model as string,
        serialNumber: (row.serial_number as string | null) ?? `SN-${stationId}`,
        firmwareVersion: (row.firmware_version as string | null) ?? '1.0.0',
        evses: evsesByStation.get(stationPk) ?? [],
        ...(passwordVal != null ? { password: passwordVal } : {}),
        ...(clientCertVal != null ? { clientCert: clientCertVal } : {}),
        ...(clientKeyVal != null ? { clientKey: clientKeyVal } : {}),
        ...(caCertVal != null ? { caCert: caCertVal } : {}),
      };

      try {
        const sim = new StationSimulator(config, this.sql);
        // Add to map BEFORE start() to prevent duplicate creation during async boot
        this.simulators.set(stationId, sim);
        await sim.start();
        this.clockAlignedScheduler.register(sim);
        console.log(`[simulator-manager] Started simulator: ${stationId}`);
      } catch (err: unknown) {
        // Remove from map on failure so it can be retried next sync
        this.simulators.delete(stationId);
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[simulator-manager] Failed to start simulator ${stationId}: ${msg}`);
      }
    }

    // Stop simulators for stations no longer in DB or disabled
    for (const [stationId, sim] of this.simulators) {
      if (!currentStationIds.has(stationId)) {
        try {
          await sim.stop();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`[simulator-manager] Error stopping simulator ${stationId}: ${msg}`);
        }
        this.clockAlignedScheduler.unregister(stationId);
        this.simulators.delete(stationId);
        console.log(`[simulator-manager] Stopped simulator: ${stationId}`);
      }
    }
  }

  private async isTlsReachable(url: string): Promise<boolean> {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname;
      const port = Number(parsed.port) || 443;
      return await new Promise<boolean>((resolve) => {
        const socket: TLSSocket = tlsConnect(
          { host, port, rejectUnauthorized: false, timeout: 3000 },
          () => {
            socket.destroy();
            resolve(true);
          },
        );
        socket.on('error', () => {
          socket.destroy();
          resolve(false);
        });
        socket.on('timeout', () => {
          socket.destroy();
          resolve(false);
        });
      });
    } catch {
      return false;
    }
  }

  private async dispatchAction(
    sim: StationSimulator,
    action: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      switch (action) {
        case 'plugIn':
          await sim.plugIn(params.evseId as number);
          break;
        case 'authorize':
          await sim.authorize(
            params.evseId as number,
            params.idToken as string,
            params.tokenType as string,
          );
          break;
        case 'startCharging':
          await sim.startCharging(
            params.evseId as number,
            params.idToken as string,
            params.tokenType as string,
          );
          break;
        case 'stopCharging':
          await sim.stopCharging(params.evseId as number, params.reason as string);
          break;
        case 'unplug':
          await sim.unplug(params.evseId as number);
          break;
        case 'injectFault':
          await sim.injectFault(params.evseId as number, params.errorCode as string);
          break;
        case 'clearFault':
          await sim.clearFault(params.evseId as number);
          break;
        case 'goOffline':
          await sim.goOffline();
          break;
        case 'comeOnline':
          await sim.comeOnline();
          break;
        case 'sendBootNotification':
          await sim.sendBootNotification(params.reason as string);
          break;
        case 'sendHeartbeat':
          await sim.sendHeartbeat();
          break;
        case 'sendStatusNotification':
          await sim.sendStatusNotification(
            params.evseId as number,
            params.connectorId as number,
            params.status as string,
            params.errorCode as string | undefined,
          );
          break;
        case 'sendMeterValues':
          await sim.sendMeterValues(
            params.evseId as number,
            params.sampledValues as Array<Record<string, unknown>> | undefined,
            params.transactionId as string | undefined,
          );
          break;
        case 'sendFirmwareStatusNotification':
          await sim.sendFirmwareStatusNotification(
            params.status as string,
            params.requestId as number | undefined,
          );
          break;
        case 'sendDataTransfer':
          await sim.sendDataTransfer(
            params.vendorId as string,
            params.messageId as string,
            params.data as string,
          );
          break;
        // OCPP 2.1 only actions
        case 'sendTransactionEvent': {
          const txOpts: Record<string, unknown> = {
            triggerReason: params.triggerReason as string,
            transactionId: params.transactionId as string,
          };
          if (params.chargingState != null) txOpts['chargingState'] = params.chargingState;
          if (params.stoppedReason != null) txOpts['stoppedReason'] = params.stoppedReason;
          if (params.idToken != null) txOpts['idToken'] = params.idToken;
          if (params.tokenType != null) txOpts['tokenType'] = params.tokenType;
          if (params.seqNo != null) txOpts['seqNo'] = params.seqNo;
          if (params.meterValue != null) txOpts['meterValue'] = params.meterValue;
          await sim.sendTransactionEvent(
            params.evseId as number,
            params.eventType as 'Started' | 'Updated' | 'Ended',
            txOpts as { triggerReason: string; transactionId: string },
          );
          break;
        }
        case 'sendLogStatusNotification':
          await sim.sendLogStatusNotification(
            params.status as string,
            params.requestId as number | undefined,
          );
          break;
        case 'sendSecurityEventNotification':
          await sim.sendSecurityEventNotification(
            params.type as string,
            params.timestamp as string,
            params.techInfo as string | undefined,
          );
          break;
        case 'sendNotifyEvent':
          await sim.sendNotifyEvent(
            params.eventData as Record<string, unknown>[],
            params.seqNo as number | undefined,
            params.tbc as boolean | undefined,
          );
          break;
        case 'sendNotifyReport':
          await sim.sendNotifyReport(params.requestId as number);
          break;
        case 'sendNotifyMonitoringReport':
          await sim.sendNotifyMonitoringReport(
            params.requestId as number,
            params.monitor as Array<Record<string, unknown>>,
          );
          break;
        case 'sendNotifyChargingLimit':
          await sim.sendNotifyChargingLimit(
            params.chargingLimit as Record<string, unknown>,
            params.chargingSchedule as Array<Record<string, unknown>> | undefined,
          );
          break;
        case 'sendNotifyEVChargingNeeds':
          await sim.sendNotifyEVChargingNeeds(
            params.evseId as number,
            params.chargingNeeds as Record<string, unknown>,
          );
          break;
        case 'sendClearedChargingLimit':
          await sim.sendClearedChargingLimit(
            params.chargingLimitSource as string,
            params.evseId as number | undefined,
          );
          break;
        case 'sendReservationStatusUpdate':
          await sim.sendReservationStatusUpdate(
            params.reservationId as number,
            params.reservationUpdateStatus as string,
          );
          break;
        case 'sendNotifyDisplayMessages':
          await sim.sendNotifyDisplayMessages(
            params.requestId as number,
            params.messageInfo as Array<Record<string, unknown>>,
          );
          break;
        case 'sendNotifyCustomerInformation':
          await sim.sendNotifyCustomerInformation(
            params.requestId as number,
            params.data as string,
          );
          break;
        case 'sendSignCertificate':
          await sim.sendSignCertificate(
            params.csr as string,
            params.certificateType as string | undefined,
          );
          break;
        case 'sendGetCertificateStatus':
          await sim.sendGetCertificateStatus(params.ocspRequestData as Record<string, unknown>);
          break;
        case 'sendGetTransactionStatus':
          await sim.sendGetTransactionStatus(params.transactionId as string | undefined);
          break;
        case 'sendReportChargingProfiles':
          await sim.sendReportChargingProfiles(
            params.requestId as number,
            params.chargingProfile as Array<Record<string, unknown>>,
            params.evseId as number,
            params.chargingLimitSource as string | undefined,
          );
          break;
        case 'sendNotifyEVChargingSchedule':
          await sim.sendNotifyEVChargingSchedule(
            params.timeBase as string,
            params.evseId as number,
            params.chargingSchedule as Record<string, unknown>,
          );
          break;
        case 'sendNotifySettlement':
          await sim.sendNotifySettlement(params);
          break;
        case 'sendNotifyPriorityCharging':
          await sim.sendNotifyPriorityCharging(
            params.transactionId as string,
            params.activated as boolean,
          );
          break;
        case 'sendNotifyQRCodeScanned':
          await sim.sendNotifyQRCodeScanned(params.evseId as number, params.timeout as number);
          break;
        case 'sendNotifyAllowedEnergyTransfer':
          await sim.sendNotifyAllowedEnergyTransfer(
            params.allowedEnergyTransfer as string[],
            params.transactionId as string | undefined,
          );
          break;
        case 'sendGet15118EVCertificate':
          await sim.sendGet15118EVCertificate(
            params.iso15118SchemaVersion as string,
            params.action as string,
            params.exiRequest as string,
          );
          break;
        case 'sendGetCertificateChainStatus':
          await sim.sendGetCertificateChainStatus(params);
          break;
        case 'sendPublishFirmwareStatusNotification':
          await sim.sendPublishFirmwareStatusNotification(
            params.status as string,
            params.requestId as number | undefined,
          );
          break;
        case 'sendNotifyWebPaymentStarted':
          await sim.sendNotifyWebPaymentStarted(params.evseId as number, params.timeout as number);
          break;
        case 'sendNotifyPeriodicEventStream':
          await sim.sendNotifyPeriodicEventStream(params);
          break;
        case 'sendNotifyDERAlarm':
          await sim.sendNotifyDERAlarm(params);
          break;
        case 'sendNotifyDERStartStop':
          await sim.sendNotifyDERStartStop(params);
          break;
        case 'sendReportDERControl':
          await sim.sendReportDERControl(params);
          break;
        case 'sendBatterySwap':
          await sim.sendBatterySwap(params);
          break;
        case 'sendPullDynamicScheduleUpdate':
          await sim.sendPullDynamicScheduleUpdate(params.chargingProfileId as number);
          break;
        case 'sendVatNumberValidation':
          await sim.sendVatNumberValidation(
            params.vatNumber as string,
            params.evseId as number | undefined,
          );
          break;
        // OCPP 1.6 only
        case 'sendStartTransaction':
          await sim.sendStartTransaction(params.connectorId as number, params.idTag as string);
          break;
        case 'sendStopTransaction':
          await sim.sendStopTransaction(
            params.transactionId as number,
            params.meterStop as number,
            params.reason as string | undefined,
          );
          break;
        case 'sendDiagnosticsStatusNotification':
          await sim.sendDiagnosticsStatusNotification(params.status as string);
          break;
        case 'sendAuthorize':
          await sim.sendAuthorize(params.idToken as string, params.tokenType as string);
          break;
        default:
          console.log(`[simulator-manager] Unknown action: ${action}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[simulator-manager] Error dispatching ${action} to ${sim.stationId}: ${msg}`);
    }
  }
}
