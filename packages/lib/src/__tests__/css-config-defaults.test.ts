// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  buildCssConfigDefaults,
  CSS_RECONNECT_SPREAD_S,
  type CssConfigDefaultsInput,
} from '../css-config-defaults.js';

function baseInput(overrides: Partial<CssConfigDefaultsInput> = {}): CssConfigDefaultsInput {
  return {
    ocppProtocol: 'ocpp2.1',
    stationId: 'TEST-001',
    vendorName: 'TestVendor',
    model: 'TestModel',
    serialNumber: 'SN-1',
    firmwareVersion: '1.0',
    securityProfile: 1,
    targetUrl: 'wss://ocpp:8443',
    evses: [{ evseId: 1, connectorId: 1, connectorType: 'ac_type2', maxPowerW: 22000, phases: 3 }],
    ...overrides,
  };
}

function keyMap(defaults: ReturnType<typeof buildCssConfigDefaults>): Map<string, string> {
  return new Map(defaults.map((d) => [d.key, d.value]));
}

describe('buildCssConfigDefaults', () => {
  describe('OCPP 1.6', () => {
    it('includes the spec-required core keys and identity fields from input', () => {
      const m = keyMap(buildCssConfigDefaults(baseInput({ ocppProtocol: 'ocpp1.6' })));

      expect(m.get('HeartbeatInterval')).toBe('300');
      expect(m.get('MeterValueSampleInterval')).toBe('10');
      expect(m.get('NumberOfConnectors')).toBe('1');
      expect(m.get('ChargePointVendor')).toBe('TestVendor');
      expect(m.get('ChargePointModel')).toBe('TestModel');
      expect(m.get('ChargePointSerialNumber')).toBe('SN-1');
      expect(m.get('FirmwareVersion')).toBe('1.0');
    });

    it('includes the Security Whitepaper keys', () => {
      const defaults = buildCssConfigDefaults(baseInput({ ocppProtocol: 'ocpp1.6' }));
      const byKey = new Map(defaults.map((d) => [d.key, d]));

      expect(byKey.get('CpoName')).toEqual({
        key: 'CpoName',
        value: 'TestVendor',
        readonly: false,
      });
      expect(byKey.get('CertificateStoreMaxLength')?.readonly).toBe(true);
      expect(byKey.get('CertificateSignedMaxChainSize')?.value).toBe('10000');
      expect(byKey.get('AdditionalRootCertificateCheck')?.value).toBe('false');
    });

    it('reports AuthorizeRemoteTxRequests as read-only false (no Authorize before a remote start)', () => {
      const defaults = buildCssConfigDefaults(baseInput({ ocppProtocol: 'ocpp1.6' }));
      expect(defaults.find((d) => d.key === 'AuthorizeRemoteTxRequests')).toEqual({
        key: 'AuthorizeRemoteTxRequests',
        value: 'false',
        readonly: true,
      });
    });

    it('reflects the EVSE count in NumberOfConnectors', () => {
      const m = keyMap(
        buildCssConfigDefaults(
          baseInput({
            ocppProtocol: 'ocpp1.6',
            evses: [
              { evseId: 1, connectorId: 1, connectorType: 'ac_type2', maxPowerW: 22000, phases: 3 },
              { evseId: 2, connectorId: 1, connectorType: 'dc_ccs2', maxPowerW: 50000, phases: 3 },
              {
                evseId: 3,
                connectorId: 1,
                connectorType: 'dc_chademo',
                maxPowerW: 50000,
                phases: 3,
              },
            ],
          }),
        ),
      );

      expect(m.get('NumberOfConnectors')).toBe('3');
    });

    it('does not emit per-EVSE Connector[*,*].* keys for 1.6', () => {
      const defaults = buildCssConfigDefaults(baseInput({ ocppProtocol: 'ocpp1.6' }));
      const hasScopedKey = defaults.some(
        (d) => d.key.includes('Connector[') || d.key.includes('EVSE['),
      );
      expect(hasScopedKey).toBe(false);
    });
  });

  describe('OCPP 2.1', () => {
    it('spreads reconnects through the factory back-off (Part 4 5.4)', () => {
      const m = keyMap(buildCssConfigDefaults(baseInput()));
      expect(m.get('OCPPCommCtrlr.RetryBackOffWaitMinimum')).toBe('2');
      expect(m.get('OCPPCommCtrlr.RetryBackOffRandomRange')).toBe(String(CSS_RECONNECT_SPREAD_S));
      expect(m.get('OCPPCommCtrlr.RetryBackOffRepeatTimes')).toBe('3');
      expect(CSS_RECONNECT_SPREAD_S).toBe(15);
    });

    it('includes the OCPP 2.1 device model keys', () => {
      const m = keyMap(buildCssConfigDefaults(baseInput()));

      expect(m.get('OCPPCommCtrlr.HeartbeatInterval')).toBe('300');
      expect(m.get('ChargingStation.VendorName')).toBe('TestVendor');
      expect(m.get('ChargingStation.Model')).toBe('TestModel');
      expect(m.get('SecurityCtrlr.SecurityProfile')).toBe('1');
      expect(m.get('SecurityCtrlr.Identity')).toBe('TEST-001');
      // Certificate signing (A02, A00.FR.509)
      expect(m.get('SecurityCtrlr.OrganizationName')).toBe('TestVendor');
      expect(m.get('SecurityCtrlr.CertSigningWaitMinimum')).toBe('60');
      expect(m.get('SecurityCtrlr.CertSigningRepeatTimes')).toBe('3');
    });

    it('reports connector status with both messages by default', () => {
      const m = keyMap(buildCssConfigDefaults(baseInput()));
      expect(m.get('SimulatorCtrlr.StatusReporting')).toBe('Both');
      const m16 = keyMap(buildCssConfigDefaults(baseInput({ ocppProtocol: 'ocpp1.6' })));
      expect(m16.has('SimulatorCtrlr.StatusReporting')).toBe(false);
    });

    it('seeds NetworkConfiguration slot 1 with the simulator targetUrl', () => {
      const m = keyMap(buildCssConfigDefaults(baseInput({ targetUrl: 'wss://example:8443' })));

      expect(m.get('NetworkConfiguration.OcppCsmsUrl#1')).toBe('wss://example:8443');
      expect(m.get('NetworkConfiguration.SecurityProfile#1')).toBe('1');
    });

    it('emits per-EVSE Connector[evseId,connectorId].* keys derived from css_evses connectorType', () => {
      const m = keyMap(
        buildCssConfigDefaults(
          baseInput({
            evses: [
              { evseId: 1, connectorId: 1, connectorType: 'dc_ccs2', maxPowerW: 50000, phases: 3 },
              {
                evseId: 2,
                connectorId: 1,
                connectorType: 'dc_chademo',
                maxPowerW: 50000,
                phases: 3,
              },
            ],
          }),
        ),
      );

      expect(m.get('Connector[1,1].ConnectorType')).toBe('cCCS2');
      expect(m.get('Connector[1,1].SupplyPhases')).toBe('3');
      expect(m.get('EVSE[1].AvailabilityState')).toBe('Available');
      expect(m.get('EVSE[1].Power')).toBe('50000');

      expect(m.get('Connector[2,1].ConnectorType')).toBe('cChaoJi');
      expect(m.get('EVSE[2].Power')).toBe('50000');
    });

    it('keeps Connector.Available global (not per-EVSE) so component-existence probes resolve', () => {
      const m = keyMap(buildCssConfigDefaults(baseInput()));

      expect(m.get('Connector.Available')).toBe('true');
    });

    it('marks identity and threshold keys readonly per OCPP spec', () => {
      const defaults = buildCssConfigDefaults(baseInput());
      const lookup = new Map(defaults.map((d) => [d.key, d.readonly]));

      expect(lookup.get('ChargingStation.VendorName')).toBe(true);
      expect(lookup.get('ChargingStation.Model')).toBe(true);
      expect(lookup.get('ChargingStation.SerialNumber')).toBe(true);
      expect(lookup.get('ChargingStation.FirmwareVersion')).toBe(true);
      expect(lookup.get('ChargingStation.AvailabilityState')).toBe(false);
      expect(lookup.get('OCPPCommCtrlr.HeartbeatInterval')).toBe(false);
    });
  });

  describe('determinism', () => {
    it('produces the same output for the same input (no Math.random or time-dependent values)', () => {
      const input = baseInput();
      const a = buildCssConfigDefaults(input);
      const b = buildCssConfigDefaults(input);

      expect(a).toEqual(b);
    });
  });
});
