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
        // The 1.6 key is the variable name; OCPPCommCtrlr is a 2.1 component
        // that no 1.6 station knows as a configuration key.
        expect(result).toEqual({
          action: 'GetConfiguration',
          payload: { key: ['HeartbeatInterval'] },
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
        // The 1.6 schema rejects additional properties, so evseId must not leak.
        expect(result?.payload).toEqual({ connectorId: 1, duration: 3600 });
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

      it('returns empty object when the single getVariableData entry is null', () => {
        const result = translateCommand('GetVariables', 'ocpp1.6', {
          getVariableData: [null],
        });
        expect(result?.payload).toEqual({});
      });
    });

    describe('1.6 Basic Auth password', () => {
      it('maps SecurityCtrlr.BasicAuthPassword to a hex AuthorizationKey (OCTT TC_073)', () => {
        const result = translateCommand('SetVariables', 'ocpp1.6', {
          setVariableData: [
            {
              component: { name: 'SecurityCtrlr' },
              variable: { name: 'BasicAuthPassword' },
              attributeValue: 'OCA_OCTT_admin_test',
            },
          ],
        });
        expect(result).toEqual({
          action: 'ChangeConfiguration',
          payload: { key: 'AuthorizationKey', value: '4F43415F4F4354545F61646D696E5F74657374' },
        });
      });
    });

    describe('1.6 configuration keys', () => {
      it('uses the variable name when the component name is empty (1.6 templates)', () => {
        const result = translateCommand('SetVariables', 'ocpp1.6', {
          setVariableData: [
            {
              component: { name: '' },
              variable: { name: 'HeartbeatInterval' },
              attributeValue: '300',
            },
          ],
        });
        expect(result?.payload).toEqual({ key: 'HeartbeatInterval', value: '300' });
      });

      it('uses the variable name, not the 2.1 component, for SecurityProfile', () => {
        const result = translateCommand('SetVariables', 'ocpp1.6', {
          setVariableData: [
            {
              component: { name: 'SecurityCtrlr' },
              variable: { name: 'SecurityProfile' },
              attributeValue: '1',
            },
          ],
        });
        expect(result?.payload).toEqual({ key: 'SecurityProfile', value: '1' });
      });

      it('falls back to the component name when the variable name is empty', () => {
        const result = translateCommand('GetVariables', 'ocpp1.6', {
          getVariableData: [{ component: { name: 'LegacyKey' }, variable: { name: '' } }],
        });
        expect(result?.payload).toEqual({ key: ['LegacyKey'] });
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

      it('returns empty object when the single setVariableData entry is null', () => {
        const result = translateCommand('SetVariables', 'ocpp1.6', {
          setVariableData: [null],
        });
        expect(result?.payload).toEqual({});
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
      it('throws for unknown reset type targeting ocpp1.6 (e.g. 2.1 ImmediateAndResume)', () => {
        // OCPP 1.6 Reset.type enum is Hard|Soft only. Letting an unknown value
        // through produces a FormationViolation CALLERROR; the mapper throws
        // so the caller surfaces the mismatch at the CSMS layer.
        expect(() => translateCommand('Reset', 'ocpp1.6', { type: 'ImmediateAndResume' })).toThrow(
          /no OCPP 1.6 equivalent/,
        );
        expect(() => translateCommand('Reset', 'ocpp1.6', { type: 'CustomType' })).toThrow(
          /no OCPP 1.6 equivalent/,
        );
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

    describe('Reset with no type', () => {
      it('throws when type is absent targeting ocpp1.6', () => {
        expect(() => translateCommand('Reset', 'ocpp1.6', {})).toThrow(
          'Reset type "undefined" has no OCPP 1.6 equivalent',
        );
      });
    });

    describe('RequestStopTransaction validation', () => {
      it('throws for a non-numeric transactionId targeting ocpp1.6', () => {
        expect(() =>
          translateCommand('RequestStopTransaction', 'ocpp1.6', { transactionId: 'abc' }),
        ).toThrow('Invalid transactionId for OCPP 1.6 stop: abc');
      });

      it('throws for a zero transactionId targeting ocpp1.6', () => {
        expect(() =>
          translateCommand('RequestStopTransaction', 'ocpp1.6', { transactionId: 0 }),
        ).toThrow('Invalid transactionId for OCPP 1.6 stop: 0');
      });

      it('coerces a numeric-string transactionId to a positive integer for ocpp1.6', () => {
        const result = translateCommand('RequestStopTransaction', 'ocpp1.6', {
          transactionId: '42',
        });
        expect(result).toEqual({
          action: 'RemoteStopTransaction',
          payload: { transactionId: 42 },
        });
      });
    });

    describe('ClearChargingProfile nested 2.1 criteria', () => {
      it('flattens chargingProfileCriteria and maps chargingProfileId to id for ocpp1.6', () => {
        const result = translateCommand('ClearChargingProfile', 'ocpp1.6', {
          chargingProfileId: 7,
          chargingProfileCriteria: {
            evseId: 2,
            chargingProfilePurpose: 'TxDefaultProfile',
            customData: { vendorId: 'x' },
          },
        });
        expect(result?.payload).toEqual({
          chargingProfilePurpose: 'TxDefaultProfile',
          id: 7,
          connectorId: 2,
        });
        expect(result?.payload).not.toHaveProperty('chargingProfileId');
        expect(result?.payload).not.toHaveProperty('evseId');
        expect(result?.payload).not.toHaveProperty('customData');
      });

      it('omits id and connectorId when chargingProfileId and evseId are absent for ocpp1.6', () => {
        const result = translateCommand('ClearChargingProfile', 'ocpp1.6', {
          chargingProfileCriteria: { chargingProfilePurpose: 'ChargingStationMaxProfile' },
        });
        expect(result?.payload).toEqual({ chargingProfilePurpose: 'ChargingStationMaxProfile' });
        expect(result?.payload).not.toHaveProperty('id');
        expect(result?.payload).not.toHaveProperty('connectorId');
      });
    });

    describe('GetVariables multi-variable rejection', () => {
      it('throws when more than one variable targets ocpp1.6', () => {
        expect(() =>
          translateCommand('GetVariables', 'ocpp1.6', {
            getVariableData: [
              { component: { name: 'A' }, variable: { name: 'x' } },
              { component: { name: 'B' }, variable: { name: 'y' } },
            ],
          }),
        ).toThrow('at most one variable per call');
      });
    });

    describe('SetVariables multi-variable rejection', () => {
      it('throws when more than one variable targets ocpp1.6', () => {
        expect(() =>
          translateCommand('SetVariables', 'ocpp1.6', {
            setVariableData: [
              { component: { name: 'A' }, variable: { name: 'x' }, attributeValue: '1' },
              { component: { name: 'B' }, variable: { name: 'y' }, attributeValue: '2' },
            ],
          }),
        ).toThrow('at most one variable per call');
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
