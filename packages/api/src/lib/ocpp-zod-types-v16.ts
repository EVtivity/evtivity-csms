// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

// ============================================================
// OCPP 1.6 Zod Schema Library
// Auto-generated from OCPP 1.6 JSON schemas.
// Single source of truth for OCPP 1.6 types used across the API.
// ============================================================

// ============================================================
// Enum Types
// ============================================================

// --- Authorization Status (AuthorizeResponse, StartTransactionResponse, StopTransactionResponse, SendLocalList) ---
export const authorizationStatusEnum = z.enum([
  'Accepted',
  'Blocked',
  'Expired',
  'Invalid',
  'ConcurrentTx',
]);

// --- BootNotification Registration Status ---
export const registrationStatusEnum = z.enum(['Accepted', 'Pending', 'Rejected']);

// --- CancelReservation Status ---
export const cancelReservationStatusEnum = z.enum(['Accepted', 'Rejected']);

// --- ChangeAvailability Type ---
export const availabilityTypeEnum = z.enum(['Inoperative', 'Operative']);

// --- ChangeAvailability Status ---
export const availabilityStatusEnum = z.enum(['Accepted', 'Rejected', 'Scheduled']);

// --- ChangeConfiguration Status ---
export const configurationStatusEnum = z.enum([
  'Accepted',
  'Rejected',
  'RebootRequired',
  'NotSupported',
]);

// --- ClearCache Status ---
export const clearCacheStatusEnum = z.enum(['Accepted', 'Rejected']);

// --- ChargingProfilePurpose ---
export const chargingProfilePurposeEnum = z.enum([
  'ChargePointMaxProfile',
  'TxDefaultProfile',
  'TxProfile',
]);

// --- ClearChargingProfile Status ---
export const clearChargingProfileStatusEnum = z.enum(['Accepted', 'Unknown']);

// --- ChargingProfileKind ---
export const chargingProfileKindEnum = z.enum(['Absolute', 'Recurring', 'Relative']);

// --- RecurrencyKind ---
export const recurrencyKindEnum = z.enum(['Daily', 'Weekly']);

// --- ChargingRateUnit ---
export const chargingRateUnitEnum = z.enum(['A', 'W']);

// --- DataTransfer Status ---
export const dataTransferStatusEnum = z.enum([
  'Accepted',
  'Rejected',
  'UnknownMessageId',
  'UnknownVendorId',
]);

// --- DiagnosticsStatus ---
export const diagnosticsStatusEnum = z.enum(['Idle', 'Uploaded', 'UploadFailed', 'Uploading']);

// --- FirmwareStatus ---
export const firmwareStatusEnum = z.enum([
  'Downloaded',
  'DownloadFailed',
  'Downloading',
  'Idle',
  'InstallationFailed',
  'Installing',
  'Installed',
]);

// --- GetCompositeSchedule Status ---
export const getCompositeScheduleStatusEnum = z.enum(['Accepted', 'Rejected']);

// --- ChargePointStatus (StatusNotification) ---
export const chargePointStatusEnum = z.enum([
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEVSE',
  'SuspendedEV',
  'Finishing',
  'Reserved',
  'Unavailable',
  'Faulted',
]);

// --- ChargePointErrorCode (StatusNotification) ---
export const chargePointErrorCodeEnum = z.enum([
  'ConnectorLockFailure',
  'EVCommunicationError',
  'GroundFailure',
  'HighTemperature',
  'InternalError',
  'LocalListConflict',
  'NoError',
  'OtherError',
  'OverCurrentFailure',
  'PowerMeterFailure',
  'PowerSwitchFailure',
  'ReaderFailure',
  'ResetFailure',
  'UnderVoltage',
  'OverVoltage',
  'WeakSignal',
]);

// --- RemoteStartStop Status ---
export const remoteStartStopStatusEnum = z.enum(['Accepted', 'Rejected']);

// --- ReserveNow Status ---
export const reservationStatusEnum = z.enum([
  'Accepted',
  'Faulted',
  'Occupied',
  'Rejected',
  'Unavailable',
]);

