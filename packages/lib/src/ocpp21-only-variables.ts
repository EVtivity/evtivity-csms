// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Device model components and variables only OCPP 2.1 defines, from the
 * "Referenced Components and Variables" chapter of OCPP 2.1 Edition 2 Part 2
 * (sections marked "New in OCPP 2.1"), checked against the same chapter of
 * OCPP 2.0.1 Edition 4 Part 2, which has none of them. The smart charging
 * feature flags are listed under both names the 2.1 documents use:
 * SupportsFeature[<Feature>] (specification) and Supports<Feature> (appendix). A 2.1 configuration
 * template also reaches OCPP 2.0.1 stations, which never report these, so
 * config drift skips them for 2.0.1 stations. Variables that exist in 2.0.1
 * and only gained a new instance in 2.1 (TariffCostCtrlr.Enabled[RunningCost])
 * are not listed: a template sets a variable without an instance.
 */

/** Components new in OCPP 2.1: every variable of theirs is 2.1-only. */
export const OCPP21_ONLY_COMPONENTS: readonly string[] = [
  'ACDERCtrlr', // 2.18.2
  'BatteryCartridge', // 2.19.7 - 2.19.10
  'BatterySwapCtrlr', // 2.19.1 - 2.19.6
  'DataCollector', // 2.17.8
  'DCDERCtrlr', // 2.18.1
  'FrequencySimulator', // 2.17.7
  'NetworkConfiguration', // 2.1.8
  'V2XChargingCtrlr', // 2.17.1 - 2.17.6
];

/** Variables new in OCPP 2.1 on components 2.0.1 also has, as `Component.Variable`. */
export const OCPP21_ONLY_VARIABLES: readonly string[] = [
  'AlignedDataCtrlr.UpstreamInterval', // 2.8.24
  'AlignedDataCtrlr.UpstreamMeasurands', // 2.8.23
  'ChargingStation.ActiveTransactionId', // 2.14.12
  'Connector.SlotStatus', // 2.19.11
  'CustomizationCtrlr.CustomTriggers', // 2.1.35
  'DisplayMessageCtrlr.Language', // 2.13.7
  'DisplayMessageCtrlr.SupportedStates', // 2.13.6
  'EVSE.ActiveTransactionId', // 2.14.11
  'EVSE.ChargingState', // 2.14.10
  'EVSE.DCInputPhaseControl', // 2.14.7
  'EVSE.DischargePower', // 2.14.9
  'ISO15118Ctrlr.MaxPriceElements', // 2.15.15
  'ISO15118Ctrlr.NotificationMaxDelay', // 2.15.12
  'ISO15118Ctrlr.ProtocolSupported', // 2.15.16
  'ISO15118Ctrlr.ServiceRenegotiationSupport', // 2.15.13
  'ISO15118Ctrlr.SupportedProviders', // 2.15.14
  'MonitoringCtrlr.MaxPeriodicEventStreams', // 2.12.11
  'OCPPCommCtrlr.ExternalConfigChangeDate', // 2.1.36
  'SampledDataCtrlr.UpstreamInterval', // 2.8.13
  'SampledDataCtrlr.UpstreamMeasurands', // 2.8.12
  'SmartChargingCtrlr.ChargingProfilePersistence', // 2.10.13
  'SmartChargingCtrlr.ExternalConstraintsProfileDisallowed', // 2.10.8
  'SmartChargingCtrlr.MaxExternalConstraintsId', // 2.10.16
  'SmartChargingCtrlr.SetpointPriority', // 2.10.15
  'SmartChargingCtrlr.SupportedAdditionalPurposes', // 2.10.17
  'SmartChargingCtrlr.SupportsDynamicProfiles', // appendix name of 2.10.18
  'SmartChargingCtrlr.SupportsEvseSleep', // appendix name of 2.10.23
  'SmartChargingCtrlr.SupportsFeature', // 2.10.18 - 2.10.23
  'SmartChargingCtrlr.SupportsLimitAtSoC', // appendix name of 2.10.22
  'SmartChargingCtrlr.SupportsMaxOfflineDuration', // appendix name of 2.10.19
  'SmartChargingCtrlr.SupportsRandomizedDelay', // appendix name of 2.10.21
  'SmartChargingCtrlr.SupportsUseLocalTime', // appendix name of 2.10.20
  'SmartChargingCtrlr.UpdateRateLimit', // 2.10.14
  'TariffCostCtrlr.ConditionsSupported', // 2.11.13
  'TariffCostCtrlr.HandleFailedTariff', // 2.11.14
  'TariffCostCtrlr.Interval', // 2.11.10, 2.11.11
  'TariffCostCtrlr.MaxElements', // 2.11.12
  'TariffCostCtrlr.OfflineTariffFallbackMessage', // 2.11.8
  'TxCtrlr.AllowEnergyTransferResumption', // 2.7.10
  'TxCtrlr.EnergyTransferResumptionRandomRange', // 2.7.11
  'TxCtrlr.ResumptionTimeout', // 2.7.9
  'TxCtrlr.SupportedLimits', // 2.7.12
];

const COMPONENTS = new Set(OCPP21_ONLY_COMPONENTS);
const VARIABLES = new Set(OCPP21_ONLY_VARIABLES);

/** Whether a device model variable exists only in OCPP 2.1 (an OCPP 2.0.1 station never has it). */
export function isOcpp21OnlyVariable(component: string, variable: string): boolean {
  return COMPONENTS.has(component) || VARIABLES.has(`${component}.${variable}`);
}
