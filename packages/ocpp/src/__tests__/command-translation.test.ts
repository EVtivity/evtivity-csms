// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { translateCommand, translateResponse } from '../server/command-translation.js';

describe('command-translation', () => {
  describe('translateCommand', () => {
    describe('Reset', () => {
      it('maps Immediate to Hard for ocpp1.6', () => {
        const result = translateCommand('Reset', 'ocpp1.6', { type: 'Immediate' });
        expect(result).toEqual({ action: 'Reset', payload: { type: 'Hard' } });
      });

      it('maps OnIdle to Soft for ocpp1.6', () => {
        const result = translateCommand('Reset', 'ocpp1.6', { type: 'OnIdle' });
        expect(result).toEqual({ action: 'Reset', payload: { type: 'Soft' } });
      });

      it('passes type through unchanged for ocpp2.1', () => {
        const result = translateCommand('Reset', 'ocpp2.1', { type: 'Immediate' });
        expect(result).toEqual({ action: 'Reset', payload: { type: 'Immediate' } });
      });
    });

    describe('RequestStartTransaction', () => {
      it('maps to RemoteStartTransaction with idTag for ocpp1.6', () => {
        const result = translateCommand('RequestStartTransaction', 'ocpp1.6', {
          idToken: { idToken: 'TAG001', type: 'ISO14443' },
        });
        expect(result).toEqual({
          action: 'RemoteStartTransaction',
          payload: { connectorId: 1, idTag: 'TAG001' },
        });
      });
    });

    describe('RequestStopTransaction', () => {
      it('maps to RemoteStopTransaction with transactionId for ocpp1.6', () => {
        const result = translateCommand('RequestStopTransaction', 'ocpp1.6', {
          transactionId: 12345,
        });
        expect(result).toEqual({
          action: 'RemoteStopTransaction',
          payload: { transactionId: 12345 },
        });
      });
    });

    describe('unsupported commands', () => {
      it('returns null for a 2.1-only command on ocpp1.6', () => {
        const result = translateCommand('SetDisplayMessage', 'ocpp1.6', {});
        expect(result).toBeNull();
      });
    });

    describe('unknown commands', () => {
      it('passes through for ocpp2.1', () => {
        const result = translateCommand('SomeUnknownCommand', 'ocpp2.1', { foo: 1 });
        expect(result).toEqual({ action: 'SomeUnknownCommand', payload: { foo: 1 } });
      });

      it('returns null for ocpp1.6', () => {
        const result = translateCommand('SomeUnknownCommand', 'ocpp1.6', {});
        expect(result).toBeNull();
      });
    });

    describe('GetVariables', () => {
      it('maps to GetConfiguration with key array for ocpp1.6', () => {
        const result = translateCommand('GetVariables', 'ocpp1.6', {
          getVariableData: [
            {
              component: { name: 'OCPPCommCtrlr' },
              variable: { name: 'HeartbeatInterval' },
            },
          ],
        });
        expect(result).toEqual({
          action: 'GetConfiguration',
          payload: { key: ['OCPPCommCtrlr'] },
        });
      });
    });

    describe('SetVariables', () => {
      it('maps to ChangeConfiguration with key/value for ocpp1.6', () => {
        const result = translateCommand('SetVariables', 'ocpp1.6', {
          setVariableData: [
            {
              component: { name: 'HeartbeatInterval' },
              variable: { name: 'HeartbeatInterval' },
              attributeValue: '30',
            },
          ],
        });
        expect(result).toEqual({
          action: 'ChangeConfiguration',
          payload: { key: 'HeartbeatInterval', value: '30' },
        });
      });
    });

    describe('ChangeAvailability', () => {
      it('maps evse.connectorId and operationalStatus for ocpp1.6', () => {
        const result = translateCommand('ChangeAvailability', 'ocpp1.6', {
          evse: { connectorId: 2 },
          operationalStatus: 'Operative',
        });
        expect(result).toEqual({
          action: 'ChangeAvailability',
          payload: { connectorId: 2, type: 'Available' },
        });
      });

      it('maps Inoperative to Unavailable for ocpp1.6', () => {
        const result = translateCommand('ChangeAvailability', 'ocpp1.6', {
          evse: { connectorId: 1 },
          operationalStatus: 'Inoperative',
        });
        expect(result).toEqual({
          action: 'ChangeAvailability',
          payload: { connectorId: 1, type: 'Unavailable' },
        });
      });
    });

    describe('UnlockConnector', () => {
      it('extracts connectorId from evse for ocpp1.6', () => {
        const result = translateCommand('UnlockConnector', 'ocpp1.6', {
          evse: { connectorId: 3 },
        });
        expect(result).toEqual({
          action: 'UnlockConnector',
          payload: { connectorId: 3 },
        });
      });

      it('defaults connectorId to 1 when no evse for ocpp1.6', () => {
        const result = translateCommand('UnlockConnector', 'ocpp1.6', {});
        expect(result).toEqual({
          action: 'UnlockConnector',
          payload: { connectorId: 1 },
        });
      });

      it('uses connectorId directly when no evse for ocpp1.6', () => {
        const result = translateCommand('UnlockConnector', 'ocpp1.6', { connectorId: 5 });
        expect(result).toEqual({
          action: 'UnlockConnector',
          payload: { connectorId: 5 },
        });
      });
    });

    describe('SetChargingProfile', () => {
      it('maps evseId to connectorId for ocpp1.6', () => {
        const result = translateCommand('SetChargingProfile', 'ocpp1.6', {
          evseId: 2,
          chargingProfile: { id: 1 },
        });
        expect(result?.payload).toHaveProperty('connectorId', 2);
        expect(result?.payload).not.toHaveProperty('evseId');
      });
    });

    describe('ClearChargingProfile', () => {
      it('maps evseId to connectorId for ocpp1.6', () => {
        const result = translateCommand('ClearChargingProfile', 'ocpp1.6', {
          evseId: 3,
        });
        expect(result?.payload).toHaveProperty('connectorId', 3);
        expect(result?.payload).not.toHaveProperty('evseId');
      });
    });

    describe('GetCompositeSchedule', () => {
      it('maps evseId to connectorId for ocpp1.6', () => {
        const result = translateCommand('GetCompositeSchedule', 'ocpp1.6', {
          evseId: 1,
          duration: 3600,
        });
        expect(result?.payload).toHaveProperty('connectorId', 1);
        expect(result?.payload).toHaveProperty('evseId', 1);
      });
    });

    describe('ReserveNow', () => {
      it('maps idToken and evseId for ocpp1.6', () => {
        const result = translateCommand('ReserveNow', 'ocpp1.6', {
          idToken: { idToken: 'TAG001' },
          evseId: 2,
          expiryDate: '2026-12-31T00:00:00Z',
          id: 42,
        });
        expect(result).toEqual({
          action: 'ReserveNow',
          payload: {
            connectorId: 2,
            expiryDate: '2026-12-31T00:00:00Z',
            idTag: 'TAG001',
            reservationId: 42,
          },
        });
      });

      it('defaults connectorId to 0 when no evseId for ocpp1.6', () => {
        const result = translateCommand('ReserveNow', 'ocpp1.6', {
          idToken: { idToken: 'TAG001' },
          expiryDate: '2026-12-31T00:00:00Z',
          reservationId: 7,
        });
        expect(result?.payload).toHaveProperty('connectorId', 0);
        expect(result?.payload).toHaveProperty('reservationId', 7);
      });

      it('uses idTag when no idToken for ocpp1.6', () => {
        const result = translateCommand('ReserveNow', 'ocpp1.6', {
          idTag: 'DIRECT-TAG',
          expiryDate: '2026-12-31T00:00:00Z',
          id: 1,
        });
        expect(result?.payload).toHaveProperty('idTag', 'DIRECT-TAG');
      });
    });

    describe('SendLocalList', () => {
      it('maps idToken in list entries for ocpp1.6', () => {
        const result = translateCommand('SendLocalList', 'ocpp1.6', {
          versionNumber: 1,
          updateType: 'Full',
          localAuthorizationList: [{ idToken: { idToken: 'TAG001' } }, { idTag: 'TAG002' }],
        });
        const list = result?.payload['localAuthorizationList'] as Array<Record<string, unknown>>;
        expect(list[0]).toHaveProperty('idTag', 'TAG001');
        expect(list[1]).toHaveProperty('idTag', 'TAG002');
      });

      it('passes payload through when no list for ocpp1.6', () => {
        const result = translateCommand('SendLocalList', 'ocpp1.6', {
          versionNumber: 1,
          updateType: 'Full',
        });
        expect(result?.payload).toHaveProperty('versionNumber', 1);
      });
    });

    describe('UpdateFirmware', () => {
      it('extracts location and retrieveDate from firmware object for ocpp1.6', () => {
        const result = translateCommand('UpdateFirmware', 'ocpp1.6', {
          firmware: {
            location: 'https://example.com/fw.bin',
            retrieveDateTime: '2026-01-01T00:00:00Z',
          },
          retries: 3,
          retryInterval: 60,
        });
        expect(result).toEqual({
          action: 'UpdateFirmware',
          payload: {
            location: 'https://example.com/fw.bin',
            retrieveDate: '2026-01-01T00:00:00Z',
            retries: 3,
            retryInterval: 60,
          },
        });
      });

      it('falls back to direct location/retrieveDate when no firmware object', () => {
        const result = translateCommand('UpdateFirmware', 'ocpp1.6', {
          location: 'https://example.com/fw.bin',
          retrieveDate: '2026-01-01T00:00:00Z',
        });
        expect(result?.payload).toHaveProperty('location', 'https://example.com/fw.bin');
        expect(result?.payload).toHaveProperty('retrieveDate', '2026-01-01T00:00:00Z');
      });
    });

    describe('GetLog', () => {
      it('extracts log details from log object for ocpp1.6', () => {
        const result = translateCommand('GetLog', 'ocpp1.6', {
          log: {
            remoteLocation: 'https://example.com/logs',
            oldestTimestamp: '2026-01-01T00:00:00Z',
            latestTimestamp: '2026-02-01T00:00:00Z',
          },
          retries: 2,
          retryInterval: 30,
        });
        expect(result).toEqual({
          action: 'GetDiagnostics',
          payload: {
            location: 'https://example.com/logs',
            startTime: '2026-01-01T00:00:00Z',
            stopTime: '2026-02-01T00:00:00Z',
            retries: 2,
            retryInterval: 30,
          },
        });
      });

      it('falls back to direct location when no log object', () => {
        const result = translateCommand('GetLog', 'ocpp1.6', {
          location: 'https://example.com/logs',
        });
        expect(result?.payload).toHaveProperty('location', 'https://example.com/logs');
      });
    });

    describe('GetVariables edge cases', () => {
      it('returns empty object when getVariableData is empty for ocpp1.6', () => {
        const result = translateCommand('GetVariables', 'ocpp1.6', {
          getVariableData: [],
        });
        expect(result?.payload).toEqual({});
      });

      it('uses variable name when no component for ocpp1.6', () => {
        const result = translateCommand('GetVariables', 'ocpp1.6', {
          getVariableData: [{ variable: { name: 'SomeVar' } }],
        });
        expect(result?.payload).toEqual({ key: ['SomeVar'] });
      });
    });

    describe('SetVariables edge cases', () => {
      it('returns empty object when setVariableData is empty for ocpp1.6', () => {
        const result = translateCommand('SetVariables', 'ocpp1.6', {
          setVariableData: [],
        });
        expect(result?.payload).toEqual({});
      });

      it('uses variable name when no component for ocpp1.6', () => {
        const result = translateCommand('SetVariables', 'ocpp1.6', {
          setVariableData: [{ variable: { name: 'SomeVar' }, attributeValue: '42' }],
        });
        expect(result?.payload).toEqual({ key: 'SomeVar', value: '42' });
      });
    });

    describe('ChangeAvailability edge cases', () => {
      it('defaults connectorId to 0 when no evse for ocpp1.6', () => {
        const result = translateCommand('ChangeAvailability', 'ocpp1.6', {
          operationalStatus: 'Operative',
        });
        expect(result?.payload).toHaveProperty('connectorId', 0);
      });

      it('passes unknown operationalStatus through for ocpp1.6', () => {
        const result = translateCommand('ChangeAvailability', 'ocpp1.6', {
          operationalStatus: 'CustomStatus',
        });
        expect(result?.payload).toHaveProperty('type', 'CustomStatus');
      });
    });

    describe('Reset edge cases', () => {
      it('passes unknown reset type through for ocpp1.6', () => {
        const result = translateCommand('Reset', 'ocpp1.6', { type: 'CustomType' });
        expect(result?.payload).toHaveProperty('type', 'CustomType');
      });
    });

    describe('RequestStartTransaction edge cases', () => {
      it('uses evseId when provided for ocpp1.6', () => {
        const result = translateCommand('RequestStartTransaction', 'ocpp1.6', {
          evseId: 3,
          idToken: { idToken: 'TAG001' },
        });
        expect(result?.payload).toHaveProperty('connectorId', 3);
      });

      it('uses connectorId when provided for ocpp1.6', () => {
        const result = translateCommand('RequestStartTransaction', 'ocpp1.6', {
          connectorId: 4,
          idTag: 'TAG002',
        });
        expect(result?.payload).toHaveProperty('connectorId', 4);
        expect(result?.payload).toHaveProperty('idTag', 'TAG002');
      });
    });

    describe('identity translations for ocpp2.1', () => {
      it('TriggerMessage passes through for ocpp2.1', () => {
        const result = translateCommand('TriggerMessage', 'ocpp2.1', {
          requestedMessage: 'BootNotification',
        });
        expect(result?.action).toBe('TriggerMessage');
        expect(result?.payload).toHaveProperty('requestedMessage', 'BootNotification');
      });

      it('ClearCache passes through for both versions', () => {
        const r21 = translateCommand('ClearCache', 'ocpp2.1', {});
        const r16 = translateCommand('ClearCache', 'ocpp1.6', {});
        expect(r21?.action).toBe('ClearCache');
        expect(r16?.action).toBe('ClearCache');
      });

      it('CancelReservation passes through for ocpp1.6', () => {
        const result = translateCommand('CancelReservation', 'ocpp1.6', { reservationId: 1 });
        expect(result?.action).toBe('CancelReservation');
        expect(result?.payload).toHaveProperty('reservationId', 1);
      });

      it('DataTransfer passes through for both versions', () => {
        const r21 = translateCommand('DataTransfer', 'ocpp2.1', { vendorId: 'x' });
        const r16 = translateCommand('DataTransfer', 'ocpp1.6', { vendorId: 'x' });
        expect(r21?.action).toBe('DataTransfer');
        expect(r16?.action).toBe('DataTransfer');
      });

      it('GetLocalListVersion passes through for ocpp1.6', () => {
        const result = translateCommand('GetLocalListVersion', 'ocpp1.6', {});
        expect(result?.action).toBe('GetLocalListVersion');
      });
    });

    describe('unsupported version for known command', () => {
      it('returns null for known command on unknown version', () => {
        const result = translateCommand('Reset', 'ocpp99.9', {});
        expect(result).toBeNull();
      });
    });
  });

  describe('translateResponse', () => {
    it('returns the response unchanged for identity translations', () => {
      const response = { status: 'Accepted' };
      const result = translateResponse('Reset', 'ocpp1.6', response);
      expect(result).toEqual({ status: 'Accepted' });
    });

    it('returns the response unchanged for unknown commands', () => {
      const response = { foo: 'bar' };
      const result = translateResponse('NonExistent', 'ocpp2.1', response);
      expect(result).toEqual({ foo: 'bar' });
    });

    it('returns the response unchanged for unknown version', () => {
      const response = { status: 'OK' };
      const result = translateResponse('Reset', 'ocpp99.9', response);
      expect(result).toEqual({ status: 'OK' });
    });
  });
});