// --- Reset Type ---
export const resetTypeEnum = z.enum(['Hard', 'Soft']);

// --- Reset Status ---
export const resetStatusEnum = z.enum(['Accepted', 'Rejected']);

// --- SendLocalList UpdateType ---
export const updateTypeEnum = z.enum(['Differential', 'Full']);

// --- SendLocalList Status ---
export const updateStatusEnum = z.enum(['Accepted', 'Failed', 'NotSupported', 'VersionMismatch']);

// --- SetChargingProfile Status ---
export const chargingProfileStatusEnum = z.enum(['Accepted', 'Rejected', 'NotSupported']);

// --- StopTransaction Reason ---
export const stopReasonEnum = z.enum([
  'EmergencyStop',
  'EVDisconnected',
  'HardReset',
  'Local',
  'Other',
  'PowerLoss',
  'Reboot',
  'Remote',
  'SoftReset',
  'UnlockCommand',
  'DeAuthorized',
]);

// --- TriggerMessage RequestedMessage ---
export const messageTriggerEnum = z.enum([
  'BootNotification',
  'DiagnosticsStatusNotification',
  'FirmwareStatusNotification',
  'Heartbeat',
  'MeterValues',
  'StatusNotification',
]);

// --- TriggerMessage Status ---
export const triggerMessageStatusEnum = z.enum(['Accepted', 'Rejected', 'NotImplemented']);

// --- UnlockConnector Status ---
export const unlockStatusEnum = z.enum(['Unlocked', 'UnlockFailed', 'NotSupported']);

// --- MeterValues Enums (SampledValue sub-fields) ---
export const measurandEnum = z.enum([
  'Energy.Active.Export.Register',
  'Energy.Active.Import.Register',
  'Energy.Reactive.Export.Register',
  'Energy.Reactive.Import.Register',
  'Energy.Active.Export.Interval',
  'Energy.Active.Import.Interval',
  'Energy.Reactive.Export.Interval',
  'Energy.Reactive.Import.Interval',
  'Power.Active.Export',
  'Power.Active.Import',
  'Power.Offered',
  'Power.Reactive.Export',
  'Power.Reactive.Import',
  'Power.Factor',
  'Current.Import',
  'Current.Export',
  'Current.Offered',
  'Voltage',
  'Frequency',
  'Temperature',
  'SoC',
  'RPM',
]);

export const readingContextEnum = z.enum([
  'Interruption.Begin',
  'Interruption.End',
  'Sample.Clock',
  'Sample.Periodic',
  'Transaction.Begin',
  'Transaction.End',
  'Trigger',
  'Other',
]);

export const valueFormatEnum = z.enum(['Raw', 'SignedData']);

export const locationEnum = z.enum(['Cable', 'EV', 'Inlet', 'Outlet', 'Body']);

export const phaseEnum = z.enum([
  'L1',
  'L2',
  'L3',
  'N',
  'L1-N',
  'L2-N',
  'L3-N',
  'L1-L2',
  'L2-L3',
  'L3-L1',
]);

export const unitEnum = z.enum([
  'Wh',
  'kWh',
  'varh',
  'kvarh',
  'W',
  'kW',
  'VA',
  'kVA',
  'var',
  'kvar',
  'A',
  'V',
  'K',
  'Celcius',
  'Celsius',
  'Fahrenheit',
  'Percent',
]);

// ============================================================
// Object Types
// ============================================================

// --- IdTagInfo (shared across Authorize, StartTransaction, StopTransaction, SendLocalList) ---
export const idTagInfoType = z
  .object({
    expiryDate: z.string().optional().describe('ISO 8601 expiry timestamp'),
    parentIdTag: z.string().max(20).optional().describe('Parent ID tag'),
    status: authorizationStatusEnum.describe('Authorization status'),
  })
  .passthrough()
  .describe('OCPP 1.6 IdTagInfo');

