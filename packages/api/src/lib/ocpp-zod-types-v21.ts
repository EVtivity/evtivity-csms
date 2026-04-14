// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

// ============================================================
// OCPP 2.1 Zod Schema Library
// Auto-generated from OCPP 2.1 JSON schemas.
// Single source of truth for OCPP types used across the API.
// ============================================================

// ============================================================
// Enum Types
// ============================================================

// --- APN Authentication (SetNetworkProfile) ---
export const apnAuthenticationEnum = z
  .enum(['PAP', 'CHAP', 'NONE', 'AUTO'])
  .describe('Authentication method.');

// --- Variable Attribute Type (GetVariables, SetVariables, GetBaseReport) ---
export const attributeEnum = z
  .enum(['Actual', 'Target', 'MinSet', 'MaxSet'])
  .describe('Attribute type for which value is requested');

// --- Authorization Status (Authorize, TransactionEvent) ---
export const authorizationStatusEnum = z
  .enum([
    'Accepted',
    'Blocked',
    'ConcurrentTx',
    'Expired',
    'Invalid',
    'NoCredit',
    'NotAllowedTypeEVSE',
    'NotAtThisLocation',
    'NotAtThisTime',
    'Unknown',
  ])
  .describe('Current status of the ID Token.');

// --- Authorize Certificate Status (Authorize) ---
export const authorizeCertificateStatusEnum = z
  .enum([
    'Accepted',
    'SignatureError',
    'CertificateExpired',
    'CertificateRevoked',
    'NoCertificateAvailable',
    'CertChainError',
    'ContractCancelled',
  ])
  .describe('Certificate status information');

// --- Battery Swap Event (BatterySwap) ---
export const batterySwapEventEnum = z
  .enum(['BatteryIn', 'BatteryOut', 'BatteryOutTimeout'])
  .describe('Battery in/out');

// --- Boot Reason (BootNotification) ---
export const bootReasonEnum = z
  .enum([
    'ApplicationReset',
    'FirmwareUpdate',
    'LocalReset',
    'PowerUp',
    'RemoteReset',
    'ScheduledReset',
    'Triggered',
    'Unknown',
    'Watchdog',
  ])
  .describe('This contains the reason for sending this message to the CSMS.');

// --- Cancel Reservation Status (CancelReservation) ---
export const cancelReservationStatusEnum = z
  .enum(['Accepted', 'Rejected'])
  .describe('This indicates the success or failure of the canceling of a reservation by CSMS.');

// --- Certificate Action (Get15118EVCertificate) ---
export const certificateActionEnum = z
  .enum(['Install', 'Update'])
  .describe('Defines whether certificate needs to be installed or updated.');

// --- Certificate Signed Status (CertificateSigned) ---
export const certificateSignedStatusEnum = z
  .enum(['Accepted', 'Rejected'])
  .describe('Returns whether certificate signing has been accepted, otherwise rejected.');

// --- Certificate Signing Use (SignCertificate) ---
export const certificateSigningUseEnum = z
  .enum(['ChargingStationCertificate', 'V2GCertificate', 'V2G20Certificate'])
  .describe('Indicates the type of the signed certificate that is returned');

// --- Certificate Status (GetCertificateStatus) ---
export const certificateStatusEnum = z
  .enum(['Good', 'Revoked', 'Unknown', 'Failed'])
  .describe('Status of certificate: good, revoked or unknown.');

// --- Certificate Status Source (GetCertificateChainStatus) ---
export const certificateStatusSourceEnum = z
  .enum(['CRL', 'OCSP'])
  .describe('Source of status: OCSP, CRL');

// --- Change Availability Status (ChangeAvailability) ---
export const changeAvailabilityStatusEnum = z
  .enum(['Accepted', 'Rejected', 'Scheduled'])
  .describe(
    'This indicates whether the Charging Station is able to perform the availability change.',
  );

// --- Charging Profile Kind (SetChargingProfile, GetChargingProfiles) ---
export const chargingProfileKindEnum = z
  .enum(['Absolute', 'Recurring', 'Relative', 'Dynamic'])
  .describe('Indicates the kind of schedule.');

// --- Charging Profile Purpose (SetChargingProfile, ClearChargingProfile, GetChargingProfiles) ---
export const chargingProfilePurposeEnum = z
  .enum([
    'ChargingStationExternalConstraints',
    'ChargingStationMaxProfile',
    'TxDefaultProfile',
    'TxProfile',
    'PriorityCharging',
    'LocalGeneration',
  ])
  .describe(
    'Specifies to purpose of the charging profiles that will be cleared, if they meet the other criter...',
  );

// --- Charging Profile Status (SetChargingProfile) ---
export const chargingProfileStatusEnum = z
  .enum(['Accepted', 'Rejected'])
  .describe('Result of request.');

// --- Charging Rate Unit (SetChargingProfile, GetCompositeSchedule) ---
export const chargingRateUnitEnum = z
  .enum(['W', 'A'])
  .describe('Can be used to force a power or current profile.');

