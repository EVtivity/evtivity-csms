// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { CommandDispatcher } from '../server/command-dispatcher.js';

vi.mock('../server/command-translation.js', () => ({
  translateCommand: vi.fn(
    (commandName: string, _version: string, payload: Record<string, unknown>) => ({
      action: commandName,
      payload,
    }),
  ),
  translateResponse: vi.fn(
    (_commandName: string, _version: string, response: Record<string, unknown>) => response,
  ),
}));

const logger = pino({ level: 'silent' });

function makeConnection(protocol = 'ocpp2.1') {
  return {
    ws: {} as unknown,
    session: {
      stationId: 'CS-001',
      stationDbId: null,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      authenticated: true,
      pendingMessages: new Map(),
      ocppProtocol: protocol,
    },
  };
}

describe('CommandDispatcher', () => {
  let connectionManager: { get: ReturnType<typeof vi.fn> };
  let correlator: { sendCall: ReturnType<typeof vi.fn> };
  let dispatcher: CommandDispatcher;

  beforeEach(() => {
    connectionManager = { get: vi.fn() };
    correlator = { sendCall: vi.fn().mockResolvedValue({ status: 'Accepted' }) };
    dispatcher = new CommandDispatcher(connectionManager as never, correlator as never, logger);
  });

  describe('sendCommand', () => {
    it('sends command to connected station', async () => {
      const conn = makeConnection();
      connectionManager.get.mockReturnValue(conn);

      const response = await dispatcher.sendCommand('CS-001', 'Reset', { type: 'Soft' });

      expect(response).toEqual({ status: 'Accepted' });
      expect(correlator.sendCall).toHaveBeenCalledWith(conn.ws, conn.session, 'Reset', {
        type: 'Soft',
      });
    });

    it('throws when station is not connected', async () => {
      connectionManager.get.mockReturnValue(null);

      await expect(dispatcher.sendCommand('CS-UNKNOWN', 'Reset', {})).rejects.toThrow(
        'Station CS-UNKNOWN is not connected',
      );
    });
  });

  describe('sendVersionAwareCommand', () => {
    it('translates and sends command', async () => {
      const conn = makeConnection();
      connectionManager.get.mockReturnValue(conn);

      const response = await dispatcher.sendVersionAwareCommand('CS-001', 'Reset', {
        type: 'Soft',
      });

      expect(response).toEqual({ status: 'Accepted' });
    });

    it('throws when station is not connected', async () => {
      connectionManager.get.mockReturnValue(null);

      await expect(dispatcher.sendVersionAwareCommand('CS-UNKNOWN', 'Reset', {})).rejects.toThrow(
        'Station CS-UNKNOWN is not connected',
      );
    });

    it('throws when command is not supported for version', async () => {
      const conn = makeConnection();
      connectionManager.get.mockReturnValue(conn);

      const { translateCommand } = await import('../server/command-translation.js');
      vi.mocked(translateCommand).mockReturnValueOnce(null as never);

      await expect(
        dispatcher.sendVersionAwareCommand('CS-001', 'UnsupportedCommand', {}),
      ).rejects.toThrow('not supported');
    });
  });

  describe('convenience methods', () => {
    beforeEach(() => {
      connectionManager.get.mockReturnValue(makeConnection());
    });

    it('requestStartTransaction delegates to sendVersionAwareCommand', async () => {
      const response = await dispatcher.requestStartTransaction('CS-001', { evseId: 1 });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('requestStopTransaction delegates', async () => {
      const response = await dispatcher.requestStopTransaction('CS-001', { transactionId: 'tx-1' });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('reset delegates', async () => {
      const response = await dispatcher.reset('CS-001', { type: 'Soft' });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('unlockConnector delegates', async () => {
      const response = await dispatcher.unlockConnector('CS-001', { evseId: 1, connectorId: 1 });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('changeAvailability delegates', async () => {
      const response = await dispatcher.changeAvailability('CS-001', {
        operationalStatus: 'Operative',
      });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('triggerMessage delegates', async () => {
      const response = await dispatcher.triggerMessage('CS-001', {
        requestedMessage: 'BootNotification',
      });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('getVariables delegates', async () => {
      const response = await dispatcher.getVariables('CS-001', { getVariableData: [] });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('setVariables delegates', async () => {
      const response = await dispatcher.setVariables('CS-001', { setVariableData: [] });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('clearCache delegates', async () => {
      const response = await dispatcher.clearCache('CS-001');
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('getBaseReport delegates', async () => {
      const response = await dispatcher.getBaseReport('CS-001', {
        requestId: 1,
        reportBase: 'FullInventory',
      });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('cancelReservation delegates', async () => {
      const response = await dispatcher.cancelReservation('CS-001', { reservationId: 1 });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('certificateSigned delegates', async () => {
      const response = await dispatcher.certificateSigned('CS-001', { certificateChain: 'cert' });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('clearChargingProfile delegates', async () => {
      const response = await dispatcher.clearChargingProfile('CS-001', {});
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('clearDisplayMessage delegates', async () => {
      const response = await dispatcher.clearDisplayMessage('CS-001', { id: 1 });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('clearVariableMonitoring delegates', async () => {
      const response = await dispatcher.clearVariableMonitoring('CS-001', { id: [1] });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('costUpdated delegates', async () => {
      const response = await dispatcher.costUpdated('CS-001', {
        totalCost: 10.5,
        transactionId: 'tx-1',
      });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('customerInformation delegates', async () => {
      const response = await dispatcher.customerInformation('CS-001', {
        requestId: 1,
        report: true,
        clear: false,
      });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('deleteCertificate delegates', async () => {
      const response = await dispatcher.deleteCertificate('CS-001', {
        certificateHashData: {},
      });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('getChargingProfiles delegates', async () => {
      const response = await dispatcher.getChargingProfiles('CS-001', {
        requestId: 1,
        chargingProfile: {},
      });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('getCompositeSchedule delegates', async () => {
      const response = await dispatcher.getCompositeSchedule('CS-001', {
        duration: 3600,
        evseId: 1,
      });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('getDisplayMessages delegates', async () => {
      const response = await dispatcher.getDisplayMessages('CS-001', { requestId: 1 });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('getInstalledCertificateIds delegates', async () => {
      const response = await dispatcher.getInstalledCertificateIds('CS-001', {});
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('getLocalListVersion delegates', async () => {
      const response = await dispatcher.getLocalListVersion('CS-001');
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('getLog delegates', async () => {
      const response = await dispatcher.getLog('CS-001', {
        logType: 'DiagnosticsLog',
        requestId: 1,
        log: {},
      });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('getMonitoringReport delegates', async () => {
      const response = await dispatcher.getMonitoringReport('CS-001', { requestId: 1 });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('getReport delegates', async () => {
      const response = await dispatcher.getReport('CS-001', { requestId: 1 });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('installCertificate delegates', async () => {
      const response = await dispatcher.installCertificate('CS-001', {
        certificateType: 'V2GRootCertificate',
        certificate: 'cert',
      });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('publishFirmware delegates', async () => {
      const response = await dispatcher.publishFirmware('CS-001', {
        location: 'http://example.com/fw',
        checksum: 'abc',
        requestId: 1,
      });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('reserveNow delegates', async () => {
      const response = await dispatcher.reserveNow('CS-001', {
        id: 1,
        expiryDateTime: '2026-01-01T00:00:00Z',
        idToken: { idToken: 'tok', type: 'ISO14443' },
      });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('sendLocalList delegates', async () => {
      const response = await dispatcher.sendLocalList('CS-001', {
        versionNumber: 1,
        updateType: 'Full',
      });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('setChargingProfile delegates', async () => {
      const response = await dispatcher.setChargingProfile('CS-001', {
        evseId: 1,
        chargingProfile: {},
      });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('setDisplayMessage delegates', async () => {
      const response = await dispatcher.setDisplayMessage('CS-001', { message: {} });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('setMonitoringBase delegates', async () => {
      const response = await dispatcher.setMonitoringBase('CS-001', { monitoringBase: 'All' });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('setMonitoringLevel delegates', async () => {
      const response = await dispatcher.setMonitoringLevel('CS-001', { severity: 0 });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('setNetworkProfile delegates', async () => {
      const response = await dispatcher.setNetworkProfile('CS-001', {
        configurationSlot: 1,
        connectionData: {},
      });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('setVariableMonitoring delegates', async () => {
      const response = await dispatcher.setVariableMonitoring('CS-001', {
        setMonitoringData: [],
      });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('unpublishFirmware delegates', async () => {
      const response = await dispatcher.unpublishFirmware('CS-001', { checksum: 'abc' });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('updateDynamicSchedule delegates', async () => {
      const response = await dispatcher.updateDynamicSchedule('CS-001', {
        chargingProfileId: 1,
      });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('updateFirmware delegates', async () => {
      const response = await dispatcher.updateFirmware('CS-001', {
        requestId: 1,
        firmware: { location: 'http://example.com/fw', retrieveDateTime: '2026-01-01T00:00:00Z' },
      });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('usePriorityCharging delegates', async () => {
      const response = await dispatcher.usePriorityCharging('CS-001', {
        transactionId: 'tx-1',
        activate: true,
      });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('adjustPeriodicEventStream delegates', async () => {
      const response = await dispatcher.adjustPeriodicEventStream('CS-001', { id: 1 });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('closePeriodicEventStream delegates', async () => {
      const response = await dispatcher.closePeriodicEventStream('CS-001', { id: 1 });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('openPeriodicEventStream delegates', async () => {
      const response = await dispatcher.openPeriodicEventStream('CS-001', {});
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('setDefaultTariff delegates', async () => {
      const response = await dispatcher.setDefaultTariff('CS-001', { tariff: {} });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('getTariffs delegates', async () => {
      const response = await dispatcher.getTariffs('CS-001', {});
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('clearTariffs delegates', async () => {
      const response = await dispatcher.clearTariffs('CS-001', {});
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('changeTransactionTariff delegates', async () => {
      const response = await dispatcher.changeTransactionTariff('CS-001', {
        transactionId: 'tx-1',
        tariff: {},
      });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('afrrSignal delegates', async () => {
      const response = await dispatcher.afrrSignal('CS-001', { signal: 10, timestamp: '' });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('clearDERControl delegates', async () => {
      const response = await dispatcher.clearDERControl('CS-001', { isDefault: true });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('getDERControl delegates', async () => {
      const response = await dispatcher.getDERControl('CS-001', { requestId: 1, isDefault: true });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('setDERControl delegates', async () => {
      const response = await dispatcher.setDERControl('CS-001', { isDefault: true });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('requestBatterySwap delegates', async () => {
      const response = await dispatcher.requestBatterySwap('CS-001', {
        idToken: { idToken: 'tok', type: 'ISO14443' },
      });
      expect(response).toEqual({ status: 'Accepted' });
    });

    it('getPeriodicEventStream delegates', async () => {
      const response = await dispatcher.getPeriodicEventStream('CS-001', { requestId: 1 });
      expect(response).toEqual({ status: 'Accepted' });
    });
  });
});