// --- SampledValue ---
export const sampledValueType = z
  .object({
    value: z.string().describe('Sampled value'),
    context: readingContextEnum.optional().describe('Reading context'),
    format: valueFormatEnum.optional().describe('Value format'),
    measurand: measurandEnum.optional().describe('Type of measurement'),
    phase: phaseEnum.optional().describe('Phase'),
    location: locationEnum.optional().describe('Measurement location'),
    unit: unitEnum.optional().describe('Unit of measure'),
  })
  .passthrough()
  .describe('OCPP 1.6 sampled value');

// --- MeterValue ---
export const meterValueType = z
  .object({
    timestamp: z.string().describe('ISO 8601 timestamp'),
    sampledValue: z.array(sampledValueType).describe('Sampled values'),
  })
  .passthrough()
  .describe('OCPP 1.6 meter value');

// --- ChargingSchedulePeriod ---
export const chargingSchedulePeriodType = z
  .object({
    startPeriod: z.number().int().describe('Start of period in seconds from schedule start'),
    limit: z.number().describe('Power or current limit'),
    numberPhases: z.number().int().optional().describe('Number of phases'),
  })
  .passthrough()
  .describe('OCPP 1.6 charging schedule period');

// --- ChargingSchedule ---
export const chargingScheduleType = z
  .object({
    duration: z.number().int().optional().describe('Duration in seconds'),
    startSchedule: z.string().optional().describe('ISO 8601 schedule start'),
    chargingRateUnit: chargingRateUnitEnum.describe('Unit of charging rate (A or W)'),
    chargingSchedulePeriod: z.array(chargingSchedulePeriodType).describe('Schedule periods'),
    minChargingRate: z.number().optional().describe('Minimum charging rate'),
  })
  .passthrough()
  .describe('OCPP 1.6 charging schedule');

// --- ChargingProfile ---
export const chargingProfileType = z
  .object({
    chargingProfileId: z.number().int().describe('Unique profile identifier'),
    transactionId: z.number().int().optional().describe('Transaction this profile applies to'),
    stackLevel: z.number().int().describe('Stack level for profile stacking'),
    chargingProfilePurpose: chargingProfilePurposeEnum.describe('Profile purpose'),
    chargingProfileKind: chargingProfileKindEnum.describe('Profile kind'),
    recurrencyKind: recurrencyKindEnum.optional().describe('Recurrency kind'),
    validFrom: z.string().optional().describe('ISO 8601 validity start'),
    validTo: z.string().optional().describe('ISO 8601 validity end'),
    chargingSchedule: chargingScheduleType.describe('Charging schedule'),
  })
  .passthrough()
  .describe('OCPP 1.6 charging profile');

// --- AuthorizationData (SendLocalList entry) ---
export const authorizationDataType = z
  .object({
    idTag: z.string().max(20).describe('ID tag'),
    idTagInfo: idTagInfoType.optional().describe('ID tag info'),
  })
  .passthrough()
  .describe('OCPP 1.6 authorization data');

// --- KeyValue (GetConfiguration response) ---
export const keyValueType = z
  .object({
    key: z.string().max(50).describe('Configuration key name'),
    readonly: z.boolean().describe('Whether the key is read-only'),
    value: z.string().max(500).optional().describe('Configuration value'),
  })
  .passthrough()
  .describe('OCPP 1.6 configuration key-value');

// ============================================================
// Request/Response Types
// ============================================================

// --- Authorize ---
export const authorizeRequestType = z
  .object({
    idTag: z.string().max(20).describe('ID tag to authorize'),
  })
  .passthrough();

export const authorizeResponseType = z
  .object({
    idTagInfo: idTagInfoType.describe('Authorization result'),
  })
  .passthrough();

// --- BootNotification ---
export const bootNotificationRequestType = z
  .object({
    chargePointVendor: z.string().max(20).describe('Charge point vendor'),
    chargePointModel: z.string().max(20).describe('Charge point model'),
    chargePointSerialNumber: z.string().max(25).optional().describe('Serial number'),
    chargeBoxSerialNumber: z.string().max(25).optional().describe('Charge box serial number'),
    firmwareVersion: z.string().max(50).optional().describe('Firmware version'),
    iccid: z.string().max(20).optional().describe('SIM ICCID'),
    imsi: z.string().max(20).optional().describe('SIM IMSI'),
    meterType: z.string().max(25).optional().describe('Meter type'),
    meterSerialNumber: z.string().max(25).optional().describe('Meter serial number'),
  })
  .passthrough();

