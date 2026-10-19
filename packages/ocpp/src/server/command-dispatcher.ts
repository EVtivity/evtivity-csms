// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from '@evtivity/lib';
import type { ConnectionManager } from './connection-manager.js';
import type { MessageCorrelator, SendCallOptions } from './message-correlator.js';
import { isOcpp21OnlyAction } from '@evtivity/lib';
import { translateCommand, translateResponse } from './command-translation.js';
import { Ocpp201CommandError } from './ocpp201/to-ocpp201.js';

export class CommandDispatcher {
  private readonly connectionManager: ConnectionManager;
  private readonly correlator: MessageCorrelator;
  private readonly logger: Logger;

  constructor(connectionManager: ConnectionManager, correlator: MessageCorrelator, logger: Logger) {
    this.connectionManager = connectionManager;
    this.correlator = correlator;
    this.logger = logger;
  }

  async sendCommand(
    stationId: string,
    action: string,
    payload: Record<string, unknown>,
    options?: SendCallOptions,
  ): Promise<Record<string, unknown>> {
    const connection = this.connectionManager.get(stationId);
    if (connection == null) {
      throw new Error(`Station ${stationId} is not connected`);
    }

    this.logger.info({ stationId, action }, 'Dispatching command to station');

    // A ready-made 2.x payload reaches a 2.0.1 station only through the 2.0.1 check.
    const call =
      connection.session.ocppProtocol === 'ocpp2.0.1'
        ? this.translateOrRefuse(action, connection.session.ocppProtocol, payload)
        : { action, payload };

    const response = await this.correlator.sendCall(
      connection.ws,
      connection.session,
      call.action,
      call.payload,
      options,
    );

    this.logger.info({ stationId, action }, 'Command response received');
    return response;
  }

  async sendVersionAwareCommand(
    stationId: string,
    commandName: string,
    payload: Record<string, unknown>,
    options?: SendCallOptions,
  ): Promise<Record<string, unknown>> {
    const connection = this.connectionManager.get(stationId);
    if (connection == null) {
      throw new Error(`Station ${stationId} is not connected`);
    }

    const version = connection.session.ocppProtocol;
    const translated = this.translateOrRefuse(commandName, version, payload);

    this.logger.info(
      { stationId, commandName, translatedAction: translated.action, version },
      'Dispatching version-aware command',
    );

    const response = await this.correlator.sendCall(
      connection.ws,
      connection.session,
      translated.action,
      translated.payload,
      options,
    );

    return translateResponse(commandName, version, response, payload);
  }

  /**
   * The station's form of a 2.1 command. Throws when the station's version has
   * none: for OCPP 2.0.1, a 2.1-only action, or a payload that fails the 2.0.1
   * mapping or strict schema check (the error names the reason).
   */
  private translateOrRefuse(
    commandName: string,
    version: string,
    payload: Record<string, unknown>,
  ): { action: string; payload: Record<string, unknown> } {
    const translated = translateCommand(commandName, version, payload);
    if (translated == null) {
      if (version === 'ocpp2.0.1') {
        throw new Ocpp201CommandError(
          commandName,
          isOcpp21OnlyAction(commandName)
            ? 'the action is defined in OCPP 2.1 only'
            : 'the action is not defined in OCPP 2.0.1',
        );
      }
      throw new Error(`Command ${commandName} is not supported for ${version}`);
    }

    // The translation layer returns { action: 'NotSupported' } for commands
    // that exist in newer OCPP versions but have no equivalent in this
    // station's version. Dispatching that literal string as an OCPP action
    // makes the station reply with CALLERROR (unknown action), which the API
    // caller sees as an opaque protocol error. Translate it here into a
    // clear, version-aware rejection at the dispatcher.
    if (translated.action === 'NotSupported') {
      throw new Error(`Command ${commandName} is not supported on ${version} stations`);
    }
    return translated;
  }

  async requestStartTransaction(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'RequestStartTransaction', payload);
  }

  async requestStopTransaction(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'RequestStopTransaction', payload);
  }

  async reset(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'Reset', payload);
  }

  async unlockConnector(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'UnlockConnector', payload);
  }

  async changeAvailability(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'ChangeAvailability', payload);
  }

  async triggerMessage(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'TriggerMessage', payload);
  }

  async getVariables(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'GetVariables', payload);
  }

  async setVariables(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'SetVariables', payload);
  }

  async clearCache(stationId: string): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'ClearCache', {});
  }

  async getBaseReport(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'GetBaseReport', payload);
  }

  async cancelReservation(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'CancelReservation', payload);
  }

  async certificateSigned(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'CertificateSigned', payload);
  }

  async clearChargingProfile(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'ClearChargingProfile', payload);
  }

  async clearDisplayMessage(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'ClearDisplayMessage', payload);
  }

  async clearVariableMonitoring(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'ClearVariableMonitoring', payload);
  }

  async costUpdated(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'CostUpdated', payload);
  }

  async customerInformation(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'CustomerInformation', payload);
  }

  async deleteCertificate(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'DeleteCertificate', payload);
  }

  async getChargingProfiles(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'GetChargingProfiles', payload);
  }

  async getCompositeSchedule(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'GetCompositeSchedule', payload);
  }

  async getDisplayMessages(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'GetDisplayMessages', payload);
  }

  async getInstalledCertificateIds(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'GetInstalledCertificateIds', payload);
  }

  async getLocalListVersion(stationId: string): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'GetLocalListVersion', {});
  }

  async getLog(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'GetLog', payload);
  }

  async getMonitoringReport(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'GetMonitoringReport', payload);
  }

  async getReport(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'GetReport', payload);
  }

  async installCertificate(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'InstallCertificate', payload);
  }

  async publishFirmware(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'PublishFirmware', payload);
  }

  async reserveNow(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'ReserveNow', payload);
  }

  async sendLocalList(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'SendLocalList', payload);
  }

  async setChargingProfile(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'SetChargingProfile', payload);
  }

  async setDisplayMessage(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'SetDisplayMessage', payload);
  }

  async setMonitoringBase(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'SetMonitoringBase', payload);
  }

  async setMonitoringLevel(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'SetMonitoringLevel', payload);
  }

  async setNetworkProfile(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'SetNetworkProfile', payload);
  }

  async setVariableMonitoring(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'SetVariableMonitoring', payload);
  }

  async unpublishFirmware(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'UnpublishFirmware', payload);
  }

  async updateDynamicSchedule(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'UpdateDynamicSchedule', payload);
  }

  async updateFirmware(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'UpdateFirmware', payload);
  }

  async usePriorityCharging(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'UsePriorityCharging', payload);
  }

  async adjustPeriodicEventStream(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'AdjustPeriodicEventStream', payload);
  }

  async closePeriodicEventStream(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'ClosePeriodicEventStream', payload);
  }

  async openPeriodicEventStream(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'OpenPeriodicEventStream', payload);
  }

  async setDefaultTariff(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'SetDefaultTariff', payload);
  }

  async getTariffs(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'GetTariffs', payload);
  }

  async clearTariffs(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'ClearTariffs', payload);
  }

  async changeTransactionTariff(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'ChangeTransactionTariff', payload);
  }

  async afrrSignal(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'AFRRSignal', payload);
  }

  async clearDERControl(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'ClearDERControl', payload);
  }

  async getDERControl(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'GetDERControl', payload);
  }

  async setDERControl(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'SetDERControl', payload);
  }

  async requestBatterySwap(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'RequestBatterySwap', payload);
  }

  async getPeriodicEventStream(
    stationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.sendVersionAwareCommand(stationId, 'GetPeriodicEventStream', payload);
  }
}
