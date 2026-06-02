// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { mapCssToOcppConnectorType } from './css-connector-types.js';
import type { CssConnectorType } from './css-connector-types.js';

export interface CssConfigDefaultsEvse {
  evseId: number;
  connectorId: number;
  connectorType: CssConnectorType;
  maxPowerW: number;
  phases: number;
}

export interface CssConfigDefaultsInput {
  ocppProtocol: 'ocpp1.6' | 'ocpp2.1';
  stationId: string;
  vendorName: string;
  model: string;
  serialNumber: string;
  firmwareVersion: string;
  securityProfile: number;
  targetUrl: string;
  evses: readonly CssConfigDefaultsEvse[];
}

export interface CssConfigDefault {
  key: string;
  value: string;
  readonly: boolean;
}

export function buildCssConfigDefaults(input: CssConfigDefaultsInput): CssConfigDefault[] {
  const t = (key: string, value: string, readonly: boolean): CssConfigDefault => ({
    key,
    value,
    readonly,
  });

  if (input.ocppProtocol === 'ocpp1.6') {
    return [
      t('NumberOfConnectors', String(input.evses.length), true),
      t('HeartbeatInterval', '300', false),
      t('MeterValueSampleInterval', '10', false),
      t('MeterValuesSampledData', 'Energy.Active.Import.Register,Power.Active.Import', false),
      t('AuthorizationCacheEnabled', 'true', false),
      t('LocalPreAuthorize', 'false', false),
      t('LocalAuthorizeOffline', 'true', false),
      t('AllowOfflineTxForUnknownId', 'false', false),
      t('ClockAlignedDataInterval', '900', false),
      t('ConnectionTimeOut', '60', false),
      t('LocalAuthListEnabled', 'true', false),
      t('LocalAuthListMaxLength', '100', true),
      t('MeterValuesAlignedData', 'Energy.Active.Import.Register,Voltage', false),
      t('ResetRetries', '3', false),
      t('TransactionMessageAttempts', '3', false),
      t('TransactionMessageRetryInterval', '30', false),
      t('StopTransactionOnEVSideDisconnect', 'true', false),
      t('StopTransactionOnInvalidId', 'true', false),
      t('WebSocketPingInterval', '30', false),
      t(
        'SupportedFeatureProfiles',
        'Core,FirmwareManagement,LocalAuthListManagement,Reservation,SmartCharging,RemoteTrigger',
        true,
      ),
      t('ChargeProfileMaxStackLevel', '5', true),
      t('ChargingScheduleAllowedChargingRateUnit', 'Current,Power', true),
      t('ChargingScheduleMaxPeriods', '24', true),
      t('MaxChargingProfilesInstalled', '10', true),
      t('ConnectorPhaseRotation', '1.RST', true),
      t('GetConfigurationMaxKeys', '50', true),
      t('AuthorizationKey', '', false),
      t('ChargePointVendor', input.vendorName, true),
      t('ChargePointModel', input.model, true),
      t('ChargePointSerialNumber', input.serialNumber, true),
      t('FirmwareVersion', input.firmwareVersion, true),
    ];
  }

  const sp = String(input.securityProfile);
  const base: CssConfigDefault[] = [
    t('OCPPCommCtrlr.HeartbeatInterval', '300', false),
    t('OCPPCommCtrlr.NetworkConfigurationPriority', '1', false),
    t('OCPPCommCtrlr.OfflineThreshold', '60', false),
    t('OCPPCommCtrlr.MessageTimeout', '30', true),
    t('OCPPCommCtrlr.RetryBackOffWaitMinimum', '10', false),
    t('OCPPCommCtrlr.RetryBackOffRandomRange', '5', false),
    t('ChargingStation.VendorName', input.vendorName, true),
    t('ChargingStation.Model', input.model, true),
    t('ChargingStation.SerialNumber', input.serialNumber, true),
    t('ChargingStation.FirmwareVersion', input.firmwareVersion, true),
    t('ChargingStation.AvailabilityState', 'Available', false),
    t('SecurityCtrlr.SecurityProfile', sp, false),
    t('SecurityCtrlr.Identity', input.stationId, false),
    t('SecurityCtrlr.BasicAuthPassword', '', false),
    t('SecurityCtrlr.AllowSecurityDowngrade', 'false', false),
    t('NetworkConfiguration.OcppCsmsUrl#1', input.targetUrl, false),
    t('NetworkConfiguration.OcppInterface#1', 'Any', false),
    t('NetworkConfiguration.OcppTransport#1', 'JSON', false),
    t('NetworkConfiguration.OcppVersion#1', 'OCPP21', false),
    t('NetworkConfiguration.MessageTimeout#1', '30', false),
    t('NetworkConfiguration.SecurityProfile#1', sp, false),
    t('NetworkConfiguration.BasicAuthPassword#1', '', false),
    t('NetworkConfiguration.VpnEnabled#1', 'false', false),
    t('NetworkConfiguration.ApnEnabled#1', 'false', false),
    t('NetworkConfiguration.OcppCsmsUrl#2', '', false),
    t('NetworkConfiguration.OcppInterface#2', 'Any', false),
    t('NetworkConfiguration.OcppTransport#2', 'JSON', false),
    t('NetworkConfiguration.OcppVersion#2', 'OCPP21', false),
    t('NetworkConfiguration.MessageTimeout#2', '30', false),
    t('NetworkConfiguration.SecurityProfile#2', sp, false),
    t('NetworkConfiguration.BasicAuthPassword#2', '', false),
    t('NetworkConfiguration.VpnEnabled#2', 'false', false),
    t('NetworkConfiguration.ApnEnabled#2', 'false', false),
    t('AuthCtrlr.Enabled', 'true', false),
    t('AuthCtrlr.AuthorizeRemoteStart', 'true', false),
    t('AuthCtrlr.DisableRemoteAuthorization', 'false', false),
    t('AuthCtrlr.LocalAuthorizeOffline', 'true', false),
    t('AuthCtrlr.LocalPreAuthorize', 'false', false),
    t('AuthCacheCtrlr.Enabled', 'true', false),
    t('AuthCacheCtrlr.DisablePostAuthorize', 'false', false),
    t('LocalAuthListCtrlr.DisablePostAuthorize', 'false', false),
    t('AuthCacheCtrlr.LifeTime', '86400', false),
    t('ClockCtrlr.TimeSource', 'NTP', true),
    t('Connector.Available', 'true', false),
    t('SampledDataCtrlr.TxUpdatedInterval', '10', false),
    t(
      'SampledDataCtrlr.TxUpdatedMeasurands',
      'Energy.Active.Import.Register,Power.Active.Import,Voltage,Current.Import',
      false,
    ),
    t('TxCtrlr.EVConnectionTimeOut', '60', false),
    t('TxCtrlr.StopTxOnInvalidId', 'true', false),
    t('TxCtrlr.MaxEnergyOnInvalidId', '0', false),
    t('TxCtrlr.StopTxOnEVSideDisconnect', 'true', false),
    t('TxCtrlr.ResumptionTimeout', '0', false),
    t('MonitoringCtrlr.Enabled', 'true', false),
    t('DeviceDataCtrlr.ItemsPerMessage', '50', true),
    t('DeviceDataCtrlr.ItemsPerMessage#GetReport', '50', true),
    t('DeviceDataCtrlr.ItemsPerMessage#NotifyReport', '50', true),
    t('DeviceDataCtrlr.ItemsPerMessage#SetVariables', '50', true),
    t('DeviceDataCtrlr.ItemsPerMessage#GetVariables', '50', true),
    t('DeviceDataCtrlr.BytesPerMessage', '65536', true),
    t('DeviceDataCtrlr.BytesPerMessage#GetReport', '65536', true),
    t('DeviceDataCtrlr.BytesPerMessage#NotifyReport', '65536', true),
    t('AlignedDataCtrlr.Interval', '900', false),
    t('AlignedDataCtrlr.Measurands', 'Energy.Active.Import.Register,Voltage', false),
    t('CustomizationCtrlr.CustomTriggers', 'DiagnosticsLog,SecurityAudit', true),
    t('TariffCostCtrlr.Enabled', 'true', false),
    t('TariffCostCtrlr.TariffFallbackMessage', 'See operator for pricing', false),
    t('TariffCostCtrlr.Currency', 'EUR', false),
    t('TariffCostCtrlr.MaxElements#Tariff', '10', true),
  ];

  for (const evse of input.evses) {
    const evseScope = `[${String(evse.evseId)}]`;
    const connectorScope = `[${String(evse.evseId)},${String(evse.connectorId)}]`;
    const ocppType = mapCssToOcppConnectorType(evse.connectorType);
    base.push(
      t(`Connector${connectorScope}.ConnectorType`, ocppType, true),
      t(`Connector${connectorScope}.SupplyPhases`, String(evse.phases), true),
      t(`EVSE${evseScope}.AvailabilityState`, 'Available', false),
      t(`EVSE${evseScope}.Power`, String(evse.maxPowerW), true),
    );
  }

  return base;
}