export const bootNotificationResponseType = z
  .object({
    status: registrationStatusEnum.describe('Registration status'),
    currentTime: z.string().describe('ISO 8601 current time'),
    interval: z.number().int().describe('Heartbeat interval in seconds'),
  })
  .passthrough();

// --- CancelReservation ---
export const cancelReservationRequestType = z
  .object({
    reservationId: z.number().int().describe('Reservation ID to cancel'),
  })
  .passthrough();

export const cancelReservationResponseType = z
  .object({
    status: cancelReservationStatusEnum.describe('Cancellation result'),
  })
  .passthrough();

// --- ChangeAvailability ---
export const changeAvailabilityRequestType = z
  .object({
    connectorId: z.number().int().describe('Connector ID (0 = charge point)'),
    type: availabilityTypeEnum.describe('Availability type'),
  })
  .passthrough();

export const changeAvailabilityResponseType = z
  .object({
    status: availabilityStatusEnum.describe('Availability change result'),
  })
  .passthrough();

// --- ChangeConfiguration ---
export const changeConfigurationRequestType = z
  .object({
    key: z.string().max(50).describe('Configuration key'),
    value: z.string().max(500).describe('Configuration value'),
  })
  .passthrough();

export const changeConfigurationResponseType = z
  .object({
    status: configurationStatusEnum.describe('Configuration change result'),
  })
  .passthrough();

// --- ClearCache ---
export const clearCacheRequestType = z.object({}).passthrough();

export const clearCacheResponseType = z
  .object({
    status: clearCacheStatusEnum.describe('Clear cache result'),
  })
  .passthrough();

// --- ClearChargingProfile ---
export const clearChargingProfileRequestType = z
  .object({
    id: z.number().int().optional().describe('Charging profile ID'),
    connectorId: z.number().int().optional().describe('Connector ID'),
    chargingProfilePurpose: chargingProfilePurposeEnum
      .optional()
      .describe('Profile purpose filter'),
    stackLevel: z.number().int().optional().describe('Stack level filter'),
  })
  .passthrough();

export const clearChargingProfileResponseType = z
  .object({
    status: clearChargingProfileStatusEnum.describe('Clear result'),
  })
  .passthrough();

// --- DataTransfer ---
export const dataTransferRequestType = z
  .object({
    vendorId: z.string().max(255).describe('Vendor identifier'),
    messageId: z.string().max(50).optional().describe('Message identifier'),
    data: z.string().optional().describe('Data payload'),
  })
  .passthrough();

export const dataTransferResponseType = z
  .object({
    status: dataTransferStatusEnum.describe('Data transfer result'),
    data: z.string().optional().describe('Response data'),
  })
  .passthrough();

// --- DiagnosticsStatusNotification ---
export const diagnosticsStatusNotificationRequestType = z
  .object({
    status: diagnosticsStatusEnum.describe('Diagnostics upload status'),
  })
  .passthrough();

export const diagnosticsStatusNotificationResponseType = z.object({}).passthrough();

// --- FirmwareStatusNotification ---
export const firmwareStatusNotificationRequestType = z
  .object({
    status: firmwareStatusEnum.describe('Firmware update status'),
  })
  .passthrough();

export const firmwareStatusNotificationResponseType = z.object({}).passthrough();

// --- GetCompositeSchedule ---
export const getCompositeScheduleRequestType = z
  .object({
    connectorId: z.number().int().describe('Connector ID'),
    duration: z.number().int().describe('Duration in seconds'),
    chargingRateUnit: chargingRateUnitEnum.optional().describe('Preferred rate unit'),
  })
  .passthrough();

export const getCompositeScheduleResponseType = z
  .object({
    status: getCompositeScheduleStatusEnum.describe('Request result'),
    connectorId: z.number().int().optional().describe('Connector ID'),
    scheduleStart: z.string().optional().describe('ISO 8601 schedule start'),
    chargingSchedule: chargingScheduleType.optional().describe('Composite schedule'),
  })
  .passthrough();

