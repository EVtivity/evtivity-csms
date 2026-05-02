// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

const SHARED_CONFIG_DEFAULTS: Record<string, string> = {
  HeartbeatInterval: '60',
  MeterValueSampleInterval: '30',
  AuthorizeRemoteTxRequests: 'true',
};

export const OCPP21_CONFIG_DEFAULTS: Record<string, string> = {
  ...SHARED_CONFIG_DEFAULTS,
  'AlignedDataCtrlr.Interval': '0',
  'SampledDataCtrlr.TxEndedInterval': '30',
  'SampledDataCtrlr.TxEndedMeasurands': 'Energy.Active.Import.Register',
  'SampledDataCtrlr.TxUpdatedInterval': '30',
  'SampledDataCtrlr.TxUpdatedMeasurands': 'Energy.Active.Import.Register,Power.Active.Import',
  'TxCtrlr.EVConnectionTimeOut': '60',
  'TxCtrlr.StopTxOnInvalidId': 'false',
  'TxCtrlr.TxBeforeAcceptedEnabled': 'true',
  'OCPPCommCtrlr.NetworkConfigurationPriority': 'Wired0',
  'SecurityCtrlr.SecurityProfile': '1',
};

export const OCPP16_CONFIG_DEFAULTS: Record<string, string> = {
  ...SHARED_CONFIG_DEFAULTS,
  ClockAlignedDataInterval: '0',
  ConnectionTimeOut: '60',
  StopTransactionOnInvalidId: 'false',
  MeterValuesAlignedData: 'Energy.Active.Import.Register',
  MeterValuesSampledData: 'Energy.Active.Import.Register,Power.Active.Import',
};