// --- Charging State (TransactionEvent) ---
export const chargingStateEnum = z
  .enum(['EVConnected', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Idle'])
  .describe('Current charging state, is required when state has changed');

// --- Clear Cache Status (ClearCache) ---
export const clearCacheStatusEnum = z
  .enum(['Accepted', 'Rejected'])
  .describe('Accepted if the Charging Station has executed the request, otherwise rejected.');

// --- Clear Charging Profile Status (ClearChargingProfile) ---
export const clearChargingProfileStatusEnum = z
  .enum(['Accepted', 'Unknown'])
  .describe('Indicates if the Charging Station was able to execute the request.');

// --- Clear Message Status (ClearDisplayMessage) ---
export const clearMessageStatusEnum = z
  .enum(['Accepted', 'Unknown', 'Rejected'])
  .describe('Returns whether the Charging Station has been able to remove the message.');

// --- Clear Monitoring Status (ClearVariableMonitoring) ---
export const clearMonitoringStatusEnum = z
  .enum(['Accepted', 'Rejected', 'NotFound'])
  .describe('Result of the clear request for this monitor, identified by its Id.');

// --- Component Criterion (GetBaseReport) ---
export const componentCriterionEnum = z.enum(['Active', 'Available', 'Enabled', 'Problem']);

// --- Connector Status (StatusNotification) ---
export const connectorStatusEnum = z
  .enum(['Available', 'Occupied', 'Reserved', 'Unavailable', 'Faulted'])
  .describe('This contains the current status of the Connector.');

// --- Control Mode (NotifyEVChargingNeeds) ---
export const controlModeEnum = z
  .enum(['ScheduledControl', 'DynamicControl'])
  .describe('Indicates whether EV wants to operate in Dynamic or Scheduled mode');

// --- Cost Dimension (TransactionEvent running cost) ---
export const costDimensionEnum = z
  .enum(['Energy', 'MaxCurrent', 'MinCurrent', 'MaxPower', 'MinPower', 'IdleTIme', 'ChargingTime'])
  .describe('Type of cost dimension: energy, power, time, etc.');

// --- Cost Kind (TransactionEvent running cost) ---
export const costKindEnum = z
  .enum(['CarbonDioxideEmission', 'RelativePricePercentage', 'RenewableGenerationPercentage'])
  .describe('The kind of cost referred to in the message element amount');

// --- Customer Information Status (CustomerInformation) ---
export const customerInformationStatusEnum = z
  .enum(['Accepted', 'Rejected', 'Invalid'])
  .describe('Indicates whether the request was accepted.');

// --- DER Control (SetDERControl, ClearDERControl, GetDERControl) ---
export const derControlEnum = z
  .enum([
    'EnterService',
    'FreqDroop',
    'FreqWatt',
    'FixedPFAbsorb',
    'FixedPFInject',
    'FixedVar',
    'Gradients',
    'HFMustTrip',
    'HFMayTrip',
    'HVMustTrip',
    'HVMomCess',
    'HVMayTrip',
    'LimitMaxDischarge',
    'LFMustTrip',
    'LVMustTrip',
    'LVMomCess',
    'LVMayTrip',
    'PowerMonitoringMustTrip',
    'VoltVar',
    'VoltWatt',
    'WattPF',
    'WattVar',
  ])
  .describe('Name of control settings to clear');

// --- DER Control Status (SetDERControl, ClearDERControl) ---
export const derControlStatusEnum = z
  .enum(['Accepted', 'Rejected', 'NotSupported', 'NotFound'])
  .describe('Result of operation.');

// --- DER Unit (DER curves) ---
export const derUnitEnum = z
  .enum(['Not_Applicable', 'PctMaxW', 'PctMaxVar', 'PctWAvail', 'PctVarAvail', 'PctEffectiveV'])
  .describe('Unit of the Y-axis of DER curve');

// --- Data Type (GetBaseReport, SetVariables) ---
export const dataEnum = z
  .enum([
    'string',
    'decimal',
    'integer',
    'dateTime',
    'boolean',
    'OptionList',
    'SequenceList',
    'MemberList',
  ])
  .describe('Data type of this variable.');

// --- Data Transfer Status (DataTransfer) ---
export const dataTransferStatusEnum = z
  .enum(['Accepted', 'Rejected', 'UnknownMessageId', 'UnknownVendorId'])
  .describe('This indicates the success or failure of the data transfer.');

// --- Day of Week (Tariff conditions) ---
export const dayOfWeekEnum = z.enum([
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
]);

// --- Delete Certificate Status (DeleteCertificate) ---
export const deleteCertificateStatusEnum = z
  .enum(['Accepted', 'Failed', 'NotFound'])
  .describe('Charging Station indicates if it can process the request.');

// --- Display Message Status (SetDisplayMessage) ---
export const displayMessageStatusEnum = z
  .enum([
    'Accepted',
    'NotSupportedMessageFormat',
    'Rejected',
    'NotSupportedPriority',
    'NotSupportedState',
    'UnknownTransaction',
    'LanguageNotSupported',
  ])
  .describe('This indicates whether the Charging Station is able to display the message.');

// --- Energy Transfer Mode (NotifyEVChargingNeeds, NotifyAllowedEnergyTransfer) ---
export const energyTransferModeEnum = z.enum([
  'AC_single_phase',
  'AC_two_phase',
  'AC_three_phase',
  'DC',
  'AC_BPT',
  'AC_BPT_DER',
  'AC_DER',
  'DC_BPT',
  'DC_ACDP',
  'DC_ACDP_BPT',
  'WPT',
]);

// --- Event Notification Type (NotifyEvent) ---
export const eventNotificationEnum = z
  .enum(['HardWiredNotification', 'HardWiredMonitor', 'PreconfiguredMonitor', 'CustomMonitor'])
  .describe('Specifies the event notification type of the message.');

// --- Event Trigger (NotifyEvent) ---
export const eventTriggerEnum = z
  .enum(['Alerting', 'Delta', 'Periodic'])
  .describe('Type of trigger for this event, e.g');

// --- EVSE Kind (Tariff conditions) ---
export const evseKindEnum = z
  .enum(['AC', 'DC'])
  .describe('Type of EVSE (AC, DC) this tariff applies to.');

// --- Firmware Status (FirmwareStatusNotification) ---
export const firmwareStatusEnum = z
  .enum([
    'Downloaded',
    'DownloadFailed',
    'Downloading',
    'DownloadScheduled',
    'DownloadPaused',
    'Idle',
    'InstallationFailed',
    'Installing',
    'Installed',
    'InstallRebooting',
    'InstallScheduled',
    'InstallVerificationFailed',
    'InvalidSignature',
    'SignatureVerified',
  ])
  .describe('This contains the progress status of the firmware installation.');

// --- Generic Device Model Status (GetBaseReport, GetReport) ---
export const genericDeviceModelStatusEnum = z
  .enum(['Accepted', 'Rejected', 'NotSupported', 'EmptyResultSet'])
  .describe('This indicates whether the Charging Station is able to accept this request.');

// --- Generic Status (shared: multiple responses) ---
export const genericStatusEnum = z.enum(['Accepted', 'Rejected']);

// --- Get Certificate ID Use (GetInstalledCertificateIds) ---
export const getCertificateIdUseEnum = z.enum([
  'V2GRootCertificate',
  'MORootCertificate',
  'CSMSRootCertificate',
  'V2GCertificateChain',
  'ManufacturerRootCertificate',
  'OEMRootCertificate',
]);

// --- Get Certificate Status (GetCertificateStatus) ---
export const getCertificateStatusEnum = z
  .enum(['Accepted', 'Failed'])
  .describe(
    'This indicates whether the charging station was able to retrieve the OCSP certificate status.',
  );

// --- Get Charging Profile Status (GetChargingProfiles) ---
export const getChargingProfileStatusEnum = z
  .enum(['Accepted', 'NoProfiles'])
  .describe(
    'This indicates whether the Charging Station is able to process this request and will send &lt;&lt...',
  );

// --- Get Display Messages Status (GetDisplayMessages) ---
export const getDisplayMessagesStatusEnum = z
  .enum(['Accepted', 'Unknown'])
  .describe(
    'Indicates if the Charging Station has Display Messages that match the request criteria in the &lt...',
  );

// --- Get Installed Certificate Status (GetInstalledCertificateIds) ---
export const getInstalledCertificateStatusEnum = z
  .enum(['Accepted', 'NotFound'])
  .describe('Charging Station indicates if it can process the request.');

// --- Get Variable Status (GetVariables) ---
export const getVariableStatusEnum = z.enum([
  'Accepted',
  'Rejected',
  'UnknownComponent',
  'UnknownVariable',
  'NotSupportedAttributeType',
]);

// --- Grid Event Fault (NotifyGridEvent) ---
export const gridEventFaultEnum = z
  .enum([
    'CurrentImbalance',
    'LocalEmergency',
    'LowInputPower',
    'OverCurrent',
    'OverFrequency',
    'OverVoltage',
    'PhaseRotation',
    'RemoteEmergency',
    'UnderFrequency',
    'UnderVoltage',
    'VoltageImbalance',
  ])
  .describe('Type of grid event that caused this');

// --- Hash Algorithm (shared: certificate operations) ---
export const hashAlgorithmEnum = z
  .enum(['SHA256', 'SHA384', 'SHA512'])
  .describe('Used algorithms for the hashes provided.');

// --- Install Certificate Status (InstallCertificate) ---
export const installCertificateStatusEnum = z
  .enum(['Accepted', 'Rejected', 'Failed'])
  .describe('Charging Station indicates if installation was successful.');

// --- Install Certificate Use (InstallCertificate) ---
export const installCertificateUseEnum = z
  .enum([
    'V2GRootCertificate',
    'MORootCertificate',
    'ManufacturerRootCertificate',
    'CSMSRootCertificate',
    'OEMRootCertificate',
  ])
  .describe('Indicates the certificate type that is sent.');

// --- Islanding Detection Method (DER charging parameters) ---
export const islandingDetectionEnum = z.enum([
  'NoAntiIslandingSupport',
  'RoCoF',
  'UVP_OVP',
  'UFP_OFP',
  'VoltageVectorShift',
  'ZeroCrossingDetection',
  'OtherPassive',
  'ImpedanceMeasurement',
  'ImpedanceAtFrequency',
  'SlipModeFrequencyShift',
  'SandiaFrequencyShift',
  'SandiaVoltageShift',
  'FrequencyJump',
  'RCLQFactor',
  'OtherActive',
]);

// --- ISO 15118 EV Certificate Status (Get15118EVCertificate) ---
export const iso15118EVCertificateStatusEnum = z
  .enum(['Accepted', 'Failed'])
  .describe('Indicates whether the message was processed properly.');

// --- Measurement Location (MeterValues, TransactionEvent) ---
export const locationEnum = z
  .enum(['Body', 'Cable', 'EV', 'Inlet', 'Outlet', 'Upstream'])
  .describe('Indicates where the measured value has been sampled');

// --- Log Type (GetLog) ---
export const logEnum = z
  .enum(['DiagnosticsLog', 'SecurityLog', 'DataCollectorLog'])
  .describe('This contains the type of log file that the Charging Station should send.');

// --- Log Status (GetLog) ---
export const logStatusEnum = z
  .enum(['Accepted', 'Rejected', 'AcceptedCanceled'])
  .describe('This field indicates whether the Charging Station was able to accept the request.');

// --- Measurand (MeterValues, TransactionEvent) ---
export const measurandEnum = z
  .enum([
    'Current.Export',
    'Current.Export.Offered',
    'Current.Export.Minimum',
    'Current.Import',
    'Current.Import.Offered',
    'Current.Import.Minimum',
    'Current.Offered',
    'Display.PresentSOC',
    'Display.MinimumSOC',
    'Display.TargetSOC',
    'Display.MaximumSOC',
    'Display.RemainingTimeToMinimumSOC',
    'Display.RemainingTimeToTargetSOC',
    'Display.RemainingTimeToMaximumSOC',
    'Display.ChargingComplete',
    'Display.BatteryEnergyCapacity',
    'Display.InletHot',
    'Energy.Active.Export.Interval',
    'Energy.Active.Export.Register',
    'Energy.Active.Import.Interval',
    'Energy.Active.Import.Register',
    'Energy.Active.Import.CableLoss',
    'Energy.Active.Import.LocalGeneration.Register',
    'Energy.Active.Net',
    'Energy.Active.Setpoint.Interval',
    'Energy.Apparent.Export',
    'Energy.Apparent.Import',
    'Energy.Apparent.Net',
    'Energy.Reactive.Export.Interval',
    'Energy.Reactive.Export.Register',
    'Energy.Reactive.Import.Interval',
    'Energy.Reactive.Import.Register',
    'Energy.Reactive.Net',
    'EnergyRequest.Target',
    'EnergyRequest.Minimum',
    'EnergyRequest.Maximum',
    'EnergyRequest.Minimum.V2X',
    'EnergyRequest.Maximum.V2X',
    'EnergyRequest.Bulk',
    'Frequency',
    'Power.Active.Export',
    'Power.Active.Import',
    'Power.Active.Setpoint',
    'Power.Active.Residual',
    'Power.Export.Minimum',
    'Power.Export.Offered',
    'Power.Factor',
    'Power.Import.Offered',
    'Power.Import.Minimum',
    'Power.Offered',
    'Power.Reactive.Export',
    'Power.Reactive.Import',
    'SoC',
    'Voltage',
    'Voltage.Minimum',
    'Voltage.Maximum',
  ])
  .describe('Type of measurement');

// --- Message Format (SetDisplayMessage) ---
export const messageFormatEnum = z
  .enum(['ASCII', 'HTML', 'URI', 'UTF8', 'QRCODE'])
  .describe('Format of the message.');

// --- Message Priority (SetDisplayMessage, GetDisplayMessages) ---
export const messagePriorityEnum = z
  .enum(['AlwaysFront', 'InFront', 'NormalCycle'])
  .describe(
    'If provided the Charging Station shall return Display Messages with the given priority only.',
  );

// --- Message State (SetDisplayMessage, GetDisplayMessages) ---
export const messageStateEnum = z
  .enum(['Charging', 'Faulted', 'Idle', 'Unavailable', 'Suspended', 'Discharging'])
  .describe(
    'If provided the Charging Station shall return Display Messages with the given state only.',
  );

// --- Message Trigger (TriggerMessage) ---
export const messageTriggerEnum = z
  .enum([
    'BootNotification',
    'LogStatusNotification',
    'FirmwareStatusNotification',
    'Heartbeat',
    'MeterValues',
    'SignChargingStationCertificate',
    'SignV2GCertificate',
    'SignV2G20Certificate',
    'StatusNotification',
    'TransactionEvent',
    'SignCombinedCertificate',
    'PublishFirmwareStatusNotification',
    'CustomTrigger',
  ])
  .describe('Type of message to be triggered.');

// --- Mobility Needs Mode (NotifyEVChargingNeeds) ---
export const mobilityNeedsModeEnum = z
  .enum(['EVCC', 'EVCC_SECC'])
  .describe('Value of EVCC indicates that EV determines min/target SOC and departure time');

// --- Monitor Type (SetVariableMonitoring, NotifyMonitoringReport) ---
export const monitorEnum = z
  .enum([
    'UpperThreshold',
    'LowerThreshold',
    'Delta',
    'Periodic',
    'PeriodicClockAligned',
    'TargetDelta',
    'TargetDeltaRelative',
  ])
  .describe('The type of this monitor, e.g');

// --- Monitoring Base (SetMonitoringBase) ---
export const monitoringBaseEnum = z
  .enum(['All', 'FactoryDefault', 'HardWiredOnly'])
  .describe('Specify which monitoring base will be set');

// --- Monitoring Criterion (GetMonitoringReport) ---
export const monitoringCriterionEnum = z.enum([
  'ThresholdMonitoring',
  'DeltaMonitoring',
  'PeriodicMonitoring',
]);

// --- Mutability (GetBaseReport variable attributes) ---
export const mutabilityEnum = z
  .enum(['ReadOnly', 'WriteOnly', 'ReadWrite'])
  .describe('Defines the mutability of this attribute');

// --- Notify Allowed Energy Transfer Status (NotifyAllowedEnergyTransfer) ---
export const notifyAllowedEnergyTransferStatusEnum = z.enum(['Accepted', 'Rejected']);

// --- Notify EV Charging Needs Status (NotifyEVChargingNeeds) ---
export const notifyEVChargingNeedsStatusEnum = z
  .enum(['Accepted', 'Rejected', 'Processing', 'NoChargingProfile'])
  .describe('Returns whether the CSMS has been able to process the message successfully');

// --- OCPP Interface (SetNetworkProfile) ---
export const ocppInterfaceEnum = z
  .enum([
    'Wired0',
    'Wired1',
    'Wired2',
    'Wired3',
    'Wireless0',
    'Wireless1',
    'Wireless2',
    'Wireless3',
    'Any',
  ])
  .describe('Applicable Network Interface');

// --- OCPP Transport (SetNetworkProfile) ---
export const ocppTransportEnum = z
  .enum(['SOAP', 'JSON'])
  .describe('Defines the transport protocol (e.g');

// --- OCPP Version (SetNetworkProfile) ---
export const ocppVersionEnum = z
  .enum(['OCPP12', 'OCPP15', 'OCPP16', 'OCPP20', 'OCPP201', 'OCPP21'])
  .describe(
    'This field is ignored, since the OCPP version to use is determined during the websocket handshake',
  );

// --- Operation Mode (SetChargingProfile schedule periods) ---
export const operationModeEnum = z
  .enum([
    'Idle',
    'ChargingOnly',
    'CentralSetpoint',
    'ExternalSetpoint',
    'ExternalLimits',
    'CentralFrequency',
    'LocalFrequency',
    'LocalLoadBalancing',
  ])
  .describe('Charging operation mode to use during this time interval');

// --- Operational Status (ChangeAvailability) ---
export const operationalStatusEnum = z
  .enum(['Inoperative', 'Operative'])
  .describe(
    'This contains the type of availability change that the Charging Station should perform.',
  );

// --- Payment Status (NotifySettlement) ---
export const paymentStatusEnum = z
  .enum(['Settled', 'Canceled', 'Rejected', 'Failed'])
  .describe('The status of the settlement attempt.');

// --- Phase (MeterValues, TransactionEvent) ---
export const phaseEnum = z
  .enum(['L1', 'L2', 'L3', 'N', 'L1-N', 'L2-N', 'L3-N', 'L1-L2', 'L2-L3', 'L3-L1'])
  .describe('Indicates how the measured value is to be interpreted');

// --- Power During Cessation (DER grid fault parameters) ---
export const powerDuringCessationEnum = z
  .enum(['Active', 'Reactive'])
  .describe(
    'Parameter is only sent, if the EV has to feed-in power or reactive power during fault-ride throug...',
  );

// --- Preconditioning Status (TransactionEvent) ---
export const preconditioningStatusEnum = z
  .enum(['Unknown', 'Ready', 'NotReady', 'Preconditioning'])
  .describe('The current preconditioning status of the BMS in the EV');

// --- Priority Charging Status (PriorityCharging) ---
export const priorityChargingStatusEnum = z
  .enum(['Accepted', 'Rejected', 'NoProfile'])
  .describe('Result of the request.');

// --- Publish Firmware Status (PublishFirmwareStatusNotification) ---
export const publishFirmwareStatusEnum = z
  .enum([
    'Idle',
    'DownloadScheduled',
    'Downloading',
    'Downloaded',
    'Published',
    'DownloadFailed',
    'DownloadPaused',
    'InvalidChecksum',
    'ChecksumVerified',
    'PublishFailed',
  ])
  .describe('This contains the progress status of the publishfirmware installation.');

// --- Reading Context (MeterValues, TransactionEvent) ---
export const readingContextEnum = z
  .enum([
    'Interruption.Begin',
    'Interruption.End',
    'Other',
    'Sample.Clock',
    'Sample.Periodic',
    'Transaction.Begin',
    'Transaction.End',
    'Trigger',
  ])
  .describe('Type of detail value: start, end or sample');

// --- Stop Reason (TransactionEvent) ---
export const reasonEnum = z
  .enum([
    'DeAuthorized',
    'EmergencyStop',
    'EnergyLimitReached',
    'EVDisconnected',
    'GroundFault',
    'ImmediateReset',
    'MasterPass',
    'Local',
    'LocalOutOfCredit',
    'Other',
    'OvercurrentFault',
    'PowerLoss',
    'PowerQuality',
    'Reboot',
    'Remote',
    'SOCLimitReached',
    'StoppedByEV',
    'TimeLimitReached',
    'Timeout',
    'ReqEnergyTransferRejected',
  ])
  .describe(
    'The _stoppedReason_ is the reason/event that initiated the process of stopping the transaction',
  );

// --- Recurrency Kind (SetChargingProfile) ---
export const recurrencyKindEnum = z
  .enum(['Daily', 'Weekly'])
  .describe('Indicates the start point of a recurrence.');

// --- Registration Status (BootNotification) ---
export const registrationStatusEnum = z
  .enum(['Accepted', 'Pending', 'Rejected'])
  .describe('This contains whether the Charging Station has been registered within the CSMS.');

// --- Report Base (GetBaseReport) ---
export const reportBaseEnum = z
  .enum(['ConfigurationInventory', 'FullInventory', 'SummaryInventory'])
  .describe('This field specifies the report base.');

// --- Request Start/Stop Status (RequestStartTransaction, RequestStopTransaction) ---
export const requestStartStopStatusEnum = z
  .enum(['Accepted', 'Rejected'])
  .describe(
    'Status indicating whether the Charging Station accepts the request to start a transaction.',
  );

// --- Reservation Update Status (ReservationStatusUpdate) ---
export const reservationUpdateStatusEnum = z
  .enum(['Expired', 'Removed', 'NoTransaction'])
  .describe('The updated reservation status.');

// --- Reserve Now Status (ReserveNow) ---
export const reserveNowStatusEnum = z
  .enum(['Accepted', 'Faulted', 'Occupied', 'Rejected', 'Unavailable'])
  .describe('This indicates the success or failure of the reservation.');

// --- Reset Type (Reset) ---
export const resetEnum = z
  .enum(['Immediate', 'OnIdle', 'ImmediateAndResume'])
  .describe('This contains the type of reset that the Charging Station or EVSE should perform.');

// --- Reset Status (Reset) ---
export const resetStatusEnum = z
  .enum(['Accepted', 'Rejected', 'Scheduled'])
  .describe('This indicates whether the Charging Station is able to perform the reset.');

// --- Send Local List Status (SendLocalList) ---
export const sendLocalListStatusEnum = z
  .enum(['Accepted', 'Failed', 'VersionMismatch'])
  .describe(
    'This indicates whether the Charging Station has successfully received and applied the update of t...',
  );

// --- Set Monitoring Status (SetVariableMonitoring) ---
export const setMonitoringStatusEnum = z
  .enum([
    'Accepted',
    'UnknownComponent',
    'UnknownVariable',
    'UnsupportedMonitorType',
    'Rejected',
    'Duplicate',
  ])
  .describe('Status is OK if a value could be returned');

// --- Set Network Profile Status (SetNetworkProfile) ---
export const setNetworkProfileStatusEnum = z
  .enum(['Accepted', 'Rejected', 'Failed'])
  .describe('Result of operation.');

// --- Set Variable Status (SetVariables) ---
export const setVariableStatusEnum = z
  .enum([
    'Accepted',
    'Rejected',
    'UnknownComponent',
    'UnknownVariable',
    'NotSupportedAttributeType',
    'RebootRequired',
  ])
  .describe('Result status of setting the variable.');

// --- Tariff Change Status (ChangeTransactionTariff) ---
export const tariffChangeStatusEnum = z
  .enum([
    'Accepted',
    'Rejected',
    'TooManyElements',
    'ConditionNotSupported',
    'TxNotFound',
    'NoCurrencyChange',
  ])
  .describe('Status of the operation');

// --- Tariff Clear Status (ClearTariffs) ---
export const tariffClearStatusEnum = z.enum(['Accepted', 'Rejected', 'NoTariff']);

// --- Tariff Cost Type (TransactionEvent running cost) ---
export const tariffCostEnum = z
  .enum(['NormalCost', 'MinCost', 'MaxCost'])
  .describe('Type of cost: normal or the minimum or maximum cost.');

// --- Tariff Get Status (GetTariffs) ---
export const tariffGetStatusEnum = z
  .enum(['Accepted', 'Rejected', 'NoTariff'])
  .describe('Status of operation');

// --- Tariff Kind (SetDefaultTariff, SetDriverTariff) ---
export const tariffKindEnum = z
  .enum(['DefaultTariff', 'DriverTariff'])
  .describe('Kind of tariff (driver/default)');

// --- Tariff Set Status (SetDefaultTariff, SetDriverTariff) ---
export const tariffSetStatusEnum = z.enum([
  'Accepted',
  'Rejected',
  'TooManyElements',
  'ConditionNotSupported',
  'DuplicateTariffId',
]);

// --- Transaction Event Type (TransactionEvent) ---
export const transactionEventEnum = z
  .enum(['Ended', 'Started', 'Updated'])
  .describe('This contains the type of this event');

// --- Trigger Message Status (TriggerMessage) ---
export const triggerMessageStatusEnum = z
  .enum(['Accepted', 'Rejected', 'NotImplemented'])
  .describe('Indicates whether the Charging Station will send the requested notification or not.');

// --- Trigger Reason (TransactionEvent) ---
export const triggerReasonEnum = z
  .enum([
    'AbnormalCondition',
    'Authorized',
    'CablePluggedIn',
    'ChargingRateChanged',
    'ChargingStateChanged',
    'CostLimitReached',
    'Deauthorized',
    'EnergyLimitReached',
    'EVCommunicationLost',
    'EVConnectTimeout',
    'EVDeparted',
    'EVDetected',
    'LimitSet',
    'MeterValueClock',
    'MeterValuePeriodic',
    'OperationModeChanged',
    'RemoteStart',
    'RemoteStop',
    'ResetCommand',
    'RunningCost',
    'SignedDataReceived',
    'SoCLimitReached',
    'StopAuthorized',
    'TariffChanged',
    'TariffNotAccepted',
    'TimeLimitReached',
    'Trigger',
    'TxResumed',
    'UnlockCommand',
  ])
  .describe('Reason the Charging Station sends this message to the CSMS');

// --- Unlock Status (UnlockConnector) ---
export const unlockStatusEnum = z
  .enum(['Unlocked', 'UnlockFailed', 'OngoingAuthorizedTransaction', 'UnknownConnector'])
  .describe('This indicates whether the Charging Station has unlocked the connector.');

// --- Unpublish Firmware Status (UnpublishFirmware) ---
export const unpublishFirmwareStatusEnum = z
  .enum(['DownloadOngoing', 'NoFirmware', 'Unpublished'])
  .describe('Indicates whether the Local Controller succeeded in unpublishing the firmware.');

// --- Update Type (SendLocalList) ---
export const updateEnum = z
  .enum(['Differential', 'Full'])
  .describe('This contains the type of update (full or differential) of this request.');

// --- Update Firmware Status (UpdateFirmware) ---
export const updateFirmwareStatusEnum = z
  .enum(['Accepted', 'Rejected', 'AcceptedCanceled', 'InvalidCertificate', 'RevokedCertificate'])
  .describe('This field indicates whether the Charging Station was able to accept the request.');

// --- Upload Log Status (LogStatusNotification) ---
export const uploadLogStatusEnum = z
  .enum([
    'BadMessage',
    'Idle',
    'NotSupportedOperation',
    'PermissionDenied',
    'Uploaded',
    'UploadFailure',
    'Uploading',
    'AcceptedCanceled',
  ])
  .describe('This contains the status of the log upload.');

// --- VPN Type (SetNetworkProfile) ---
export const vpnEnum = z.enum(['IKEv2', 'IPSec', 'L2TP', 'PPTP']).describe('Type of VPN');

// ============================================================
// Object Types (topologically sorted, dependencies first)
// ============================================================

// --- AC Charging Parameters (NotifyEVChargingNeeds, ISO 15118-2) ---
export const acChargingParametersType = z
  .object({
    energyAmount: z.number().describe('Amount of energy requested (in Wh)'),
    evMinCurrent: z
      .number()
      .describe('Minimum current (amps) supported by the electric vehicle (per phase)'),
    evMaxCurrent: z
      .number()
      .describe('Maximum current (amps) supported by the electric vehicle (per phase)'),
    evMaxVoltage: z.number().describe('Maximum voltage supported by the electric vehicle'),
  })
  .passthrough()
  .describe('EV AC charging parameters for ISO 15118-2');

// --- APN Configuration (SetNetworkProfile) ---
export const apnType = z
  .object({
    apn: z.string().describe('The Access Point Name as an URL.'),
    apnUserName: z.string().optional().describe('APN username.'),
    apnPassword: z.string().optional().describe('APN Password.'),
    simPin: z.number().int().optional().describe('SIM card pin code.'),
    preferredNetwork: z
      .string()
      .optional()
      .describe('Preferred network, written as MCC and MNC concatenated'),
    useOnlyPreferredNetwork: z.boolean().optional().describe('Default: false'),
    apnAuthentication: apnAuthenticationEnum,
  })
  .passthrough()
  .describe(
    'Collection of configuration data needed to make a data-connection over a cellular network',
  );

// --- Rational Number (ISO 15118-20 price schedules) ---
export const rationalNumberType = z
  .object({
    exponent: z.number().int().describe('The exponent to base 10 (dec)'),
    value: z.number().int().describe('Value which shall be multiplied.'),
  })
  .passthrough()
  .describe('Part of ISO 15118-20 price schedule.');

// --- Price Rule (ISO 15118-20 price schedules) ---
export const priceRuleType = z
  .object({
    parkingFeePeriod: z
      .number()
      .int()
      .optional()
      .describe('The duration of the parking fee period (in seconds)'),
    carbonDioxideEmission: z.number().int().optional().describe('Number of grams of CO2 per kWh.'),
    renewableGenerationPercentage: z
      .number()
      .int()
      .optional()
      .describe('Percentage of the power that is created by renewable resources.'),
    energyFee: rationalNumberType,
    parkingFee: rationalNumberType.optional(),
    powerRangeStart: rationalNumberType,
  })
  .passthrough()
  .describe('Part of ISO 15118-20 price schedule.');

// --- Price Rule Stack (ISO 15118-20 price schedules) ---
export const priceRuleStackType = z
  .object({
    duration: z.number().int().describe('Duration of the stack of price rules'),
    priceRule: z.array(priceRuleType),
  })
  .passthrough()
  .describe('Part of ISO 15118-20 price schedule.');

// --- Tax Rule (ISO 15118-20 price schedules) ---
export const taxRuleType = z
  .object({
    taxRuleID: z.number().int().describe('Id for the tax rule.'),
    taxRuleName: z.string().optional().describe('Human readable string to identify the tax rule.'),
    taxIncludedInPrice: z
      .boolean()
      .optional()
      .describe('Indicates whether the tax is included in any price or not.'),
    appliesToEnergyFee: z.boolean().describe('Indicates whether this tax applies to Energy Fees.'),
    appliesToParkingFee: z
      .boolean()
      .describe('Indicates whether this tax applies to Parking Fees.'),
    appliesToOverstayFee: z
      .boolean()
      .describe('Indicates whether this tax applies to Overstay Fees.'),
    appliesToMinimumMaximumCost: z
      .boolean()
      .describe('Indicates whether this tax applies to Minimum/Maximum Cost.'),
    taxRate: rationalNumberType,
  })
  .passthrough()
  .describe('Part of ISO 15118-20 price schedule.');

// --- Overstay Rule (ISO 15118-20 price schedules) ---
export const overstayRuleType = z
  .object({
    overstayFee: rationalNumberType,
    overstayRuleDescription: z
      .string()
      .optional()
      .describe('Human readable string to identify the overstay rule.'),
    startTime: z
      .number()
      .int()
      .describe(
        'Time in seconds after trigger of the parent Overstay Rules for this particular fee to apply.',
      ),
    overstayFeePeriod: z.number().int().describe('Time till overstay will be reapplied'),
  })
  .passthrough()
  .describe('Part of ISO 15118-20 price schedule.');

// --- Overstay Rule List (ISO 15118-20 price schedules) ---
export const overstayRuleListType = z
  .object({
    overstayPowerThreshold: rationalNumberType.optional(),
    overstayRule: z.array(overstayRuleType),
    overstayTimeThreshold: z
      .number()
      .int()
      .optional()
      .describe('Time till overstay is applied in seconds.'),
  })
  .passthrough()
  .describe('Part of ISO 15118-20 price schedule.');

// --- Additional Selected Services (ISO 15118-20 price schedules) ---
export const additionalSelectedServicesType = z
  .object({
    serviceFee: rationalNumberType,
    serviceName: z.string().describe('Human readable string to identify this service.'),
  })
  .passthrough()
  .describe('Part of ISO 15118-20 price schedule.');

// --- Absolute Price Schedule (ISO 15118-20 price schedules) ---
export const absolutePriceScheduleType = z
  .object({
    timeAnchor: z.string().describe('Starting point of price schedule.'),
    priceScheduleID: z.number().int().describe('Unique ID of price schedule'),
    priceScheduleDescription: z.string().optional().describe('Description of the price schedule.'),
    currency: z.string().describe('Currency according to ISO 4217.'),
    language: z
      .string()
      .describe(
        'String that indicates what language is used for the human readable strings in the price schedule',
      ),
    priceAlgorithm: z
      .string()
      .describe(
        'A string in URN notation which shall uniquely identify an algorithm that defines how to compute a...',
      ),
    minimumCost: rationalNumberType.optional(),
    maximumCost: rationalNumberType.optional(),
    priceRuleStacks: z.array(priceRuleStackType),
    taxRules: z.array(taxRuleType).optional(),
    overstayRuleList: overstayRuleListType.optional(),
    additionalSelectedServices: z.array(additionalSelectedServicesType).optional(),
  })
  .passthrough()
  .describe(
    'The AbsolutePriceScheduleType is modeled after the same type that is defined in ISO 15118-20, suc...',
  );

// --- Additional Info (shared: Authorize, TransactionEvent) ---
export const additionalInfoType = z
  .object({
    additionalIdToken: z.string().describe('This field specifies the additional IdToken.'),
    type: z
      .string()
      .describe(
        '_additionalInfo_ can be used to send extra information to CSMS in addition to the regular authori...',
      ),
  })
  .passthrough()
  .describe(
    'Contains a case insensitive identifier to use for the authorization and the type of authorization...',
  );

// --- Address (NotifySettlement) ---
export const addressType = z
  .object({
    name: z.string().describe('Name of person/company'),
    address1: z.string().describe('Address line 1'),
    address2: z.string().optional().describe('Address line 2'),
    city: z.string().describe('City'),
    postalCode: z.string().optional().describe('Postal code'),
    country: z.string().describe('Country name'),
  })
  .passthrough()
  .describe('A generic address format.');

// --- ID Token (shared: Authorize, TransactionEvent, ReserveNow, RequestStartTransaction, SendLocalList) ---
export const idTokenType = z
  .object({
    additionalInfo: z.array(additionalInfoType).optional(),
    idToken: z.string().describe('IdToken is case insensitive'),
    type: z.string().describe('Enumeration of possible idToken types'),
  })
  .passthrough()
  .describe(
    'Contains a case insensitive identifier to use for the authorization and the type of authorization...',
  );

// --- Message Content (SetDisplayMessage, Authorize) ---
export const messageContentType = z
  .object({
    format: messageFormatEnum,
    language: z.string().optional().describe('Message language identifier'),
    content: z.string().describe('Required'),
  })
  .passthrough()
  .describe('Contains message details, for a message to be displayed on a Charging Station.');

// --- ID Token Info (shared: Authorize, TransactionEvent, RequestStartTransaction) ---
export const idTokenInfoType = z
  .object({
    status: authorizationStatusEnum,
    cacheExpiryDateTime: z
      .string()
      .optional()
      .describe('Date and Time after which the token must be considered invalid.'),
    chargingPriority: z
      .number()
      .int()
      .optional()
      .describe('Priority from a business point of view'),
    groupIdToken: idTokenType.optional(),
    language1: z
      .string()
      .optional()
      .describe('Preferred user interface language of identifier user'),
    language2: z
      .string()
      .optional()
      .describe('Second preferred user interface language of identifier user'),
    evseId: z
      .array(z.number().int())
      .optional()
      .describe(
        'Only used when the IdToken is only valid for one or more specific EVSEs, not for the entire Charg...',
      ),
    personalMessage: messageContentType.optional(),
  })
  .passthrough()
  .describe('Contains status information about an identifier');

// --- Authorization Data (SendLocalList) ---
export const authorizationData = z
  .object({
    idToken: idTokenType,
    idTokenInfo: idTokenInfoType.optional(),
  })
  .passthrough()
  .describe('Contains the identifier to use for authorization.');

// --- Battery Data (BatterySwap) ---
export const batteryDataType = z
  .object({
    evseId: z.number().int().describe('Slot number where battery is inserted or removed.'),
    serialNumber: z.string().describe('Serial number of battery.'),
    soC: z.number().describe('State of charge'),
    soH: z.number().describe('State of health'),
    productionDate: z.string().optional().describe('Production date of battery.'),
    vendorInfo: z
      .string()
      .optional()
      .describe('Vendor-specific info from battery in undefined format.'),
  })
  .passthrough();

// --- Certificate Hash Data (shared: DeleteCertificate, GetInstalledCertificateIds, GetCertificateStatus) ---
export const certificateHashDataType = z
  .object({
    hashAlgorithm: hashAlgorithmEnum,
    issuerNameHash: z
      .string()
      .describe(
        'The hash of the issuer’s distinguished name (DN), that must be calculated over the DER encoding o...',
      ),
    issuerKeyHash: z
      .string()
      .describe(
        'The hash of the DER encoded public key: the value (excluding tag and length) of the subject publi...',
      ),
    serialNumber: z
      .string()
      .describe(
        'The string representation of the hexadecimal value of the serial number without the prefix "0x" a...',
      ),
  })
  .passthrough();

// --- Certificate Hash Data Chain (GetInstalledCertificateIds) ---
export const certificateHashDataChainType = z
  .object({
    certificateHashData: certificateHashDataType,
    certificateType: getCertificateIdUseEnum,
    childCertificateHashData: z.array(certificateHashDataType).optional(),
  })
  .passthrough();

// --- Certificate Status Request Info (GetCertificateChainStatus) ---
export const certificateStatusRequestInfoType = z
  .object({
    certificateHashData: certificateHashDataType,
    source: certificateStatusSourceEnum,
    urls: z.array(z.string()).describe('URL(s) of _source_.'),
  })
  .passthrough()
  .describe('Data necessary to request the revocation status of a certificate.');

// --- Certificate Status (GetCertificateChainStatus) ---
export const certificateStatusType = z
  .object({
    certificateHashData: certificateHashDataType,
    source: certificateStatusSourceEnum,
    status: certificateStatusEnum,
    nextUpdate: z.string(),
  })
  .passthrough()
  .describe('Revocation status of certificate');

// --- Charging Limit (NotifyChargingLimit, ReportChargingProfiles) ---
export const chargingLimitType = z
  .object({
    chargingLimitSource: z.string().describe('Represents the source of the charging limit'),
    isLocalGeneration: z
      .boolean()
      .optional()
      .describe(
        'True when the reported limit concerns local generation that is providing extra capacity, instead ...',
      ),
    isGridCritical: z
      .boolean()
      .optional()
      .describe('Indicates whether the charging limit is critical for the grid.'),
  })
  .passthrough();

// --- DER Charging Parameters (NotifyEVChargingNeeds, ISO 15118-20) ---
export const derChargingParametersType = z
  .object({
    evSupportedDERControl: z
      .array(derControlEnum)
      .optional()
      .describe('DER control functions supported by EV'),
    evOverExcitedMaxDischargePower: z
      .number()
      .optional()
      .describe(
        'Rated maximum injected active power by EV, at specified over-excited power factor (overExcitedPow...',
      ),
    evOverExcitedPowerFactor: z
      .number()
      .optional()
      .describe('EV power factor when injecting (over excited) the minimum reactive power'),
    evUnderExcitedMaxDischargePower: z
      .number()
      .optional()
      .describe(
        'Rated maximum injected active power by EV supported at specified under-excited power factor (EVUn...',
      ),
    evUnderExcitedPowerFactor: z
      .number()
      .optional()
      .describe('EV power factor when injecting (under excited) the minimum reactive power'),
    maxApparentPower: z
      .number()
      .optional()
      .describe('Rated maximum total apparent power, defined by min(EV, EVSE) in va'),
    maxChargeApparentPower: z
      .number()
      .optional()
      .describe('Rated maximum absorbed apparent power, defined by min(EV, EVSE) in va'),
    maxChargeApparentPower_L2: z
      .number()
      .optional()
      .describe(
        'Rated maximum absorbed apparent power on phase L2, defined by min(EV, EVSE) in va',
      ),
    maxChargeApparentPower_L3: z
      .number()
      .optional()
      .describe(
        'Rated maximum absorbed apparent power on phase L3, defined by min(EV, EVSE) in va',
      ),
    maxDischargeApparentPower: z
      .number()
      .optional()
      .describe('Rated maximum injected apparent power, defined by min(EV, EVSE) in va'),
    maxDischargeApparentPower_L2: z
      .number()
      .optional()
      .describe(
        'Rated maximum injected apparent power on phase L2, defined by min(EV, EVSE) in va',
      ),
    maxDischargeApparentPower_L3: z
      .number()
      .optional()
      .describe(
        'Rated maximum injected apparent power on phase L3, defined by min(EV, EVSE) in va',
      ),
    maxChargeReactivePower: z
      .number()
      .optional()
      .describe('Rated maximum absorbed reactive power, defined by min(EV, EVSE), in vars'),
    maxChargeReactivePower_L2: z
      .number()
      .optional()
      .describe(
        'Rated maximum absorbed reactive power, defined by min(EV, EVSE), in vars on phase L2',
      ),
    maxChargeReactivePower_L3: z
      .number()
      .optional()
      .describe(
        'Rated maximum absorbed reactive power, defined by min(EV, EVSE), in vars on phase L3',
      ),
    minChargeReactivePower: z
      .number()
      .optional()
      .describe('Rated minimum absorbed reactive power, defined by max(EV, EVSE), in vars'),
    minChargeReactivePower_L2: z
      .number()
      .optional()
      .describe(
        'Rated minimum absorbed reactive power, defined by max(EV, EVSE), in vars on phase L2',
      ),
    minChargeReactivePower_L3: z
      .number()
      .optional()
      .describe(
        'Rated minimum absorbed reactive power, defined by max(EV, EVSE), in vars on phase L3',
      ),
    maxDischargeReactivePower: z
      .number()
      .optional()
      .describe('Rated maximum injected reactive power, defined by min(EV, EVSE), in vars'),
    maxDischargeReactivePower_L2: z
      .number()
      .optional()
      .describe(
        'Rated maximum injected reactive power, defined by min(EV, EVSE), in vars on phase L2',
      ),
    maxDischargeReactivePower_L3: z
      .number()
      .optional()
      .describe(
        'Rated maximum injected reactive power, defined by min(EV, EVSE), in vars on phase L3',
      ),
    minDischargeReactivePower: z
      .number()
      .optional()
      .describe('Rated minimum injected reactive power, defined by max(EV, EVSE), in vars'),
    minDischargeReactivePower_L2: z
      .number()
      .optional()
      .describe(
        'Rated minimum injected reactive power, defined by max(EV, EVSE), in var on phase L2',
      ),
    minDischargeReactivePower_L3: z
      .number()
      .optional()
      .describe(
        'Rated minimum injected reactive power, defined by max(EV, EVSE), in var on phase L3',
      ),
    nominalVoltage: z.number().optional().describe('Line voltage supported by EVSE and EV'),
    nominalVoltageOffset: z
      .number()
      .optional()
      .describe(
        "The nominal AC voltage (rms) offset between the Charging Station's electrical connection point an...",
      ),
    maxNominalVoltage: z
      .number()
      .optional()
      .describe('Maximum AC rms voltage, as defined by min(EV, EVSE) to operate with'),
    minNominalVoltage: z
      .number()
      .optional()
      .describe('Minimum AC rms voltage, as defined by max(EV, EVSE) to operate with'),
    evInverterManufacturer: z.string().optional().describe('Manufacturer of the EV inverter'),
    evInverterModel: z.string().optional().describe('Model name of the EV inverter'),
    evInverterSerialNumber: z.string().optional().describe('Serial number of the EV inverter'),
    evInverterSwVersion: z.string().optional().describe('Software version of EV inverter'),
    evInverterHwVersion: z.string().optional().describe('Hardware version of EV inverter'),
    evIslandingDetectionMethod: z
      .array(islandingDetectionEnum)
      .optional()
      .describe('Type of islanding detection method'),
    evIslandingTripTime: z
      .number()
      .optional()
      .describe('Time after which EV will trip if an island has been detected'),
    evMaximumLevel1DCInjection: z
      .number()
      .optional()
      .describe('Maximum injected DC current allowed at level 1 charging'),
    evDurationLevel1DCInjection: z
      .number()
      .optional()
      .describe('Maximum allowed duration of DC injection at level 1 charging'),
    evMaximumLevel2DCInjection: z
      .number()
      .optional()
      .describe('Maximum injected DC current allowed at level 2 charging'),
    evDurationLevel2DCInjection: z
      .number()
      .optional()
      .describe('Maximum allowed duration of DC injection at level 2 charging'),
    evReactiveSusceptance: z
      .number()
      .optional()
      .describe('Measure of the susceptibility of the circuit to reactance, in Siemens (S)'),
    evSessionTotalDischargeEnergyAvailable: z
      .number()
      .optional()
      .describe(
        'Total energy value, in Wh, that EV is allowed to provide during the entire V2G session',
      ),
  })
  .passthrough()
  .describe(
    'DERChargingParametersType is used in ChargingNeedsType during an ISO 15118-20 session for AC_BPT_...',
  );

// --- EV Price Rule (NotifyEVChargingNeeds, V2X discharge pricing) ---
export const evPriceRuleType = z
  .object({
    energyFee: z.number().describe('Cost per kWh.'),
    powerRangeStart: z
      .number()
      .describe(
        'The EnergyFee applies between this value and the value of the PowerRangeStart of the subsequent E...',
      ),
  })
  .passthrough()
  .describe('An entry in price schedule over time for which EV is willing to discharge.');

// --- EV Absolute Price Schedule Entry (NotifyEVChargingNeeds) ---
export const evAbsolutePriceScheduleEntryType = z
  .object({
    duration: z.number().int().describe('The amount of seconds of this entry.'),
    evPriceRule: z.array(evPriceRuleType),
  })
  .passthrough()
  .describe('An entry in price schedule over time for which EV is willing to discharge.');

// --- EV Absolute Price Schedule (NotifyEVChargingNeeds) ---
export const evAbsolutePriceScheduleType = z
  .object({
    timeAnchor: z.string().describe('Starting point in time of the EVEnergyOffer.'),
    currency: z.string().describe('Currency code according to ISO 4217.'),
    evAbsolutePriceScheduleEntries: z.array(evAbsolutePriceScheduleEntryType),
    priceAlgorithm: z
      .string()
      .describe('ISO 15118-20 URN of price algorithm: Power, PeakPower, StackedEnergy.'),
  })
  .passthrough()
  .describe('Price schedule of EV energy offer.');

// --- EV Power Schedule Entry (NotifyEVChargingNeeds) ---
export const evPowerScheduleEntryType = z
  .object({
    duration: z.number().int().describe('The duration of this entry.'),
    power: z
      .number()
      .describe(
        'Defines maximum amount of power for the duration of this EVPowerScheduleEntry to be discharged fr...',
      ),
  })
  .passthrough()
  .describe('An entry in schedule of the energy amount over time that EV is willing to discharge');

// --- EV Power Schedule (NotifyEVChargingNeeds) ---
export const evPowerScheduleType = z
  .object({
    evPowerScheduleEntries: z.array(evPowerScheduleEntryType),
    timeAnchor: z
      .string()
      .describe('The time that defines the starting point for the EVEnergyOffer.'),
  })
  .passthrough()
  .describe('Schedule of EV energy offer.');

// --- EV Energy Offer (NotifyEVChargingNeeds, V2X) ---
export const evEnergyOfferType = z
  .object({
    evAbsolutePriceSchedule: evAbsolutePriceScheduleType.optional(),
    evPowerSchedule: evPowerScheduleType,
  })
  .passthrough()
  .describe('A schedule of the energy amount over time that EV is willing to discharge');

// --- DC Charging Parameters (NotifyEVChargingNeeds, ISO 15118-2) ---
export const dcChargingParametersType = z
  .object({
    evMaxCurrent: z.number().describe('Maximum current (in A) supported by the electric vehicle'),
    evMaxVoltage: z.number().describe('Maximum voltage supported by the electric vehicle'),
    evMaxPower: z
      .number()
      .optional()
      .describe('Maximum power (in W) supported by the electric vehicle'),
    evEnergyCapacity: z
      .number()
      .optional()
      .describe('Capacity of the electric vehicle battery (in Wh)'),
    energyAmount: z.number().optional().describe('Amount of energy requested (in Wh)'),
    stateOfCharge: z
      .number()
      .int()
      .optional()
      .describe(
        'Energy available in the battery (in percent of the battery capacity) Relates to: + *ISO 15118-2*:...',
      ),
    fullSoC: z
      .number()
      .int()
      .optional()
      .describe('Percentage of SoC at which the EV considers the battery fully charged'),
    bulkSoC: z
      .number()
      .int()
      .optional()
      .describe('Percentage of SoC at which the EV considers a fast charging process to end'),
  })
  .passthrough()
  .describe('EV DC charging parameters for ISO 15118-2');

// --- V2X Charging Parameters (NotifyEVChargingNeeds, ISO 15118-20) ---
export const v2xChargingParametersType = z
  .object({
    minChargePower: z
      .number()
      .optional()
      .describe('Minimum charge power in W, defined by max(EV, EVSE)'),
    minChargePower_L2: z
      .number()
      .optional()
      .describe('Minimum charge power on phase L2 in W, defined by max(EV, EVSE)'),
    minChargePower_L3: z
      .number()
      .optional()
      .describe('Minimum charge power on phase L3 in W, defined by max(EV, EVSE)'),
    maxChargePower: z
      .number()
      .optional()
      .describe(
        'Maximum charge (absorbed) power in W, defined by min(EV, EVSE) at unity power factor',
      ),
    maxChargePower_L2: z
      .number()
      .optional()
      .describe(
        'Maximum charge power on phase L2 in W, defined by min(EV, EVSE) Relates to: *ISO 15118-20*: BPT_A...',
      ),
    maxChargePower_L3: z
      .number()
      .optional()
      .describe(
        'Maximum charge power on phase L3 in W, defined by min(EV, EVSE) Relates to: *ISO 15118-20*: BPT_A...',
      ),
    minDischargePower: z
      .number()
      .optional()
      .describe(
        'Minimum discharge (injected) power in W, defined by max(EV, EVSE) at unity power factor',
      ),
    minDischargePower_L2: z
      .number()
      .optional()
      .describe('Minimum discharge power on phase L2 in W, defined by max(EV, EVSE)'),
    minDischargePower_L3: z
      .number()
      .optional()
      .describe('Minimum discharge power on phase L3 in W, defined by max(EV, EVSE)'),
    maxDischargePower: z
      .number()
      .optional()
      .describe(
        'Maximum discharge (injected) power in W, defined by min(EV, EVSE) at unity power factor',
      ),
    maxDischargePower_L2: z
      .number()
      .optional()
      .describe('Maximum discharge power on phase L2 in W, defined by min(EV, EVSE)'),
    maxDischargePower_L3: z
      .number()
      .optional()
      .describe('Maximum discharge power on phase L3 in W, defined by min(EV, EVSE)'),
    minChargeCurrent: z
      .number()
      .optional()
      .describe(
        'Minimum charge current in A, defined by max(EV, EVSE) Relates to: *ISO 15118-20*: BPT_DC_CPDReqEn...',
      ),
    maxChargeCurrent: z
      .number()
      .optional()
      .describe(
        'Maximum charge current in A, defined by min(EV, EVSE) Relates to: *ISO 15118-20*: BPT_DC_CPDReqEn...',
      ),
    minDischargeCurrent: z
      .number()
      .optional()
      .describe('Minimum discharge current in A, defined by max(EV, EVSE)'),
    maxDischargeCurrent: z
      .number()
      .optional()
      .describe('Maximum discharge current in A, defined by min(EV, EVSE)'),
    minVoltage: z
      .number()
      .optional()
      .describe(
        'Minimum voltage in V, defined by max(EV, EVSE) Relates to: *ISO 15118-20*: BPT_DC_CPDReqEnergyTra...',
      ),
    maxVoltage: z
      .number()
      .optional()
      .describe(
        'Maximum voltage in V, defined by min(EV, EVSE) Relates to: *ISO 15118-20*: BPT_DC_CPDReqEnergyTra...',
      ),
    evTargetEnergyRequest: z
      .number()
      .optional()
      .describe(
        'Energy to requested state of charge in Wh Relates to: *ISO 15118-20*: Dynamic/Scheduled_SEReqCont...',
      ),
    evMinEnergyRequest: z
      .number()
      .optional()
      .describe(
        'Energy to minimum allowed state of charge in Wh Relates to: *ISO 15118-20*: Dynamic/Scheduled_SER...',
      ),
    evMaxEnergyRequest: z
      .number()
      .optional()
      .describe(
        'Energy to maximum state of charge in Wh Relates to: *ISO 15118-20*: Dynamic/Scheduled_SEReqContro...',
      ),
    evMinV2XEnergyRequest: z
      .number()
      .optional()
      .describe('Energy (in Wh) to minimum state of charge for cycling (V2X) activity'),
    evMaxV2XEnergyRequest: z
      .number()
      .optional()
      .describe('Energy (in Wh) to maximum state of charge for cycling (V2X) activity'),
    targetSoC: z
      .number()
      .int()
      .optional()
      .describe('Target state of charge at departure as percentage'),
  })
  .passthrough()
  .describe(
    'Charging parameters for ISO 15118-20, also supporting V2X charging/discharging.+ All values are g...',
  );

// --- Charging Needs (NotifyEVChargingNeeds) ---
export const chargingNeedsType = z
  .object({
    acChargingParameters: acChargingParametersType.optional(),
    derChargingParameters: derChargingParametersType.optional(),
    evEnergyOffer: evEnergyOfferType.optional(),
    requestedEnergyTransfer: energyTransferModeEnum,
    dcChargingParameters: dcChargingParametersType.optional(),
    v2xChargingParameters: v2xChargingParametersType.optional(),
    availableEnergyTransfer: z
      .array(energyTransferModeEnum)
      .optional()
      .describe('Modes of energy transfer that are marked as available by EV.'),
    controlMode: controlModeEnum.optional(),
    mobilityNeedsMode: mobilityNeedsModeEnum.optional(),
    departureTime: z.string().optional().describe('Estimated departure time of the EV'),
  })
  .passthrough();

// --- Cost Dimension (TransactionEvent running cost) ---
export const costDimensionType = z
  .object({
    type: costDimensionEnum,
    volume: z
      .number()
      .describe('Volume of the dimension consumed, measured according to the dimension type.'),
  })
  .passthrough()
  .describe('Volume consumed of cost dimension.');

// --- Charging Period (TransactionEvent running cost) ---
export const chargingPeriodType = z
  .object({
    dimensions: z.array(costDimensionType).optional(),
    tariffId: z
      .string()
      .optional()
      .describe('Unique identifier of the Tariff that was used to calculate cost'),
    startPeriod: z.string().describe('Start timestamp of charging period'),
  })
  .passthrough()
  .describe(
    'A ChargingPeriodType consists of a start time, and a list of possible values that influence this ...',
  );

// --- Charging Profile Criterion (GetChargingProfiles) ---
export const chargingProfileCriterionType = z
  .object({
    chargingProfilePurpose: chargingProfilePurposeEnum.optional(),
    stackLevel: z
      .number()
      .int()
      .optional()
      .describe('Value determining level in hierarchy stack of profiles'),
    chargingProfileId: z
      .array(z.number().int())
      .optional()
      .describe('List of all the chargingProfileIds requested'),
    chargingLimitSource: z
      .array(z.string())
      .optional()
      .describe('For which charging limit sources, charging profiles SHALL be reported'),
  })
  .passthrough()
  .describe(
    'A ChargingProfileCriterionType is a filter for charging profiles to be selected by a GetChargingP...',
  );

// --- Limit at SoC (SetChargingProfile) ---
export const limitAtSoCType = z
  .object({
    soc: z
      .number()
      .int()
      .describe('The SoC value beyond which the charging rate limit should be applied.'),
    limit: z.number().describe('Charging rate limit beyond the SoC value'),
  })
  .passthrough();

// --- V2X Frequency-Watt Point (SetChargingProfile DER curves) ---
export const v2xFreqWattPointType = z
  .object({
    frequency: z.number().describe('Net frequency in Hz.'),
    power: z
      .number()
      .describe('Power in W to charge (positive) or discharge (negative) at specified frequency.'),
  })
  .passthrough()
  .describe('A point of a frequency-watt curve.');

// --- V2X Signal-Watt Point (SetChargingProfile DER curves) ---
export const v2xSignalWattPointType = z
  .object({
    signal: z.number().int().describe('Signal value from an AFRRSignalRequest.'),
    power: z
      .number()
      .describe('Power in W to charge (positive) or discharge (negative) at specified frequency.'),
  })
  .passthrough()
  .describe('A point of a signal-watt curve.');

// --- Charging Schedule Period (SetChargingProfile, NotifyEVChargingSchedule) ---
export const chargingSchedulePeriodType = z
  .object({
    startPeriod: z
      .number()
      .int()
      .describe('Start of the period, in seconds from the start of schedule'),
    limit: z
      .number()
      .optional()
      .describe(
        'Optional only when not required by the _operationMode_, as in CentralSetpoint, ExternalSetpoint, ...',
      ),
    limit_L2: z
      .number()
      .optional()
      .describe('Charging rate limit on phase L2 in the applicable _chargingRateUnit_.'),
    limit_L3: z
      .number()
      .optional()
      .describe('Charging rate limit on phase L3 in the applicable _chargingRateUnit_.'),
    numberPhases: z
      .number()
      .int()
      .optional()
      .describe('The number of phases that can be used for charging'),
    phaseToUse: z
      .number()
      .int()
      .optional()
      .describe(
        'Values: 1..3, Used if numberPhases=1 and if the EVSE is capable of switching the phase connected ...',
      ),
    dischargeLimit: z
      .number()
      .optional()
      .describe('Limit in _chargingRateUnit_ that the EV is allowed to discharge with'),
    dischargeLimit_L2: z
      .number()
      .optional()
      .describe(
        'Limit in _chargingRateUnit_ on phase L2 that the EV is allowed to discharge with.',
      ),
    dischargeLimit_L3: z
      .number()
      .optional()
      .describe(
        'Limit in _chargingRateUnit_ on phase L3 that the EV is allowed to discharge with.',
      ),
    setpoint: z
      .number()
      .optional()
      .describe('Setpoint in _chargingRateUnit_ that the EV should follow as close as possible'),
    setpoint_L2: z
      .number()
      .optional()
      .describe(
        'Setpoint in _chargingRateUnit_ that the EV should follow on phase L2 as close as possible.',
      ),
    setpoint_L3: z
      .number()
      .optional()
      .describe(
        'Setpoint in _chargingRateUnit_ that the EV should follow on phase L3 as close as possible.',
      ),
    setpointReactive: z
      .number()
      .optional()
      .describe(
        'Setpoint for reactive power (or current) in _chargingRateUnit_ that the EV should follow as close...',
      ),
    setpointReactive_L2: z
      .number()
      .optional()
      .describe(
        'Setpoint for reactive power (or current) in _chargingRateUnit_ that the EV should follow on phase...',
      ),
    setpointReactive_L3: z
      .number()
      .optional()
      .describe(
        'Setpoint for reactive power (or current) in _chargingRateUnit_ that the EV should follow on phase...',
      ),
    preconditioningRequest: z
      .boolean()
      .optional()
      .describe(
        'If true, the EV should attempt to keep the BMS preconditioned for this time interval.',
      ),
    evseSleep: z
      .boolean()
      .optional()
      .describe(
        'If true, the EVSE must turn off power electronics/modules associated with this transaction',
      ),
    v2xBaseline: z
      .number()
      .optional()
      .describe(
        'Power value that, when present, is used as a baseline on top of which values from _v2xFreqWattCur...',
      ),
    operationMode: operationModeEnum.optional(),
    v2xFreqWattCurve: z.array(v2xFreqWattPointType).optional(),
    v2xSignalWattCurve: z.array(v2xSignalWattPointType).optional(),
  })
  .passthrough()
  .describe('Charging schedule period structure defines a time period in a charging schedule');

// --- Relative Time Interval (Sales tariff entries) ---
export const relativeTimeIntervalType = z
  .object({
    start: z.number().int().describe('Start of the interval, in seconds from NOW.'),
    duration: z.number().int().optional().describe('Duration of the interval, in seconds.'),
  })
  .passthrough();

// --- Cost (Sales tariff consumption cost) ---
export const costType = z
  .object({
    costKind: costKindEnum,
    amount: z.number().int().describe('The estimated or actual cost per kWh'),
    amountMultiplier: z
      .number()
      .int()
      .optional()
      .describe('Values: -3..3, The amountMultiplier defines the exponent to base 10 (dec)'),
  })
  .passthrough();

// --- Consumption Cost (Sales tariff entries) ---
export const consumptionCostType = z
  .object({
    startValue: z
      .number()
      .describe(
        'The lowest level of consumption that defines the starting point of this consumption block',
      ),
    cost: z.array(costType),
  })
  .passthrough();

// --- Sales Tariff Entry (SetChargingProfile) ---
export const salesTariffEntryType = z
  .object({
    relativeTimeInterval: relativeTimeIntervalType,
    ePriceLevel: z
      .number()
      .int()
      .optional()
      .describe('Defines the price level of this SalesTariffEntry (referring to NumEPriceLevels)'),
    consumptionCost: z.array(consumptionCostType).optional(),
  })
  .passthrough();

// --- Sales Tariff (SetChargingProfile) ---
export const salesTariffType = z
  .object({
    id: z.number().int().describe('SalesTariff identifier used to identify one sales tariff'),
    salesTariffDescription: z
      .string()
      .optional()
      .describe('A human readable title/short description of the sales tariff e.g'),
    numEPriceLevels: z
      .number()
      .int()
      .optional()
      .describe(
        'Defines the overall number of distinct price levels used across all provided SalesTariff elements.',
      ),
    salesTariffEntry: z.array(salesTariffEntryType),
  })
  .passthrough()
  .describe('A SalesTariff provided by a Mobility Operator (EMSP) ');

// --- Price Level Schedule Entry (ISO 15118-20 price schedules) ---
export const priceLevelScheduleEntryType = z
  .object({
    duration: z
      .number()
      .int()
      .describe(
        'The amount of seconds that define the duration of this given PriceLevelScheduleEntry.',
      ),
    priceLevel: z
      .number()
      .int()
      .describe(
        'Defines the price level of this PriceLevelScheduleEntry (referring to NumberOfPriceLevels)',
      ),
  })
  .passthrough()
  .describe('Part of ISO 15118-20 price schedule.');

// --- Price Level Schedule (ISO 15118-20 price schedules) ---
export const priceLevelScheduleType = z
  .object({
    priceLevelScheduleEntries: z.array(priceLevelScheduleEntryType),
    timeAnchor: z.string().describe('Starting point of this price schedule.'),
    priceScheduleId: z.number().int().describe('Unique ID of this price schedule.'),
    priceScheduleDescription: z.string().optional().describe('Description of the price schedule.'),
    numberOfPriceLevels: z
      .number()
      .int()
      .describe(
        'Defines the overall number of distinct price level elements used across all PriceLevelSchedules.',
      ),
  })
  .passthrough()
  .describe(
    'The PriceLevelScheduleType is modeled after the same type that is defined in ISO 15118-20, such t...',
  );

// --- Charging Schedule (SetChargingProfile, NotifyEVChargingSchedule, GetCompositeSchedule) ---
export const chargingScheduleType = z
  .object({
    id: z.number().int(),
    limitAtSoC: limitAtSoCType.optional(),
    startSchedule: z
      .string()
      .optional()
      .describe('Starting point of an absolute schedule or recurring schedule.'),
    duration: z.number().int().optional().describe('Duration of the charging schedule in seconds'),
    chargingRateUnit: chargingRateUnitEnum,
    minChargingRate: z.number().optional().describe('Minimum charging rate supported by the EV'),
    powerTolerance: z
      .number()
      .optional()
      .describe('Power tolerance when following EVPowerProfile.'),
    signatureId: z
      .number()
      .int()
      .optional()
      .describe('Id of this element for referencing in a signature.'),
    digestValue: z
      .string()
      .optional()
      .describe(
        'Base64 encoded hash (SHA256 for ISO 15118-2, SHA512 for ISO 15118-20) of the EXI price schedule e...',
      ),
    useLocalTime: z.boolean().optional().describe('Defaults to false'),
    chargingSchedulePeriod: z.array(chargingSchedulePeriodType),
    randomizedDelay: z.number().int().optional().describe('Defaults to 0'),
    salesTariff: salesTariffType.optional(),
    absolutePriceSchedule: absolutePriceScheduleType.optional(),
    priceLevelSchedule: priceLevelScheduleType.optional(),
  })
  .passthrough()
  .describe(
    'Charging schedule structure defines a list of charging periods, as used in: NotifyEVChargingSched...',
  );

// --- Charging Profile (SetChargingProfile, ReportChargingProfiles, RequestStartTransaction) ---
export const chargingProfileType = z
  .object({
    id: z.number().int().describe('Id of ChargingProfile'),
    stackLevel: z.number().int().describe('Value determining level in hierarchy stack of profiles'),
    chargingProfilePurpose: chargingProfilePurposeEnum,
    chargingProfileKind: chargingProfileKindEnum,
    recurrencyKind: recurrencyKindEnum.optional(),
    validFrom: z
      .string()
      .optional()
      .describe('Point in time at which the profile starts to be valid'),
    validTo: z.string().optional().describe('Point in time at which the profile stops to be valid'),
    transactionId: z
      .string()
      .optional()
      .describe(
        'SHALL only be included if ChargingProfilePurpose is set to TxProfile in a SetChargingProfileRequest',
      ),
    maxOfflineDuration: z
      .number()
      .int()
      .optional()
      .describe(
        'Period in seconds that this charging profile remains valid after the Charging Station has gone of...',
      ),
    chargingSchedule: z.array(chargingScheduleType),
    invalidAfterOfflineDuration: z
      .boolean()
      .optional()
      .describe(
        'When set to true this charging profile will not be valid anymore after being offline for more tha...',
      ),
    dynUpdateInterval: z
      .number()
      .int()
      .optional()
      .describe(
        'Interval in seconds after receipt of last update, when to request a profile update by sending a P...',
      ),
    dynUpdateTime: z
      .string()
      .optional()
      .describe(
        'Time at which limits or setpoints in this charging profile were last updated by a PullDynamicSche...',
      ),
    priceScheduleSignature: z
      .string()
      .optional()
      .describe('ISO 15118-20 signature for all price schedules in _chargingSchedules_'),
  })
  .passthrough()
  .describe(
    'A ChargingProfile consists of 1 to 3 ChargingSchedules with a list of ChargingSchedulePeriods, de...',
  );

// --- Charging Schedule Update (NotifyDynamicScheduleUpdate) ---
export const chargingScheduleUpdateType = z
  .object({
    limit: z
      .number()
      .optional()
      .describe(
        'Optional only when not required by the _operationMode_, as in CentralSetpoint, ExternalSetpoint, ...',
      ),
    limit_L2: z
      .number()
      .optional()
      .describe('Charging rate limit on phase L2 in the applicable _chargingRateUnit_.'),
    limit_L3: z
      .number()
      .optional()
      .describe('Charging rate limit on phase L3 in the applicable _chargingRateUnit_.'),
    dischargeLimit: z
      .number()
      .optional()
      .describe('Limit in _chargingRateUnit_ that the EV is allowed to discharge with'),
    dischargeLimit_L2: z
      .number()
      .optional()
      .describe(
        'Limit in _chargingRateUnit_ on phase L2 that the EV is allowed to discharge with.',
      ),
    dischargeLimit_L3: z
      .number()
      .optional()
      .describe(
        'Limit in _chargingRateUnit_ on phase L3 that the EV is allowed to discharge with.',
      ),
    setpoint: z
      .number()
      .optional()
      .describe('Setpoint in _chargingRateUnit_ that the EV should follow as close as possible'),
    setpoint_L2: z
      .number()
      .optional()
      .describe(
        'Setpoint in _chargingRateUnit_ that the EV should follow on phase L2 as close as possible.',
      ),
    setpoint_L3: z
      .number()
      .optional()
      .describe(
        'Setpoint in _chargingRateUnit_ that the EV should follow on phase L3 as close as possible.',
      ),
    setpointReactive: z
      .number()
      .optional()
      .describe(
        'Setpoint for reactive power (or current) in _chargingRateUnit_ that the EV should follow as close...',
      ),
    setpointReactive_L2: z
      .number()
      .optional()
      .describe(
        'Setpoint for reactive power (or current) in _chargingRateUnit_ that the EV should follow on phase...',
      ),
    setpointReactive_L3: z
      .number()
      .optional()
      .describe(
        'Setpoint for reactive power (or current) in _chargingRateUnit_ that the EV should follow on phase...',
      ),
  })
  .passthrough()
  .describe('Updates to a ChargingSchedulePeriodType for dynamic charging profiles.');

// --- Modem (BootNotification) ---
export const modemType = z
  .object({
    iccid: z.string().optional().describe('This contains the ICCID of the modem’s SIM card.'),
    imsi: z.string().optional().describe('This contains the IMSI of the modem’s SIM card.'),
  })
  .passthrough()
  .describe(
    'Defines parameters required for initiating and maintaining wireless communication with other devi...',
  );

// --- Charging Station (BootNotification) ---
export const chargingStationType = z
  .object({
    serialNumber: z.string().optional().describe('Vendor-specific device identifier.'),
    model: z.string().describe('Defines the model of the device.'),
    modem: modemType.optional(),
    vendorName: z.string().describe('Identifies the vendor (not necessarily in a unique manner).'),
    firmwareVersion: z
      .string()
      .optional()
      .describe('This contains the firmware version of the Charging Station.'),
  })
  .passthrough()
  .describe('The physical system where an Electrical Vehicle (EV) can be charged.');

// --- Clear Charging Profile (ClearChargingProfile) ---
export const clearChargingProfileType = z
  .object({
    evseId: z
      .number()
      .int()
      .optional()
      .describe('Specifies the id of the EVSE for which to clear charging profiles'),
    chargingProfilePurpose: chargingProfilePurposeEnum.optional(),
    stackLevel: z
      .number()
      .int()
      .optional()
      .describe(
        'Specifies the stackLevel for which charging profiles will be cleared, if they meet the other crit...',
      ),
  })
  .passthrough()
  .describe(
    'A ClearChargingProfileType is a filter for charging profiles to be cleared by ClearChargingProfil...',
  );

// --- Status Info (shared: many response types) ---
export const statusInfoType = z
  .object({
    reasonCode: z
      .string()
      .describe('A predefined code for the reason why the status is returned in this response'),
    additionalInfo: z
      .string()
      .optional()
      .describe('Additional text to provide detailed information.'),
  })
  .passthrough()
  .describe('Element providing more information about the status.');

// --- Clear Monitoring Result (ClearVariableMonitoring) ---
export const clearMonitoringResultType = z
  .object({
    status: clearMonitoringStatusEnum,
    id: z.number().int().describe('Id of the monitor of which a clear was requested.'),
    statusInfo: statusInfoType.optional(),
  })
  .passthrough();

// --- Clear Tariffs Result (ClearTariffs) ---
export const clearTariffsResultType = z
  .object({
    statusInfo: statusInfoType.optional(),
    tariffId: z.string().optional().describe('Id of tariff for which _status_ is reported'),
    status: tariffClearStatusEnum,
  })
  .passthrough();

// --- EVSE (shared: StatusNotification, TransactionEvent, ChangeAvailability, ReserveNow) ---
export const evseType = z
  .object({
    id: z.number().int().describe('EVSE Identifier'),
    connectorId: z
      .number()
      .int()
      .optional()
      .describe('An id to designate a specific connector (on an EVSE) by connector index number.'),
  })
  .passthrough()
  .describe('Electric Vehicle Supply Equipment');

// --- Component (shared: GetVariables, SetVariables, GetBaseReport, NotifyEvent) ---
export const componentType = z
  .object({
    evse: evseType.optional(),
    name: z.string().describe('Name of the component'),
    instance: z
      .string()
      .optional()
      .describe('Name of instance in case the component exists as multiple instances'),
  })
  .passthrough()
  .describe('A physical or logical component');

// --- Variable (shared: GetVariables, SetVariables, GetBaseReport, NotifyEvent) ---
export const variableType = z
  .object({
    name: z.string().describe('Name of the variable'),
    instance: z
      .string()
      .optional()
      .describe('Name of instance in case the variable exists as multiple instances'),
  })
  .passthrough()
  .describe('Reference key to a component-variable.');

// --- Component Variable (GetMonitoringReport, SetMonitoringBase) ---
export const componentVariableType = z
  .object({
    component: componentType,
    variable: variableType.optional(),
  })
  .passthrough()
  .describe('Class to report components, variables and variable attributes and characteristics.');

// --- Composite Schedule (GetCompositeSchedule) ---
export const compositeScheduleType = z
  .object({
    evseId: z.number().int(),
    duration: z.number().int(),
    scheduleStart: z.string(),
    chargingRateUnit: chargingRateUnitEnum,
    chargingSchedulePeriod: z.array(chargingSchedulePeriodType),
  })
  .passthrough();

// --- Periodic Event Stream Params (OpenPeriodicEventStream, NotifyPeriodicEventStream) ---
export const periodicEventStreamParamsType = z
  .object({
    interval: z
      .number()
      .int()
      .optional()
      .describe('Time in seconds after which stream data is sent.'),
    values: z.number().int().optional().describe('Number of items to be sent together in stream.'),
  })
  .passthrough();

// --- Constant Stream Data (OpenPeriodicEventStream) ---
export const constantStreamDataType = z
  .object({
    id: z.number().int().describe('Uniquely identifies the stream'),
    params: periodicEventStreamParamsType,
    variableMonitoringId: z.number().int().describe('Id of monitor used to report his event'),
  })
  .passthrough();

// --- Tax Rate (Tariff types, running cost) ---
export const taxRateType = z
  .object({
    type: z.string().describe('Type of this tax, e.g'),
    tax: z.number().describe('Tax percentage'),
    stack: z.number().int().optional().describe('Stack level for this type of tax'),
  })
  .passthrough()
  .describe('Tax percentage');

// --- Price (TransactionEvent running cost) ---
export const priceType = z
  .object({
    exclTax: z.number().optional().describe('Price/cost excluding tax'),
    inclTax: z.number().optional().describe('Price/cost including tax'),
    taxRates: z.array(taxRateType).optional(),
  })
  .passthrough()
  .describe('Price with and without tax');

// --- Total Price (TransactionEvent running cost) ---
export const totalPriceType = z
  .object({
    exclTax: z.number().optional().describe('Price/cost excluding tax'),
    inclTax: z.number().optional().describe('Price/cost including tax'),
  })
  .passthrough()
  .describe('Total cost with and without tax');

// --- Total Cost (TransactionEvent running cost) ---
export const totalCostType = z
  .object({
    currency: z.string().describe('Currency of the costs in ISO 4217 Code.'),
    typeOfCost: tariffCostEnum,
    fixed: priceType.optional(),
    energy: priceType.optional(),
    chargingTime: priceType.optional(),
    idleTime: priceType.optional(),
    reservationTime: priceType.optional(),
    reservationFixed: priceType.optional(),
    total: totalPriceType,
  })
  .passthrough()
  .describe('This contains the cost calculated during a transaction');

// --- Total Usage (TransactionEvent running cost) ---
export const totalUsageType = z
  .object({
    energy: z.number(),
    chargingTime: z
      .number()
      .int()
      .describe(
        'Total duration of the charging session (including the duration of charging and not charging), in ...',
      ),
    idleTime: z
      .number()
      .int()
      .describe(
        'Total duration of the charging session where the EV was not charging (no energy was transferred b...',
      ),
    reservationTime: z.number().int().optional().describe('Total time of reservation in seconds.'),
  })
  .passthrough()
  .describe(
    'This contains the calculated usage of energy, charging time and idle time during a transaction.',
  );

// --- Cost Details (TransactionEvent running cost) ---
export const costDetailsType = z
  .object({
    chargingPeriods: z.array(chargingPeriodType).optional(),
    totalCost: totalCostType,
    totalUsage: totalUsageType,
    failureToCalculate: z
      .boolean()
      .optional()
      .describe('If set to true, then Charging Station has failed to calculate the cost.'),
    failureReason: z
      .string()
      .optional()
      .describe('Optional human-readable reason text in case of failure to calculate.'),
  })
  .passthrough()
  .describe(
    'CostDetailsType contains the cost as calculated by Charging Station based on provided TariffType',
  );

// --- DER Curve Points (SetDERControl, GetDERControl) ---
export const derCurvePointsType = z
  .object({
    x: z
      .number()
      .describe(
        'The data value of the X-axis (independent) variable, depending on the curve type.',
      ),
    y: z
      .number()
      .describe(
        'The data value of the Y-axis (dependent) variable, depending on the &lt;&lt;cmn_derunitenumtype&g...',
      ),
  })
  .passthrough();

// --- Hysteresis (DER curve parameters) ---
export const hysteresisType = z
  .object({
    hysteresisHigh: z
      .number()
      .optional()
      .describe('High value for return to normal operation after a grid event, in absolute value'),
    hysteresisLow: z
      .number()
      .optional()
      .describe('Low value for return to normal operation after a grid event, in absolute value'),
    hysteresisDelay: z
      .number()
      .optional()
      .describe(
        'Delay in seconds, once grid parameter within HysteresisLow and HysteresisHigh, for the EV to retu...',
      ),
    hysteresisGradient: z
      .number()
      .optional()
      .describe(
        'Set default rate of change (ramp rate %/s) for the EV to return to normal operation after a grid ...',
      ),
  })
  .passthrough();

// --- Reactive Power Params (DER VoltVar curve) ---
export const reactivePowerParamsType = z
  .object({
    vRef: z
      .number()
      .optional()
      .describe(
        'Only for VoltVar curve: The nominal ac voltage (rms) adjustment to the voltage curve points for V...',
      ),
    autonomousVRefEnable: z
      .boolean()
      .optional()
      .describe('Only for VoltVar: Enable/disable autonomous VRef adjustment'),
    autonomousVRefTimeConstant: z
      .number()
      .optional()
      .describe('Only for VoltVar: Adjustment range for VRef time constant'),
  })
  .passthrough();

// --- Voltage Params (DER voltage curve) ---
export const voltageParamsType = z
  .object({
    hv10MinMeanValue: z
      .number()
      .optional()
      .describe(
        'EN 50549-1 chapter 4.9.3.4 Voltage threshold for the 10 min time window mean value monitoring',
      ),
    hv10MinMeanTripDelay: z
      .number()
      .optional()
      .describe('Time for which the voltage is allowed to stay above the 10 min mean value'),
    powerDuringCessation: powerDuringCessationEnum.optional(),
  })
  .passthrough();

// --- DER Curve (SetDERControl, GetDERControl) ---
export const derCurveType = z
  .object({
    curveData: z.array(derCurvePointsType),
    hysteresis: hysteresisType.optional(),
    priority: z.number().int().describe('Priority of curve (0=highest)'),
    reactivePowerParams: reactivePowerParamsType.optional(),
    voltageParams: voltageParamsType.optional(),
    yUnit: derUnitEnum,
    responseTime: z
      .number()
      .optional()
      .describe(
        'Open loop response time, the time to ramp up to 90% of the new target in response to the change i...',
      ),
    startTime: z
      .string()
      .optional()
      .describe('Point in time when this curve will become activated'),
    duration: z.number().optional().describe('Duration in seconds that this curve will be active'),
  })
  .passthrough();

// --- DER Curve Get (GetDERControl) ---
export const derCurveGetType = z
  .object({
    curve: derCurveType,
    id: z.string().describe('Id of DER curve'),
    curveType: derControlEnum,
    isDefault: z.boolean().describe('True if this is a default curve'),
    isSuperseded: z
      .boolean()
      .describe('True if this setting is superseded by a higher priority setting (i.e'),
  })
  .passthrough();

// --- Enter Service (SetDERControl) ---
export const enterServiceType = z
  .object({
    priority: z.number().int().describe('Priority of setting (0=highest)'),
    highVoltage: z.number().describe('Enter service voltage high'),
    lowVoltage: z.number().describe('Enter service voltage low'),
    highFreq: z.number().describe('Enter service frequency high'),
    lowFreq: z.number().describe('Enter service frequency low'),
    delay: z.number().optional().describe('Enter service delay'),
    randomDelay: z.number().optional().describe('Enter service randomized delay'),
    rampRate: z.number().optional().describe('Enter service ramp rate in seconds'),
  })
  .passthrough();

// --- Enter Service Get (GetDERControl) ---
export const enterServiceGetType = z
  .object({
    enterService: enterServiceType,
    id: z.string().describe('Id of setting'),
  })
  .passthrough();

// --- Event Data (NotifyEvent) ---
export const eventDataType = z
  .object({
    eventId: z.number().int().describe('Identifies the event'),
    timestamp: z.string().describe('Timestamp of the moment the report was generated.'),
    trigger: eventTriggerEnum,
    cause: z
      .number()
      .int()
      .optional()
      .describe('Refers to the Id of an event that is considered to be the cause for this event.'),
    actualValue: z.string().describe('Actual value (_attributeType_ Actual) of the variable'),
    techCode: z.string().optional().describe('Technical (error) code as reported by component.'),
    techInfo: z
      .string()
      .optional()
      .describe('Technical detail information as reported by component.'),
    cleared: z
      .boolean()
      .optional()
      .describe('_Cleared_ is set to true to report the clearing of a monitored situation, i.e'),
    transactionId: z
      .string()
      .optional()
      .describe(
        'If an event notification is linked to a specific transaction, this field can be used to specify i...',
      ),
    component: componentType,
    variableMonitoringId: z
      .number()
      .int()
      .optional()
      .describe('Identifies the VariableMonitoring which triggered the event.'),
    eventNotificationType: eventNotificationEnum,
    variable: variableType,
    severity: z
      .number()
      .int()
      .optional()
      .describe(
        'Severity associated with the monitor in _variableMonitoringId_ or with the hardwired notification.',
      ),
  })
  .passthrough()
  .describe('Class to report an event notification for a component-variable.');

// --- Firmware (UpdateFirmware) ---
export const firmwareType = z
  .object({
    location: z.string().describe('URI defining the origin of the firmware.'),
    retrieveDateTime: z
      .string()
      .describe('Date and time at which the firmware shall be retrieved.'),
    installDateTime: z
      .string()
      .optional()
      .describe('Date and time at which the firmware shall be installed.'),
    signingCertificate: z
      .string()
      .optional()
      .describe('Certificate with which the firmware was signed'),
    signature: z.string().optional().describe('Base64 encoded firmware signature.'),
  })
  .passthrough()
  .describe(
    'Represents a copy of the firmware that can be loaded/updated on the Charging Station.',
  );

// --- Fixed Power Factor (SetDERControl) ---
export const fixedPFType = z
  .object({
    priority: z.number().int().describe('Priority of setting (0=highest)'),
    displacement: z.number().describe('Power factor, cos(phi), as value between 0..1.'),
    excitation: z
      .boolean()
      .describe(
        'True when absorbing reactive power (under-excited), false when injecting reactive power (over-exc...',
      ),
    startTime: z.string().optional().describe('Time when this setting becomes active'),
    duration: z.number().optional().describe('Duration in seconds that this setting is active.'),
  })
  .passthrough();

// --- Fixed Power Factor Get (GetDERControl) ---
export const fixedPFGetType = z
  .object({
    fixedPF: fixedPFType,
    id: z.string().describe('Id of setting.'),
    isDefault: z.boolean().describe('True if setting is a default control.'),
    isSuperseded: z
      .boolean()
      .describe('True if this setting is superseded by a lower priority setting.'),
  })
  .passthrough();

// --- Fixed Var (SetDERControl) ---
export const fixedVarType = z
  .object({
    priority: z.number().int().describe('Priority of setting (0=highest)'),
    setpoint: z
      .number()
      .describe(
        'The value specifies a target var output interpreted as a signed percentage (-100 to 100)',
      ),
    unit: derUnitEnum,
    startTime: z.string().optional().describe('Time when this setting becomes active.'),
    duration: z.number().optional().describe('Duration in seconds that this setting is active.'),
  })
  .passthrough();

// --- Fixed Var Get (GetDERControl) ---
export const fixedVarGetType = z
  .object({
    fixedVar: fixedVarType,
    id: z.string().describe('Id of setting'),
    isDefault: z.boolean().describe('True if setting is a default control.'),
    isSuperseded: z
      .boolean()
      .describe('True if this setting is superseded by a lower priority setting'),
  })
  .passthrough();

// --- Frequency Droop (SetDERControl) ---
export const freqDroopType = z
  .object({
    priority: z.number().int().describe('Priority of setting (0=highest)'),
    overFreq: z.number().describe('Over-frequency start of droop'),
    underFreq: z.number().describe('Under-frequency start of droop'),
    overDroop: z.number().describe('Over-frequency droop per unit, oFDroop'),
    underDroop: z.number().describe('Under-frequency droop per unit, uFDroop'),
    responseTime: z.number().describe('Open loop response time in seconds'),
    startTime: z.string().optional().describe('Time when this setting becomes active'),
    duration: z.number().optional().describe('Duration in seconds that this setting is active'),
  })
  .passthrough();

// --- Frequency Droop Get (GetDERControl) ---
export const freqDroopGetType = z
  .object({
    freqDroop: freqDroopType,
    id: z.string().describe('Id of setting'),
    isDefault: z.boolean().describe('True if setting is a default control.'),
    isSuperseded: z
      .boolean()
      .describe('True if this setting is superseded by a higher priority setting (i.e'),
  })
  .passthrough();

// --- Get Variable Data (GetVariables) ---
export const getVariableDataType = z
  .object({
    attributeType: attributeEnum.optional(),
    component: componentType,
    variable: variableType,
  })
  .passthrough()
  .describe('Class to hold parameters for GetVariables request.');

// --- Get Variable Result (GetVariables) ---
export const getVariableResultType = z
  .object({
    attributeStatus: getVariableStatusEnum,
    attributeStatusInfo: statusInfoType.optional(),
    attributeType: attributeEnum.optional(),
    attributeValue: z
      .string()
      .optional()
      .describe('Value of requested attribute type of component-variable'),
    component: componentType,
    variable: variableType,
  })
  .passthrough()
  .describe('Class to hold results of GetVariables request.');

// --- Gradient (SetDERControl) ---
export const gradientType = z
  .object({
    priority: z.number().int().describe('Id of setting'),
    gradient: z.number().describe('Default ramp rate in seconds (0 if not applicable)'),
    softGradient: z.number().describe('Soft-start ramp rate in seconds (0 if not applicable)'),
  })
  .passthrough();

// --- Gradient Get (GetDERControl) ---
export const gradientGetType = z
  .object({
    gradient: gradientType,
    id: z.string().describe('Id of setting'),
  })
  .passthrough();

// --- Limit Max Discharge (SetDERControl) ---
export const limitMaxDischargeType = z
  .object({
    priority: z.number().int().describe('Priority of setting (0=highest)'),
    pctMaxDischargePower: z.number().optional().describe('Only for PowerMonitoring'),
    powerMonitoringMustTrip: derCurveType.optional(),
    startTime: z.string().optional().describe('Time when this setting becomes active'),
    duration: z.number().optional().describe('Duration in seconds that this setting is active'),
  })
  .passthrough();

// --- Limit Max Discharge Get (GetDERControl) ---
export const limitMaxDischargeGetType = z
  .object({
    id: z.string().describe('Id of setting'),
    isDefault: z.boolean().describe('True if setting is a default control.'),
    isSuperseded: z
      .boolean()
      .describe('True if this setting is superseded by a higher priority setting (i.e'),
    limitMaxDischarge: limitMaxDischargeType,
  })
  .passthrough();

// --- Log Parameters (GetLog) ---
export const logParametersType = z
  .object({
    remoteLocation: z
      .string()
      .describe('The URL of the location at the remote system where the log should be stored.'),
    oldestTimestamp: z
      .string()
      .optional()
      .describe(
        'This contains the date and time of the oldest logging information to include in the diagnostics.',
      ),
    latestTimestamp: z
      .string()
      .optional()
      .describe(
        'This contains the date and time of the latest logging information to include in the diagnostics.',
      ),
  })
  .passthrough()
  .describe('Generic class for the configuration of logging entries.');

// --- Message Info (SetDisplayMessage, GetDisplayMessages, NotifyDisplayMessages) ---
export const messageInfoType = z
  .object({
    display: componentType.optional(),
    id: z.number().int().describe('Unique id within an exchange context'),
    priority: messagePriorityEnum,
    state: messageStateEnum.optional(),
    startDateTime: z
      .string()
      .optional()
      .describe('From what date-time should this message be shown'),
    endDateTime: z
      .string()
      .optional()
      .describe(
        'Until what date-time should this message be shown, after this date/time this message SHALL be rem...',
      ),
    transactionId: z
      .string()
      .optional()
      .describe('During which transaction shall this message be shown'),
    message: messageContentType,
    messageExtra: z.array(messageContentType).optional(),
  })
  .passthrough()
  .describe('Contains message details, for a message to be displayed on a Charging Station.');

// --- Signed Meter Value (MeterValues, TransactionEvent) ---
export const signedMeterValueType = z
  .object({
    signedMeterData: z
      .string()
      .describe(
        'Base64 encoded, contains the signed data from the meter in the format specified in _encodingMetho...',
      ),
    signingMethod: z.string().optional().describe('Method used to create the digital signature'),
    encodingMethod: z.string().describe('Format used by the energy meter to encode the meter data'),
    publicKey: z
      .string()
      .optional()
      .describe(
        'Base64 encoded, sending depends on configuration variable _PublicKeyWithSignedMeterValue_.',
      ),
  })
  .passthrough()
  .describe('Represent a signed version of the meter value.');

// --- Unit of Measure (MeterValues, TransactionEvent) ---
export const unitOfMeasureType = z
  .object({
    unit: z.string().optional().describe('Unit of the value'),
    multiplier: z
      .number()
      .int()
      .optional()
      .describe('Multiplier, this value represents the exponent to base 10'),
  })
  .passthrough()
  .describe('Represents a UnitOfMeasure with a multiplier');

// --- Sampled Value (MeterValues, TransactionEvent) ---
export const sampledValueType = z
  .object({
    value: z.number().describe('Indicates the measured value.'),
    measurand: measurandEnum.optional(),
    context: readingContextEnum.optional(),
    phase: phaseEnum.optional(),
    location: locationEnum.optional(),
    signedMeterValue: signedMeterValueType.optional(),
    unitOfMeasure: unitOfMeasureType.optional(),
  })
  .passthrough()
  .describe('Single sampled value in MeterValues');

// --- Meter Value (MeterValues, TransactionEvent) ---
export const meterValueType = z
  .object({
    sampledValue: z.array(sampledValueType),
    timestamp: z.string().describe('Timestamp for measured value(s).'),
  })
  .passthrough()
  .describe('Collection of one or more sampled values in MeterValuesRequest and TransactionEvent');

// --- Variable Monitoring (NotifyMonitoringReport) ---
export const variableMonitoringType = z
  .object({
    id: z.number().int().describe('Identifies the monitor.'),
    transaction: z
      .boolean()
      .describe(
        'Monitor only active when a transaction is ongoing on a component relevant to this transaction.',
      ),
    value: z.number().describe('Value for threshold or delta monitoring'),
    type: monitorEnum,
    severity: z
      .number()
      .int()
      .describe('The severity that will be assigned to an event that is triggered by this monitor'),
    eventNotificationType: eventNotificationEnum,
  })
  .passthrough()
  .describe('A monitoring setting for a variable.');

// --- Monitoring Data (NotifyMonitoringReport) ---
export const monitoringDataType = z
  .object({
    component: componentType,
    variable: variableType,
    variableMonitoring: z.array(variableMonitoringType),
  })
  .passthrough()
  .describe('Class to hold parameters of SetVariableMonitoring request.');

// --- VPN (SetNetworkProfile) ---
export const vpnType = z
  .object({
    server: z.string().describe('VPN Server Address'),
    user: z.string().describe('VPN User'),
    group: z.string().optional().describe('VPN group.'),
    password: z.string().describe('VPN Password.'),
    key: z.string().describe('VPN shared secret.'),
    type: vpnEnum,
  })
  .passthrough()
  .describe('VPN Configuration settings');

// --- Network Connection Profile (SetNetworkProfile) ---
export const networkConnectionProfileType = z
  .object({
    apn: apnType.optional(),
    ocppVersion: ocppVersionEnum.optional(),
    ocppInterface: ocppInterfaceEnum,
    ocppTransport: ocppTransportEnum,
    messageTimeout: z
      .number()
      .int()
      .describe(
        'Duration in seconds before a message send by the Charging Station via this network connection tim...',
      ),
    ocppCsmsUrl: z
      .string()
      .describe(
        'URL of the CSMS(s) that this Charging Station communicates with, without the Charging Station ide...',
      ),
    securityProfile: z
      .number()
      .int()
      .describe(
        'This field specifies the security profile used when connecting to the CSMS with this NetworkConne...',
      ),
    identity: z
      .string()
      .optional()
      .describe('Charging Station identity to be used as the basic authentication username.'),
    basicAuthPassword: z
      .string()
      .optional()
      .describe('BasicAuthPassword to use for security profile 1 or 2.'),
    vpn: vpnType.optional(),
  })
  .passthrough()
  .describe(
    'The NetworkConnectionProfile defines the functional and technical parameters of a communication l...',
  );

// --- OCSP Request Data (GetCertificateStatus) ---
export const ocspRequestDataType = z
  .object({
    hashAlgorithm: hashAlgorithmEnum,
    issuerNameHash: z
      .string()
      .describe(
        'The hash of the issuer’s distinguished name (DN), that must be calculated over the DER encoding o...',
      ),
    issuerKeyHash: z
      .string()
      .describe(
        'The hash of the DER encoded public key: the value (excluding tag and length) of the subject publi...',
      ),
    serialNumber: z
      .string()
      .describe(
        'The string representation of the hexadecimal value of the serial number without the prefix "0x" a...',
      ),
    responderURL: z.string().describe('This contains the responder URL (Case insensitive).'),
  })
  .passthrough()
  .describe('Information about a certificate for an OCSP check.');

// --- Variable Attribute (NotifyReport, GetBaseReport) ---
export const variableAttributeType = z
  .object({
    type: attributeEnum.optional(),
    value: z.string().optional().describe('Value of the attribute'),
    mutability: mutabilityEnum.optional(),
    persistent: z
      .boolean()
      .optional()
      .describe('If true, value will be persistent across system reboots or power down'),
    constant: z
      .boolean()
      .optional()
      .describe('If true, value that will never be changed by the Charging Station at runtime'),
  })
  .passthrough()
  .describe('Attribute data of a variable.');

// --- Variable Characteristics (NotifyReport, GetBaseReport) ---
export const variableCharacteristicsType = z
  .object({
    unit: z.string().optional().describe('Unit of the variable'),
    dataType: dataEnum,
    minLimit: z.number().optional().describe('Minimum possible value of this variable.'),
    maxLimit: z.number().optional().describe('Maximum possible value of this variable'),
    maxElements: z
      .number()
      .int()
      .optional()
      .describe(
        'Maximum number of elements from _valuesList_ that are supported as _attributeValue_.',
      ),
    valuesList: z
      .string()
      .optional()
      .describe('Mandatory when _dataType_ = OptionList, MemberList or SequenceList'),
    supportsMonitoring: z
      .boolean()
      .describe('Flag indicating if this variable supports monitoring.'),
  })
  .passthrough()
  .describe('Fixed read-only parameters of a variable.');

// --- Report Data (NotifyReport) ---
export const reportDataType = z
  .object({
    component: componentType,
    variable: variableType,
    variableAttribute: z.array(variableAttributeType),
    variableCharacteristics: variableCharacteristicsType.optional(),
  })
  .passthrough()
  .describe('Class to report components, variables and variable attributes and characteristics.');

// --- Set Monitoring Data (SetVariableMonitoring) ---
export const setMonitoringDataType = z
  .object({
    id: z
      .number()
      .int()
      .optional()
      .describe('An id SHALL only be given to replace an existing monitor'),
    periodicEventStream: periodicEventStreamParamsType.optional(),
    transaction: z
      .boolean()
      .optional()
      .describe(
        'Monitor only active when a transaction is ongoing on a component relevant to this transaction',
      ),
    value: z.number().describe('Value for threshold or delta monitoring'),
    type: monitorEnum,
    severity: z
      .number()
      .int()
      .describe('The severity that will be assigned to an event that is triggered by this monitor'),
    component: componentType,
    variable: variableType,
  })
  .passthrough()
  .describe('Class to hold parameters of SetVariableMonitoring request.');

// --- Set Monitoring Result (SetVariableMonitoring) ---
export const setMonitoringResultType = z
  .object({
    id: z
      .number()
      .int()
      .optional()
      .describe('Id given to the VariableMonitor by the Charging Station'),
    statusInfo: statusInfoType.optional(),
    status: setMonitoringStatusEnum,
    type: monitorEnum,
    component: componentType,
    variable: variableType,
    severity: z
      .number()
      .int()
      .describe('The severity that will be assigned to an event that is triggered by this monitor'),
  })
  .passthrough()
  .describe('Class to hold result of SetVariableMonitoring request.');

// --- Set Variable Data (SetVariables) ---
export const setVariableDataType = z
  .object({
    attributeType: attributeEnum.optional(),
    attributeValue: z.string().describe('Value to be assigned to attribute of variable'),
    component: componentType,
    variable: variableType,
  })
  .passthrough();

// --- Set Variable Result (SetVariables) ---
export const setVariableResultType = z
  .object({
    attributeType: attributeEnum.optional(),
    attributeStatus: setVariableStatusEnum,
    attributeStatusInfo: statusInfoType.optional(),
    component: componentType,
    variable: variableType,
  })
  .passthrough();

// --- Stream Data Element (NotifyPeriodicEventStream) ---
export const streamDataElementType = z
  .object({
    t: z.number().describe('Offset relative to _basetime_ of this message'),
    v: z.string(),
  })
  .passthrough();

// --- Tariff Assignment (GetTariffs) ---
export const tariffAssignmentType = z
  .object({
    tariffId: z.string().describe('Tariff id.'),
    tariffKind: tariffKindEnum,
    validFrom: z.string().optional().describe('Date/time when this tariff become active.'),
    evseIds: z.array(z.number().int()).optional(),
    idTokens: z.array(z.string()).optional().describe('IdTokens related to tariff'),
  })
  .passthrough()
  .describe('Shows assignment of tariffs to EVSE or IdToken.');

// --- Tariff Conditions Fixed (SetDefaultTariff, SetDriverTariff) ---
export const tariffConditionsFixedType = z
  .object({
    startTimeOfDay: z.string().optional().describe('Start time of day in local time'),
    endTimeOfDay: z.string().optional().describe('End time of day in local time'),
    dayOfWeek: z
      .array(dayOfWeekEnum)
      .optional()
      .describe('Day(s) of the week this is tariff applies.'),
    validFromDate: z
      .string()
      .optional()
      .describe('Start date in local time, for example: 2015-12-24'),
    validToDate: z.string().optional().describe('End date in local time, for example: 2015-12-27'),
    evseKind: evseKindEnum.optional(),
    paymentBrand: z
      .string()
      .optional()
      .describe('For which payment brand this (adhoc) tariff applies'),
    paymentRecognition: z.string().optional().describe('Type of adhoc payment, e.g'),
  })
  .passthrough()
  .describe('These conditions describe if a FixedPrice applies at start of the transaction');

// --- Tariff Conditions (SetDefaultTariff, SetDriverTariff) ---
export const tariffConditionsType = z
  .object({
    startTimeOfDay: z.string().optional().describe('Start time of day in local time'),
    endTimeOfDay: z.string().optional().describe('End time of day in local time'),
    dayOfWeek: z
      .array(dayOfWeekEnum)
      .optional()
      .describe('Day(s) of the week this is tariff applies.'),
    validFromDate: z
      .string()
      .optional()
      .describe('Start date in local time, for example: 2015-12-24'),
    validToDate: z.string().optional().describe('End date in local time, for example: 2015-12-27'),
    evseKind: evseKindEnum.optional(),
    minEnergy: z
      .number()
      .optional()
      .describe('Minimum consumed energy in Wh, for example 20000 Wh'),
    maxEnergy: z
      .number()
      .optional()
      .describe('Maximum consumed energy in Wh, for example 50000 Wh'),
    minCurrent: z
      .number()
      .optional()
      .describe('Sum of the minimum current (in Amperes) over all phases, for example 5 A'),
    maxCurrent: z
      .number()
      .optional()
      .describe('Sum of the maximum current (in Amperes) over all phases, for example 20 A'),
    minPower: z.number().optional().describe('Minimum power in W, for example 5000 W'),
    maxPower: z.number().optional().describe('Maximum power in W, for example 20000 W'),
    minTime: z
      .number()
      .int()
      .optional()
      .describe(
        'Minimum duration in seconds the transaction (charging &amp; idle) MUST last (inclusive)',
      ),
    maxTime: z
      .number()
      .int()
      .optional()
      .describe(
        'Maximum duration in seconds the transaction (charging &amp; idle) MUST last (exclusive)',
      ),
    minChargingTime: z
      .number()
      .int()
      .optional()
      .describe('Minimum duration in seconds the charging MUST last (inclusive)'),
    maxChargingTime: z
      .number()
      .int()
      .optional()
      .describe('Maximum duration in seconds the charging MUST last (exclusive)'),
    minIdleTime: z
      .number()
      .int()
      .optional()
      .describe('Minimum duration in seconds the idle period (i.e'),
    maxIdleTime: z
      .number()
      .int()
      .optional()
      .describe('Maximum duration in seconds the idle period (i.e'),
  })
  .passthrough()
  .describe(
    'These conditions describe if and when a TariffEnergyType or TariffTimeType applies during a trans...',
  );

// --- Tariff Energy Price (SetDefaultTariff, SetDriverTariff) ---
export const tariffEnergyPriceType = z
  .object({
    priceKwh: z.number().describe('Price per kWh (excl'),
    conditions: tariffConditionsType.optional(),
  })
  .passthrough()
  .describe('Tariff with optional conditions for an energy price.');

// --- Tariff Energy (SetDefaultTariff, SetDriverTariff) ---
export const tariffEnergyType = z
  .object({
    prices: z.array(tariffEnergyPriceType),
    taxRates: z.array(taxRateType).optional(),
  })
  .passthrough()
  .describe('Price elements and tax for energy');

// --- Tariff Fixed Price (SetDefaultTariff, SetDriverTariff) ---
export const tariffFixedPriceType = z
  .object({
    conditions: tariffConditionsFixedType.optional(),
    priceFixed: z.number().describe('Fixed price for this element e.g'),
  })
  .passthrough()
  .describe('Tariff with optional conditions for a fixed price.');

// --- Tariff Fixed (SetDefaultTariff, SetDriverTariff) ---
export const tariffFixedType = z
  .object({
    prices: z.array(tariffFixedPriceType),
    taxRates: z.array(taxRateType).optional(),
  })
  .passthrough();

// --- Tariff Time Price (SetDefaultTariff, SetDriverTariff) ---
export const tariffTimePriceType = z
  .object({
    priceMinute: z.number().describe('Price per minute (excl'),
    conditions: tariffConditionsType.optional(),
  })
  .passthrough()
  .describe('Tariff with optional conditions for a time duration price.');

// --- Tariff Time (SetDefaultTariff, SetDriverTariff) ---
export const tariffTimeType = z
  .object({
    prices: z.array(tariffTimePriceType),
    taxRates: z.array(taxRateType).optional(),
  })
  .passthrough()
  .describe('Price elements and tax for time');

// --- Tariff (SetDefaultTariff, SetDriverTariff, GetTariffs) ---
export const tariffType = z
  .object({
    tariffId: z.string().describe('Unique id of tariff'),
    description: z.array(messageContentType).optional(),
    currency: z.string().describe('Currency code according to ISO 4217'),
    energy: tariffEnergyType.optional(),
    validFrom: z.string().optional().describe('Time when this tariff becomes active'),
    chargingTime: tariffTimeType.optional(),
    idleTime: tariffTimeType.optional(),
    fixedFee: tariffFixedType.optional(),
    reservationTime: tariffTimeType.optional(),
    reservationFixed: tariffFixedType.optional(),
    minCost: priceType.optional(),
    maxCost: priceType.optional(),
  })
  .passthrough()
  .describe(
    'A tariff is described by fields with prices for: energy, charging time, idle time, fixed fee, res...',
  );

// --- Transaction Limit (TransactionEvent) ---
export const transactionLimitType = z
  .object({
    maxCost: z
      .number()
      .optional()
      .describe('Maximum allowed cost of transaction in currency of tariff.'),
    maxEnergy: z
      .number()
      .optional()
      .describe('Maximum allowed energy in Wh to charge in transaction.'),
    maxTime: z
      .number()
      .int()
      .optional()
      .describe('Maximum duration of transaction in seconds from start to end.'),
    maxSoC: z.number().int().optional().describe('Maximum State of Charge of EV in percentage.'),
  })
  .passthrough()
  .describe('Cost, energy, time or SoC limit for a transaction.');

// --- Transaction (TransactionEvent) ---
export const transactionType = z
  .object({
    transactionId: z.string().describe('This contains the Id of the transaction.'),
    chargingState: chargingStateEnum.optional(),
    timeSpentCharging: z
      .number()
      .int()
      .optional()
      .describe(
        'Contains the total time that energy flowed from EVSE to EV during the transaction (in seconds)',
      ),
    stoppedReason: reasonEnum.optional(),
    remoteStartId: z
      .number()
      .int()
      .optional()
      .describe(
        'The ID given to remote start request (&lt;&lt;requeststarttransactionrequest, RequestStartTransac...',
      ),
    operationMode: operationModeEnum.optional(),
    tariffId: z.string().optional().describe('Id of tariff in use for transaction'),
    transactionLimit: transactionLimitType.optional(),
  })
  .passthrough();

// ============================================================
// Inferred TypeScript Types
// ============================================================

export type ACChargingParametersType = z.infer<typeof acChargingParametersType>;
export type APNType = z.infer<typeof apnType>;
export type RationalNumberType = z.infer<typeof rationalNumberType>;
export type PriceRuleType = z.infer<typeof priceRuleType>;
export type PriceRuleStackType = z.infer<typeof priceRuleStackType>;
export type TaxRuleType = z.infer<typeof taxRuleType>;
export type OverstayRuleType = z.infer<typeof overstayRuleType>;
export type OverstayRuleListType = z.infer<typeof overstayRuleListType>;
export type AdditionalSelectedServicesType = z.infer<typeof additionalSelectedServicesType>;
export type AbsolutePriceScheduleType = z.infer<typeof absolutePriceScheduleType>;
export type AdditionalInfoType = z.infer<typeof additionalInfoType>;
export type AddressType = z.infer<typeof addressType>;
export type IdTokenType = z.infer<typeof idTokenType>;
export type MessageContentType = z.infer<typeof messageContentType>;
export type IdTokenInfoType = z.infer<typeof idTokenInfoType>;
export type AuthorizationData = z.infer<typeof authorizationData>;
export type BatteryDataType = z.infer<typeof batteryDataType>;
export type CertificateHashDataType = z.infer<typeof certificateHashDataType>;
export type CertificateHashDataChainType = z.infer<typeof certificateHashDataChainType>;
export type CertificateStatusRequestInfoType = z.infer<typeof certificateStatusRequestInfoType>;
export type CertificateStatusType = z.infer<typeof certificateStatusType>;
export type ChargingLimitType = z.infer<typeof chargingLimitType>;
export type DERChargingParametersType = z.infer<typeof derChargingParametersType>;
export type EVPriceRuleType = z.infer<typeof evPriceRuleType>;
export type EVAbsolutePriceScheduleEntryType = z.infer<typeof evAbsolutePriceScheduleEntryType>;
export type EVAbsolutePriceScheduleType = z.infer<typeof evAbsolutePriceScheduleType>;
export type EVPowerScheduleEntryType = z.infer<typeof evPowerScheduleEntryType>;
export type EVPowerScheduleType = z.infer<typeof evPowerScheduleType>;
export type EVEnergyOfferType = z.infer<typeof evEnergyOfferType>;
export type DCChargingParametersType = z.infer<typeof dcChargingParametersType>;
export type V2XChargingParametersType = z.infer<typeof v2xChargingParametersType>;
export type ChargingNeedsType = z.infer<typeof chargingNeedsType>;
export type CostDimensionType = z.infer<typeof costDimensionType>;
export type ChargingPeriodType = z.infer<typeof chargingPeriodType>;
export type ChargingProfileCriterionType = z.infer<typeof chargingProfileCriterionType>;
export type LimitAtSoCType = z.infer<typeof limitAtSoCType>;
export type V2XFreqWattPointType = z.infer<typeof v2xFreqWattPointType>;
export type V2XSignalWattPointType = z.infer<typeof v2xSignalWattPointType>;
export type ChargingSchedulePeriodType = z.infer<typeof chargingSchedulePeriodType>;
export type RelativeTimeIntervalType = z.infer<typeof relativeTimeIntervalType>;
export type CostType = z.infer<typeof costType>;
export type ConsumptionCostType = z.infer<typeof consumptionCostType>;
export type SalesTariffEntryType = z.infer<typeof salesTariffEntryType>;
export type SalesTariffType = z.infer<typeof salesTariffType>;
export type PriceLevelScheduleEntryType = z.infer<typeof priceLevelScheduleEntryType>;
export type PriceLevelScheduleType = z.infer<typeof priceLevelScheduleType>;
export type ChargingScheduleType = z.infer<typeof chargingScheduleType>;
export type ChargingProfileType = z.infer<typeof chargingProfileType>;
export type ChargingScheduleUpdateType = z.infer<typeof chargingScheduleUpdateType>;
export type ModemType = z.infer<typeof modemType>;
export type ChargingStationType = z.infer<typeof chargingStationType>;
export type ClearChargingProfileType = z.infer<typeof clearChargingProfileType>;
export type StatusInfoType = z.infer<typeof statusInfoType>;
export type ClearMonitoringResultType = z.infer<typeof clearMonitoringResultType>;
export type ClearTariffsResultType = z.infer<typeof clearTariffsResultType>;
export type EVSEType = z.infer<typeof evseType>;
export type ComponentType = z.infer<typeof componentType>;
export type VariableType = z.infer<typeof variableType>;
export type ComponentVariableType = z.infer<typeof componentVariableType>;
export type CompositeScheduleType = z.infer<typeof compositeScheduleType>;
export type PeriodicEventStreamParamsType = z.infer<typeof periodicEventStreamParamsType>;
export type ConstantStreamDataType = z.infer<typeof constantStreamDataType>;
export type TaxRateType = z.infer<typeof taxRateType>;
export type PriceType = z.infer<typeof priceType>;
export type TotalPriceType = z.infer<typeof totalPriceType>;
export type TotalCostType = z.infer<typeof totalCostType>;
export type TotalUsageType = z.infer<typeof totalUsageType>;
export type CostDetailsType = z.infer<typeof costDetailsType>;
export type DERCurvePointsType = z.infer<typeof derCurvePointsType>;
export type HysteresisType = z.infer<typeof hysteresisType>;
export type ReactivePowerParamsType = z.infer<typeof reactivePowerParamsType>;
export type VoltageParamsType = z.infer<typeof voltageParamsType>;
export type DERCurveType = z.infer<typeof derCurveType>;
export type DERCurveGetType = z.infer<typeof derCurveGetType>;
export type EnterServiceType = z.infer<typeof enterServiceType>;
export type EnterServiceGetType = z.infer<typeof enterServiceGetType>;
export type EventDataType = z.infer<typeof eventDataType>;
export type FirmwareType = z.infer<typeof firmwareType>;
export type FixedPFType = z.infer<typeof fixedPFType>;
export type FixedPFGetType = z.infer<typeof fixedPFGetType>;
export type FixedVarType = z.infer<typeof fixedVarType>;
export type FixedVarGetType = z.infer<typeof fixedVarGetType>;
export type FreqDroopType = z.infer<typeof freqDroopType>;
export type FreqDroopGetType = z.infer<typeof freqDroopGetType>;
export type GetVariableDataType = z.infer<typeof getVariableDataType>;
export type GetVariableResultType = z.infer<typeof getVariableResultType>;
export type GradientType = z.infer<typeof gradientType>;
export type GradientGetType = z.infer<typeof gradientGetType>;
export type LimitMaxDischargeType = z.infer<typeof limitMaxDischargeType>;
export type LimitMaxDischargeGetType = z.infer<typeof limitMaxDischargeGetType>;
export type LogParametersType = z.infer<typeof logParametersType>;
export type MessageInfoType = z.infer<typeof messageInfoType>;
export type SignedMeterValueType = z.infer<typeof signedMeterValueType>;
export type UnitOfMeasureType = z.infer<typeof unitOfMeasureType>;
export type SampledValueType = z.infer<typeof sampledValueType>;
export type MeterValueType = z.infer<typeof meterValueType>;
export type VariableMonitoringType = z.infer<typeof variableMonitoringType>;
export type MonitoringDataType = z.infer<typeof monitoringDataType>;
export type VPNType = z.infer<typeof vpnType>;
export type NetworkConnectionProfileType = z.infer<typeof networkConnectionProfileType>;
export type OCSPRequestDataType = z.infer<typeof ocspRequestDataType>;
export type VariableAttributeType = z.infer<typeof variableAttributeType>;
export type VariableCharacteristicsType = z.infer<typeof variableCharacteristicsType>;
export type ReportDataType = z.infer<typeof reportDataType>;
export type SetMonitoringDataType = z.infer<typeof setMonitoringDataType>;
export type SetMonitoringResultType = z.infer<typeof setMonitoringResultType>;
export type SetVariableDataType = z.infer<typeof setVariableDataType>;
export type SetVariableResultType = z.infer<typeof setVariableResultType>;
export type StreamDataElementType = z.infer<typeof streamDataElementType>;
export type TariffAssignmentType = z.infer<typeof tariffAssignmentType>;
export type TariffConditionsFixedType = z.infer<typeof tariffConditionsFixedType>;
export type TariffConditionsType = z.infer<typeof tariffConditionsType>;
export type TariffEnergyPriceType = z.infer<typeof tariffEnergyPriceType>;
export type TariffEnergyType = z.infer<typeof tariffEnergyType>;
export type TariffFixedPriceType = z.infer<typeof tariffFixedPriceType>;
export type TariffFixedType = z.infer<typeof tariffFixedType>;
export type TariffTimePriceType = z.infer<typeof tariffTimePriceType>;
export type TariffTimeType = z.infer<typeof tariffTimeType>;
export type TariffType = z.infer<typeof tariffType>;
export type TransactionLimitType = z.infer<typeof transactionLimitType>;
export type TransactionType = z.infer<typeof transactionType>;