// --- GetConfiguration ---
export const getConfigurationRequestType = z
  .object({
    key: z.array(z.string().max(50)).optional().describe('Keys to retrieve'),
  })
  .passthrough();

export const getConfigurationResponseType = z
  .object({
    configurationKey: z.array(keyValueType).optional().describe('Known configuration keys'),
    unknownKey: z.array(z.string().max(50)).optional().describe('Unknown requested keys'),
  })
  .passthrough();

// --- GetDiagnostics ---
export const getDiagnosticsRequestType = z
  .object({
    location: z.string().describe('URI for diagnostics upload'),
    retries: z.number().int().optional().describe('Number of retries'),
    retryInterval: z.number().int().optional().describe('Seconds between retries'),
    startTime: z.string().optional().describe('ISO 8601 log start time'),
    stopTime: z.string().optional().describe('ISO 8601 log end time'),
  })
  .passthrough();

export const getDiagnosticsResponseType = z
  .object({
    fileName: z.string().max(255).optional().describe('Diagnostics file name'),
  })
  .passthrough();

// --- GetLocalListVersion ---
export const getLocalListVersionRequestType = z.object({}).passthrough();

export const getLocalListVersionResponseType = z
  .object({
    listVersion: z.number().int().describe('Local list version number'),
  })
  .passthrough();

// --- Heartbeat ---
export const heartbeatRequestType = z.object({}).passthrough();

export const heartbeatResponseType = z
  .object({
    currentTime: z.string().describe('ISO 8601 current time'),
  })
  .passthrough();

// --- MeterValues ---
export const meterValuesRequestType = z
  .object({
    connectorId: z.number().int().describe('Connector ID'),
    transactionId: z.number().int().optional().describe('Transaction ID'),
    meterValue: z.array(meterValueType).describe('Meter values'),
  })
  .passthrough();

export const meterValuesResponseType = z.object({}).passthrough();

// --- RemoteStartTransaction ---
export const remoteStartTransactionRequestType = z
  .object({
    connectorId: z.number().int().optional().describe('Connector ID'),
    idTag: z.string().max(20).describe('ID tag for authorization'),
    chargingProfile: chargingProfileType.optional().describe('Charging profile'),
  })
  .passthrough();

export const remoteStartTransactionResponseType = z
  .object({
    status: remoteStartStopStatusEnum.describe('Remote start result'),
  })
  .passthrough();

// --- RemoteStopTransaction ---
export const remoteStopTransactionRequestType = z
  .object({
    transactionId: z.number().int().describe('Transaction ID to stop'),
  })
  .passthrough();

export const remoteStopTransactionResponseType = z
  .object({
    status: remoteStartStopStatusEnum.describe('Remote stop result'),
  })
  .passthrough();

// --- ReserveNow ---
export const reserveNowRequestType = z
  .object({
    connectorId: z.number().int().describe('Connector ID'),
    expiryDate: z.string().describe('ISO 8601 reservation expiry'),
    idTag: z.string().max(20).describe('ID tag for reservation'),
    parentIdTag: z.string().max(20).optional().describe('Parent ID tag'),
    reservationId: z.number().int().describe('Reservation ID'),
  })
  .passthrough();

export const reserveNowResponseType = z
  .object({
    status: reservationStatusEnum.describe('Reservation result'),
  })
  .passthrough();

// --- Reset ---
export const resetRequestType = z
  .object({
    type: resetTypeEnum.describe('Reset type'),
  })
  .passthrough();

export const resetResponseType = z
  .object({
    status: resetStatusEnum.describe('Reset result'),
  })
  .passthrough();

// --- SendLocalList ---
export const sendLocalListRequestType = z
  .object({
    listVersion: z.number().int().describe('List version number'),
    localAuthorizationList: z
      .array(authorizationDataType)
      .optional()
      .describe('Authorization entries'),
    updateType: updateTypeEnum.describe('Update type (Differential or Full)'),
  })
  .passthrough();

