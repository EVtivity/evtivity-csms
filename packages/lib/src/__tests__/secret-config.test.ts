// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  holdsStationCredential,
  isCredentialName,
  isSecretConfigEntry,
  maskStationCredentials,
} from '../secret-config.js';

const PASSWORD = 'SeedStationPass1234';
const HEX = '5365656453746174696F6E50617373';

describe('station credential masking (OCPP message log)', () => {
  it('names credentials by the shared rule, and nothing else', () => {
    for (const name of [
      'BasicAuthPassword',
      'basicAuthPassword',
      'AuthorizationKey',
      'smtp.passwordEnc',
      'client_secret',
      'apiKey',
    ]) {
      expect(isCredentialName(name), name).toBe(true);
    }
    for (const name of [
      'LocalPreAuthorization',
      'DisableRemoteAuthorization',
      'AuthorizationCacheEnabled',
      'issuerKeyHash',
      'idToken',
      'HeartbeatInterval',
      'Basalt',
      'hasPassword',
      'My Password',
      42,
    ]) {
      expect(isCredentialName(name), String(name)).toBe(false);
    }
    expect(isSecretConfigEntry({ variable: { name: 'BasicAuthPassword' } })).toBe(true);
  });

  it('2.1 SetVariables request: masks BasicAuthPassword, keeps other variables', () => {
    const payload = {
      setVariableData: [
        {
          component: { name: 'SecurityCtrlr' },
          variable: { name: 'BasicAuthPassword' },
          attributeValue: PASSWORD,
        },
        {
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'HeartbeatInterval' },
          attributeValue: '300',
        },
      ],
    };
    const masked = maskStationCredentials(payload);
    expect(masked.setVariableData[0]?.attributeValue).toBe(REDACTED);
    expect(masked.setVariableData[0]?.variable.name).toBe('BasicAuthPassword');
    expect(masked.setVariableData[1]?.attributeValue).toBe('300');
    // Never mutates the payload the station receives.
    expect(payload.setVariableData[0]?.attributeValue).toBe(PASSWORD);
  });

  it('2.1 GetVariables response and NotifyReport: masks a reported credential value', () => {
    const response = {
      getVariableResult: [
        {
          attributeStatus: 'Accepted',
          component: { name: 'SecurityCtrlr' },
          variable: { name: 'BasicAuthPassword' },
          attributeValue: PASSWORD,
        },
        {
          attributeStatus: 'Accepted',
          component: { name: 'AuthCtrlr' },
          variable: { name: 'LocalPreAuthorization' },
          attributeValue: 'true',
        },
      ],
    };
    const r = maskStationCredentials(response);
    expect(r.getVariableResult.map((v) => v.attributeValue)).toEqual([REDACTED, 'true']);

    const report = {
      reportData: [
        {
          component: { name: 'SecurityCtrlr' },
          variable: { name: 'BasicAuthPassword' },
          variableAttribute: [{ type: 'Actual', value: PASSWORD, mutability: 'WriteOnly' }],
          variableCharacteristics: { dataType: 'passwordString', supportsMonitoring: false },
        },
      ],
    };
    const m = maskStationCredentials(report);
    expect(m.reportData[0]?.variableAttribute[0]).toEqual({
      type: 'Actual',
      value: REDACTED,
      mutability: 'WriteOnly',
    });
    expect(m.reportData[0]?.variableCharacteristics.dataType).toBe('passwordString');
  });

  it('2.1 SetNetworkProfile: masks connectionData.basicAuthPassword', () => {
    const payload = {
      configurationSlot: 2,
      connectionData: {
        ocppVersion: 'OCPP21',
        ocppCsmsUrl: 'wss://csms.example.com/ocpp',
        securityProfile: 2,
        basicAuthPassword: PASSWORD,
        messageTimeout: 30,
      },
    };
    const m = maskStationCredentials(payload);
    expect(m.connectionData.basicAuthPassword).toBe(REDACTED);
    expect(m.connectionData.ocppCsmsUrl).toBe('wss://csms.example.com/ocpp');
    expect(m.connectionData.securityProfile).toBe(2);
  });

  it('1.6 ChangeConfiguration and GetConfiguration: masks AuthorizationKey only', () => {
    expect(maskStationCredentials({ key: 'AuthorizationKey', value: HEX })).toEqual({
      key: 'AuthorizationKey',
      value: REDACTED,
    });
    expect(maskStationCredentials({ key: 'HeartbeatInterval', value: '300' })).toEqual({
      key: 'HeartbeatInterval',
      value: '300',
    });
    const response = {
      configurationKey: [
        { key: 'AuthorizationKey', readonly: false, value: HEX },
        { key: 'AuthorizationCacheEnabled', readonly: false, value: 'true' },
      ],
      unknownKey: [],
    };
    const m = maskStationCredentials(response);
    expect(m.configurationKey.map((c) => c.value)).toEqual([REDACTED, 'true']);
  });

  it('leaves messages without credentials unchanged, empty values and nested data alone', () => {
    const boot = {
      reason: 'PowerUp',
      chargingStation: { model: 'X', vendorName: 'Y', serialNumber: '4111111111111111' },
    };
    expect(maskStationCredentials(boot)).toEqual(boot);
    const authorize = { idToken: { idToken: 'RFID-1', type: 'ISO14443' } };
    expect(maskStationCredentials(authorize)).toEqual(authorize);
    expect(maskStationCredentials({ key: 'AuthorizationKey', value: '' })).toEqual({
      key: 'AuthorizationKey',
      value: '',
    });
    const entry = { key: 'AuthorizationKey', value: HEX, meta: { value: 'kept' } };
    expect(maskStationCredentials(entry).meta.value).toBe('kept');
    expect(maskStationCredentials(null)).toBeNull();
  });

  it('tells whether a payload holds a station credential', () => {
    expect(holdsStationCredential({ key: 'AuthorizationKey', value: HEX })).toBe(true);
    expect(holdsStationCredential({ connectionData: { basicAuthPassword: PASSWORD } })).toBe(true);
    expect(holdsStationCredential({ key: 'HeartbeatInterval', value: '300' })).toBe(false);
    expect(holdsStationCredential({ type: 'Soft' })).toBe(false);
  });
});