export const sendLocalListResponseType = z
  .object({
    status: updateStatusEnum.describe('Update result'),
  })
  .passthrough();

// --- SetChargingProfile ---
export const setChargingProfileRequestType = z
  .object({
    connectorId: z.number().int().describe('Connector ID'),
    csChargingProfiles: chargingProfileType.describe('Charging profile to set'),
  })
  .passthrough();

export const setChargingProfileResponseType = z
  .object({
    status: chargingProfileStatusEnum.describe('Set profile result'),
  })
  .passthrough();

// --- StartTransaction ---
export const startTransactionRequestType = z
  .object({
    connectorId: z.number().int().describe('Connector ID'),
    idTag: z.string().max(20).describe('ID tag'),
    meterStart: z.number().int().describe('Meter value at start in Wh'),
    reservationId: z.number().int().optional().describe('Reservation ID if applicable'),
    timestamp: z.string().describe('ISO 8601 transaction start time'),
  })
  .passthrough();

export const startTransactionResponseType = z
  .object({
    idTagInfo: idTagInfoType.describe('Authorization result'),
    transactionId: z.number().int().describe('Assigned transaction ID'),
  })
  .passthrough();

// --- StatusNotification ---
export const statusNotificationRequestType = z
  .object({
    connectorId: z.number().int().describe('Connector ID (0 = charge point)'),
    errorCode: chargePointErrorCodeEnum.describe('Error code'),
    info: z.string().max(50).optional().describe('Additional info'),
    status: chargePointStatusEnum.describe('Connector status'),
    timestamp: z.string().optional().describe('ISO 8601 timestamp'),
    vendorId: z.string().max(255).optional().describe('Vendor identifier'),
    vendorErrorCode: z.string().max(50).optional().describe('Vendor-specific error code'),
  })
  .passthrough();

export const statusNotificationResponseType = z.object({}).passthrough();

// --- StopTransaction ---
export const stopTransactionRequestType = z
  .object({
    idTag: z.string().max(20).optional().describe('ID tag'),
    meterStop: z.number().int().describe('Meter value at stop in Wh'),
    timestamp: z.string().describe('ISO 8601 transaction stop time'),
    transactionId: z.number().int().describe('Transaction ID'),
    reason: stopReasonEnum.optional().describe('Reason for stopping'),
    transactionData: z.array(meterValueType).optional().describe('Transaction meter data'),
  })
  .passthrough();

export const stopTransactionResponseType = z
  .object({
    idTagInfo: idTagInfoType.optional().describe('Authorization result'),
  })
  .passthrough();

// --- TriggerMessage ---
export const triggerMessageRequestType = z
  .object({
    requestedMessage: messageTriggerEnum.describe('Message type to trigger'),
    connectorId: z.number().int().optional().describe('Connector ID'),
  })
  .passthrough();

export const triggerMessageResponseType = z
  .object({
    status: triggerMessageStatusEnum.describe('Trigger result'),
  })
  .passthrough();

// --- UnlockConnector ---
export const unlockConnectorRequestType = z
  .object({
    connectorId: z.number().int().describe('Connector ID to unlock'),
  })
  .passthrough();

export const unlockConnectorResponseType = z
  .object({
    status: unlockStatusEnum.describe('Unlock result'),
  })
  .passthrough();

// --- UpdateFirmware ---
export const updateFirmwareRequestType = z
  .object({
    location: z.string().describe('URI of firmware image'),
    retries: z.number().int().optional().describe('Number of retries'),
    retrieveDate: z.string().describe('ISO 8601 retrieve date'),
    retryInterval: z.number().int().optional().describe('Seconds between retries'),
  })
  .passthrough();

export const updateFirmwareResponseType = z.object({}).passthrough();

// ============================================================
// Inferred TypeScript Types
// ============================================================

// Enum types
export type AuthorizationStatus = z.infer<typeof authorizationStatusEnum>;
export type RegistrationStatus = z.infer<typeof registrationStatusEnum>;
export type CancelReservationStatus = z.infer<typeof cancelReservationStatusEnum>;
export type AvailabilityType = z.infer<typeof availabilityTypeEnum>;
export type AvailabilityStatus = z.infer<typeof availabilityStatusEnum>;
export type ConfigurationStatus = z.infer<typeof configurationStatusEnum>;
export type ClearCacheStatus = z.infer<typeof clearCacheStatusEnum>;
export type ChargingProfilePurpose = z.infer<typeof chargingProfilePurposeEnum>;
export type ClearChargingProfileStatus = z.infer<typeof clearChargingProfileStatusEnum>;
export type ChargingProfileKind = z.infer<typeof chargingProfileKindEnum>;
export type RecurrencyKind = z.infer<typeof recurrencyKindEnum>;
export type ChargingRateUnit = z.infer<typeof chargingRateUnitEnum>;
export type DataTransferStatus = z.infer<typeof dataTransferStatusEnum>;
export type DiagnosticsStatus = z.infer<typeof diagnosticsStatusEnum>;
export type FirmwareStatus = z.infer<typeof firmwareStatusEnum>;
export type GetCompositeScheduleStatus = z.infer<typeof getCompositeScheduleStatusEnum>;
export type ChargePointStatus = z.infer<typeof chargePointStatusEnum>;
export type ChargePointErrorCode = z.infer<typeof chargePointErrorCodeEnum>;
export type RemoteStartStopStatus = z.infer<typeof remoteStartStopStatusEnum>;
export type ReservationStatus = z.infer<typeof reservationStatusEnum>;
export type ResetType = z.infer<typeof resetTypeEnum>;
export type ResetStatus = z.infer<typeof resetStatusEnum>;
export type UpdateType = z.infer<typeof updateTypeEnum>;
export type UpdateStatus = z.infer<typeof updateStatusEnum>;
export type ChargingProfileStatus = z.infer<typeof chargingProfileStatusEnum>;
export type StopReason = z.infer<typeof stopReasonEnum>;
export type MessageTrigger = z.infer<typeof messageTriggerEnum>;
export type TriggerMessageStatus = z.infer<typeof triggerMessageStatusEnum>;
export type UnlockStatus = z.infer<typeof unlockStatusEnum>;
export type Measurand = z.infer<typeof measurandEnum>;
export type ReadingContext = z.infer<typeof readingContextEnum>;
export type ValueFormat = z.infer<typeof valueFormatEnum>;
export type Location = z.infer<typeof locationEnum>;
export type Phase = z.infer<typeof phaseEnum>;
export type Unit = z.infer<typeof unitEnum>;

// Object types
export type IdTagInfoType = z.infer<typeof idTagInfoType>;
export type SampledValueType = z.infer<typeof sampledValueType>;
export type MeterValueType = z.infer<typeof meterValueType>;
export type ChargingSchedulePeriodType = z.infer<typeof chargingSchedulePeriodType>;
export type ChargingScheduleType = z.infer<typeof chargingScheduleType>;
export type ChargingProfileType = z.infer<typeof chargingProfileType>;
export type AuthorizationDataType = z.infer<typeof authorizationDataType>;
export type KeyValueType = z.infer<typeof keyValueType>;

// Request/Response types
export type AuthorizeRequest = z.infer<typeof authorizeRequestType>;
export type AuthorizeResponse = z.infer<typeof authorizeResponseType>;
export type BootNotificationRequest = z.infer<typeof bootNotificationRequestType>;
export type BootNotificationResponse = z.infer<typeof bootNotificationResponseType>;
export type CancelReservationRequest = z.infer<typeof cancelReservationRequestType>;
export type CancelReservationResponse = z.infer<typeof cancelReservationResponseType>;
export type ChangeAvailabilityRequest = z.infer<typeof changeAvailabilityRequestType>;
export type ChangeAvailabilityResponse = z.infer<typeof changeAvailabilityResponseType>;
export type ChangeConfigurationRequest = z.infer<typeof changeConfigurationRequestType>;
export type ChangeConfigurationResponse = z.infer<typeof changeConfigurationResponseType>;
export type ClearCacheRequest = z.infer<typeof clearCacheRequestType>;
export type ClearCacheResponse = z.infer<typeof clearCacheResponseType>;
export type ClearChargingProfileRequest = z.infer<typeof clearChargingProfileRequestType>;
export type ClearChargingProfileResponse = z.infer<typeof clearChargingProfileResponseType>;
export type DataTransferRequest = z.infer<typeof dataTransferRequestType>;
export type DataTransferResponse = z.infer<typeof dataTransferResponseType>;
export type DiagnosticsStatusNotificationRequest = z.infer<
  typeof diagnosticsStatusNotificationRequestType
>;
export type DiagnosticsStatusNotificationResponse = z.infer<
  typeof diagnosticsStatusNotificationResponseType
>;
export type FirmwareStatusNotificationRequest = z.infer<
  typeof firmwareStatusNotificationRequestType
>;
export type FirmwareStatusNotificationResponse = z.infer<
  typeof firmwareStatusNotificationResponseType
>;
export type GetCompositeScheduleRequest = z.infer<typeof getCompositeScheduleRequestType>;
export type GetCompositeScheduleResponse = z.infer<typeof getCompositeScheduleResponseType>;
export type GetConfigurationRequest = z.infer<typeof getConfigurationRequestType>;
export type GetConfigurationResponse = z.infer<typeof getConfigurationResponseType>;
export type GetDiagnosticsRequest = z.infer<typeof getDiagnosticsRequestType>;
export type GetDiagnosticsResponse = z.infer<typeof getDiagnosticsResponseType>;
export type GetLocalListVersionRequest = z.infer<typeof getLocalListVersionRequestType>;
export type GetLocalListVersionResponse = z.infer<typeof getLocalListVersionResponseType>;
export type HeartbeatRequest = z.infer<typeof heartbeatRequestType>;
export type HeartbeatResponse = z.infer<typeof heartbeatResponseType>;
export type MeterValuesRequest = z.infer<typeof meterValuesRequestType>;
export type MeterValuesResponse = z.infer<typeof meterValuesResponseType>;
export type RemoteStartTransactionRequest = z.infer<typeof remoteStartTransactionRequestType>;
export type RemoteStartTransactionResponse = z.infer<typeof remoteStartTransactionResponseType>;
export type RemoteStopTransactionRequest = z.infer<typeof remoteStopTransactionRequestType>;
export type RemoteStopTransactionResponse = z.infer<typeof remoteStopTransactionResponseType>;
export type ReserveNowRequest = z.infer<typeof reserveNowRequestType>;
export type ReserveNowResponse = z.infer<typeof reserveNowResponseType>;
export type ResetRequest = z.infer<typeof resetRequestType>;
export type ResetResponse = z.infer<typeof resetResponseType>;
export type SendLocalListRequest = z.infer<typeof sendLocalListRequestType>;
export type SendLocalListResponse = z.infer<typeof sendLocalListResponseType>;
export type SetChargingProfileRequest = z.infer<typeof setChargingProfileRequestType>;
export type SetChargingProfileResponse = z.infer<typeof setChargingProfileResponseType>;
export type StartTransactionRequest = z.infer<typeof startTransactionRequestType>;
export type StartTransactionResponse = z.infer<typeof startTransactionResponseType>;
export type StatusNotificationRequest = z.infer<typeof statusNotificationRequestType>;
export type StatusNotificationResponse = z.infer<typeof statusNotificationResponseType>;
export type StopTransactionRequest = z.infer<typeof stopTransactionRequestType>;
export type StopTransactionResponse = z.infer<typeof stopTransactionResponseType>;
export type TriggerMessageRequest = z.infer<typeof triggerMessageRequestType>;
export type TriggerMessageResponse = z.infer<typeof triggerMessageResponseType>;
export type UnlockConnectorRequest = z.infer<typeof unlockConnectorRequestType>;
export type UnlockConnectorResponse = z.infer<typeof unlockConnectorResponseType>;
export type UpdateFirmwareRequest = z.infer<typeof updateFirmwareRequestType>;
export type UpdateFirmwareResponse = z.infer<typeof updateFirmwareResponseType>;
