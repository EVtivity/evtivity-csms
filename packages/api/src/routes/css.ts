// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, count, sql } from 'drizzle-orm';
import { db } from '@evtivity/database';
import {
  cssStations,
  cssEvses,
  cssConfigVariables,
  cssTransactions,
  chargingStations,
  evses,
  connectors,
} from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { errorResponse, itemResponse, paginatedResponse } from '../lib/response-schemas.js';
import { paginationQuery } from '../lib/pagination.js';
import { getPubSub } from '../lib/pubsub.js';
import {
  bootReasonEnum,
  certificateActionEnum,
  certificateSigningUseEnum,
  certificateStatusSourceEnum,
  chargingLimitType,
  chargingNeedsType,
  chargingProfileType,
  chargingScheduleType,
  chargingStateEnum,
  derControlEnum,
  energyTransferModeEnum,
  eventDataType,
  firmwareStatusEnum,
  gridEventFaultEnum,
  hashAlgorithmEnum,
  messageInfoType,
  meterValueType,
  monitoringDataType,
  paymentStatusEnum,
  publishFirmwareStatusEnum,
  reasonEnum,
  sampledValueType,
  streamDataElementType,
  triggerReasonEnum,
  uploadLogStatusEnum,
} from '../lib/ocpp-zod-types-v21.js';
import { meterValueType as meterValueType16 } from '../lib/ocpp-zod-types-v16.js';
import { OCPP21_CONFIG_DEFAULTS, OCPP16_CONFIG_DEFAULTS } from '../lib/css-config-defaults.js';
import { authorize } from '../middleware/rbac.js';

// ---------------------------------------------------------------------------
// Action version compatibility map
// ---------------------------------------------------------------------------

// High-level actions available on all OCPP versions (no version prefix in URL)
export const HIGH_LEVEL_ACTIONS = [
  'plugIn',
  'authorize',
  'startCharging',
  'stopCharging',
  'unplug',
  'injectFault',
  'clearFault',
  'goOffline',
  'comeOnline',
] as const;

// Station-initiated messages registered under both v16/ and v21/ prefixes
export const STATION_MESSAGE_ACTIONS = [
  'sendBootNotification',
  'sendHeartbeat',
  'sendStatusNotification',
  'sendMeterValues',
  'sendAuthorize',
  'sendFirmwareStatusNotification',
  'sendDataTransfer',
] as const;

export const ACTION_VERSIONS: Record<string, 'all' | 'ocpp1.6' | 'ocpp2.1'> = {
  // High-level actions (all versions, no version prefix)
  plugIn: 'all',
  authorize: 'all',
  startCharging: 'all',
  stopCharging: 'all',
  unplug: 'all',
  injectFault: 'all',
  clearFault: 'all',
  goOffline: 'all',
  comeOnline: 'all',

  // OCPP 2.1 only
  sendTransactionEvent: 'ocpp2.1',
  sendLogStatusNotification: 'ocpp2.1',
  sendSecurityEventNotification: 'ocpp2.1',
  sendNotifyEvent: 'ocpp2.1',
  sendNotifyReport: 'ocpp2.1',
  sendNotifyMonitoringReport: 'ocpp2.1',
  sendNotifyChargingLimit: 'ocpp2.1',
  sendNotifyEVChargingNeeds: 'ocpp2.1',
  sendClearedChargingLimit: 'ocpp2.1',
  sendReservationStatusUpdate: 'ocpp2.1',
  sendNotifyDisplayMessages: 'ocpp2.1',
  sendNotifyCustomerInformation: 'ocpp2.1',
  sendSignCertificate: 'ocpp2.1',
  sendGetCertificateStatus: 'ocpp2.1',
  sendGetTransactionStatus: 'ocpp2.1',
  sendReportChargingProfiles: 'ocpp2.1',
  sendNotifyEVChargingSchedule: 'ocpp2.1',
  sendNotifySettlement: 'ocpp2.1',
  sendNotifyPriorityCharging: 'ocpp2.1',
  sendNotifyQRCodeScanned: 'ocpp2.1',
  sendNotifyAllowedEnergyTransfer: 'ocpp2.1',
  sendGet15118EVCertificate: 'ocpp2.1',
  sendGetCertificateChainStatus: 'ocpp2.1',
  sendPublishFirmwareStatusNotification: 'ocpp2.1',
  sendNotifyWebPaymentStarted: 'ocpp2.1',
  sendNotifyPeriodicEventStream: 'ocpp2.1',
  sendNotifyDERAlarm: 'ocpp2.1',
  sendNotifyDERStartStop: 'ocpp2.1',
  sendReportDERControl: 'ocpp2.1',
  sendBatterySwap: 'ocpp2.1',
  sendPullDynamicScheduleUpdate: 'ocpp2.1',
  sendVatNumberValidation: 'ocpp2.1',

  // OCPP 1.6 only
  sendStartTransaction: 'ocpp1.6',
  sendStopTransaction: 'ocpp1.6',
  sendDiagnosticsStatusNotification: 'ocpp1.6',
};

// ---------------------------------------------------------------------------
// Default config variables seeded per protocol
// ---------------------------------------------------------------------------

export { OCPP21_CONFIG_DEFAULTS, OCPP16_CONFIG_DEFAULTS } from '../lib/css-config-defaults.js';

// ---------------------------------------------------------------------------
// Request / response schemas
// ---------------------------------------------------------------------------

const createStationEvse = z.object({
  evseId: z.number().int().min(1).describe('EVSE ID'),
  connectorId: z.number().int().min(1).optional().describe('Connector ID (defaults to 1)'),
  connectorType: z
    .enum(['ac_type2', 'ac_type1', 'dc_ccs2', 'dc_ccs1', 'dc_chademo'])
    .optional()
    .describe('Connector type'),
  maxPowerW: z.number().int().optional().describe('Max power in watts'),
  phases: z.number().int().optional().describe('Number of phases'),
  voltage: z.number().int().optional().describe('Voltage'),
});

const createStationBody = z.object({
  stationId: z.string().min(1).describe('Station identifier string'),
  ocppProtocol: z.enum(['ocpp1.6', 'ocpp2.1']).optional().describe('OCPP protocol version'),
  securityProfile: z.number().int().min(0).max(3).optional().describe('Security profile (0-3)'),
  targetUrl: z.string().url().describe('Target OCPP WebSocket URL'),
  password: z.string().optional().describe('Basic auth password'),
  model: z.string().optional().describe('Station model'),
  serialNumber: z.string().optional().describe('Serial number'),
  firmwareVersion: z.string().optional().describe('Firmware version'),
  clientCert: z.string().optional().describe('Client certificate PEM'),
  clientKey: z.string().optional().describe('Client private key PEM'),
  caCert: z.string().optional().describe('CA certificate PEM'),
  sourceType: z.enum(['api', 'chaos', 'cli']).optional().describe('Source type'),
  evses: z.array(createStationEvse).min(1).describe('EVSE configurations'),
});

const updateStationBody = z.object({
  ocppProtocol: z.enum(['ocpp1.6', 'ocpp2.1']).optional(),
  securityProfile: z.number().int().min(0).max(3).optional(),
  targetUrl: z.string().url().optional(),
  password: z.string().optional(),
  model: z.string().optional(),
  serialNumber: z.string().nullable().optional(),
  firmwareVersion: z.string().optional(),
  clientCert: z.string().nullable().optional(),
  clientKey: z.string().nullable().optional(),
  caCert: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

const stationIdParams = z.object({
  stationId: z.string().describe('CSS station ID'),
});

const stationItem = z.object({}).passthrough();

const actionResponse = z
  .object({
    commandId: z.string(),
    data: z.record(z.unknown()).optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Action body schemas
// ---------------------------------------------------------------------------

// --- High-level actions (all versions) ---

const plugInBody = z.object({
  evseId: z.number().int().describe('EVSE ID'),
});

const authorizeBody = z.object({
  evseId: z.number().int().describe('EVSE ID'),
  idToken: z.string().describe('ID token value'),
  tokenType: z.string().optional().describe('Token type (default: ISO14443)'),
});

const startChargingBody = z.object({
  evseId: z.number().int().describe('EVSE ID'),
  idToken: z.string().describe('ID token value'),
  tokenType: z.string().optional().describe('Token type (default: ISO14443)'),
});

const stopChargingBody = z.object({
  evseId: z.number().int().describe('EVSE ID'),
  reason: z
    .enum([
      'DeAuthorized',
      'EmergencyStop',
      'EnergyLimitReached',
      'EVDisconnected',
      'GroundFault',
      'HardReset',
      'ImmediateReset',
      'Local',
      'LocalOutOfCredit',
      'MasterPass',
      'Other',
      'OvercurrentFault',
      'PowerLoss',
      'PowerQuality',
      'Reboot',
      'Remote',
      'ReqEnergyTransferRejected',
      'SOCLimitReached',
      'SoftReset',
      'StoppedByEV',
      'TimeLimitReached',
      'Timeout',
      'UnlockCommand',
    ])
    .optional()
    .describe('Stop reason (Local, Remote, etc.)'),
});

const unplugBody = z.object({
  evseId: z.number().int().describe('EVSE ID'),
});

const injectFaultBody = z.object({
  evseId: z.number().int().describe('EVSE ID'),
  errorCode: z
    .enum([
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
    ])
    .describe(
      'Error code (1.6: GroundFailure, OverCurrentFailure, HighTemperature, InternalError, etc.)',
    ),
});

const clearFaultBody = z.object({
  evseId: z.number().int().describe('EVSE ID'),
});

const goOfflineBody = z.object({});

const comeOnlineBody = z.object({});

// --- Station-initiated messages (all versions) ---

const sendBootNotificationBody = z.object({
  reason: bootReasonEnum
    .optional()
    .describe('Boot reason (2.1 only: PowerUp, Watchdog, ScheduledReset, etc.)'),
});

const sendHeartbeatBody = z.object({});

const sendStatusNotificationBody = z.object({
  evseId: z.number().int().describe('EVSE ID'),
  connectorId: z.number().int().describe('Connector ID'),
  status: z
    .enum([
      'Available',
      'Occupied',
      'Reserved',
      'Unavailable',
      'Faulted',
      'Preparing',
      'Charging',
      'SuspendedEVSE',
      'SuspendedEV',
      'Finishing',
    ])
    .describe(
      'Connector status (2.1: Available, Occupied, Reserved, Unavailable, Faulted; 1.6: Available, Preparing, Charging, SuspendedEVSE, SuspendedEV, Finishing, Reserved, Unavailable, Faulted)',
    ),
  errorCode: z
    .enum([
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
    ])
    .optional()
    .describe(
      'Error code (1.6 only: NoError, ConnectorLockFailure, GroundFailure, HighTemperature, InternalError, OverCurrentFailure, etc.)',
    ),
});

const sendMeterValuesBody = z.object({
  evseId: z.number().int().describe('EVSE ID'),
  sampledValues: z
    .array(sampledValueType)
    .optional()
    .describe('Sampled values array (auto-generated if omitted)'),
  transactionId: z.string().optional().describe('Transaction ID (1.6 only)'),
});

const sendAuthorizeBody = z.object({
  idToken: z.string().describe('ID token value'),
  tokenType: z.string().optional().describe('Token type (default: ISO14443)'),
});

const sendFirmwareStatusNotificationBody = z.object({
  status: firmwareStatusEnum.describe(
    'Firmware status (Downloading, Downloaded, DownloadFailed, Idle, InstallationFailed, Installing, Installed, etc.)',
  ),
  requestId: z.number().int().optional().describe('Request ID (2.1 only, defaults to 0)'),
});

const sendDataTransferBody = z.object({
  vendorId: z.string().describe('Vendor identifier'),
  messageId: z.string().optional().describe('Message identifier'),
  data: z.string().optional().describe('Data payload'),
});

// --- OCPP 2.1 only actions ---

const sendTransactionEventBody = z.object({
  evseId: z.number().int().describe('EVSE ID'),
  eventType: z.enum(['Started', 'Updated', 'Ended']).describe('Transaction event type'),
  triggerReason: triggerReasonEnum.describe(
    'Trigger reason (Authorized, CablePluggedIn, ChargingStateChanged, RemoteStart, RemoteStop, StopAuthorized, etc.)',
  ),
  transactionId: z.string().describe('Transaction ID (UUID)'),
  chargingState: chargingStateEnum
    .optional()
    .describe('Charging state (EVConnected, Charging, SuspendedEV, SuspendedEVSE, Idle)'),
  stoppedReason: reasonEnum
    .optional()
    .describe(
      'Stopped reason (Local, Remote, DeAuthorized, EVDisconnected, EmergencyStop, EnergyLimitReached, etc.)',
    ),
  idToken: z.string().optional().describe('ID token value'),
  tokenType: z.string().optional().describe('Token type'),
  seqNo: z.number().int().optional().describe('Sequence number'),
  meterValue: z.array(meterValueType).optional().describe('Meter value array'),
});

const sendLogStatusNotificationBody = z.object({
  status: uploadLogStatusEnum.describe(
    'Log status (Idle, Uploaded, UploadFailure, Uploading, PermissionDenied, etc.)',
  ),
  requestId: z.number().int().optional().describe('Request ID (defaults to 0)'),
});

const sendSecurityEventNotificationBody = z.object({
  type: z
    .string()
    .describe(
      'Security event type (FirmwareUpdated, SettingSystemTime, MemoryExhaustion, TamperDetectionActivated, etc.)',
    ),
  timestamp: z.string().describe('ISO 8601 timestamp'),
  techInfo: z.string().optional().describe('Additional information about the security event'),
});

const sendNotifyEventBody = z.object({
  generatedAt: z.string().describe('ISO 8601 timestamp when the message was generated'),
  seqNo: z.number().int().describe('Sequence number (first message starts at 0)'),
  eventData: z
    .array(eventDataType)
    .min(1)
    .describe(
      'Event data array. Each item: { eventId, timestamp, trigger, actualValue, eventNotificationType, component: { name }, variable: { name } }',
    ),
  tbc: z.boolean().optional().describe('To be continued (default: false)'),
});

const sendNotifyReportBody = z.object({
  requestId: z
    .number()
    .int()
    .describe('Request ID from GetBaseReport or GetReport that triggered this report'),
});

const sendNotifyMonitoringReportBody = z.object({
  requestId: z.number().int().describe('Request ID'),
  seqNo: z.number().int().describe('Sequence number (first message starts at 0)'),
  generatedAt: z.string().describe('ISO 8601 timestamp when the message was generated'),
  monitor: z
    .array(monitoringDataType)
    .optional()
    .describe(
      'Monitor data array. Each item: { component: { name }, variable: { name }, variableMonitoring: [...] }',
    ),
  tbc: z.boolean().optional().describe('To be continued (default: false)'),
});

const sendNotifyChargingLimitBody = z.object({
  chargingLimit: chargingLimitType.describe(
    'Charging limit object (e.g. { chargingLimitSource, isGridCritical })',
  ),
  chargingSchedule: z.array(chargingScheduleType).optional().describe('Charging schedule array'),
});

const sendNotifyEVChargingNeedsBody = z.object({
  evseId: z.number().int().describe('EVSE ID'),
  chargingNeeds: chargingNeedsType.describe(
    'Charging needs object (e.g. { requestedEnergyTransfer, acChargingParameters, dcChargingParameters })',
  ),
});

const sendClearedChargingLimitBody = z.object({
  chargingLimitSource: z.string().describe('Charging limit source (CSO, SO, OEM, EMS, Other)'),
  evseId: z.number().int().optional().describe('EVSE ID'),
});

const sendReservationStatusUpdateBody = z.object({
  reservationId: z.number().int().describe('Reservation ID'),
  reservationUpdateStatus: z
    .enum(['Expired', 'Removed', 'NoTransaction'])
    .describe('Reservation update status'),
});

const sendNotifyDisplayMessagesBody = z.object({
  requestId: z.number().int().describe('Request ID'),
  messageInfo: z
    .array(messageInfoType)
    .optional()
    .describe(
      'Message info array. Each item: { id, priority, state, startDateTime, endDateTime, message: { content, format, language } }',
    ),
  tbc: z.boolean().optional().describe('To be continued (default: false)'),
});

const sendNotifyCustomerInformationBody = z.object({
  requestId: z.number().int().describe('Request ID'),
  data: z.string().describe('Customer information data string'),
  seqNo: z.number().int().describe('Sequence number (first message starts at 0)'),
  generatedAt: z.string().describe('ISO 8601 timestamp when the message was generated'),
  tbc: z.boolean().optional().describe('To be continued (default: false)'),
});

const sendSignCertificateBody = z.object({
  csr: z.string().describe('PEM-encoded Certificate Signing Request (CSR)'),
  certificateType: certificateSigningUseEnum
    .optional()
    .describe(
      'Certificate type (ChargingStationCertificate, V2GCertificate, V2G20Certificate; default: ChargingStationCertificate)',
    ),
});

const sendGetCertificateStatusBody = z.object({
  ocspRequestData: z
    .record(z.unknown())
    .describe(
      'OCSP request data object: { hashAlgorithm, issuerNameHash, issuerKeyHash, serialNumber, responderURL }',
    ),
});

const sendGetTransactionStatusBody = z.object({
  transactionId: z.string().optional().describe('Transaction ID'),
});

const sendReportChargingProfilesBody = z.object({
  requestId: z.number().int().describe('Request ID'),
  chargingLimitSource: z.string().describe('Charging limit source (CSO, SO, OEM, EMS, Other)'),
  evseId: z.number().int().describe('EVSE ID'),
  chargingProfile: z.array(chargingProfileType).describe('Charging profile array'),
  tbc: z.boolean().optional().describe('To be continued (default: false)'),
});

const sendNotifyEVChargingScheduleBody = z.object({
  timeBase: z.string().describe('ISO 8601 timestamp for schedule time base'),
  evseId: z.number().int().describe('EVSE ID'),
  chargingSchedule: chargingScheduleType.describe(
    'Charging schedule object (e.g. { id, chargingRateUnit, chargingSchedulePeriod: [...] })',
  ),
});

const sendNotifySettlementBody = z
  .object({
    pspRef: z.string().describe('Payment service provider reference'),
    status: paymentStatusEnum.describe('Payment settlement status'),
    settlementAmount: z.number().describe('Settlement amount'),
    settlementTime: z.string().describe('ISO 8601 settlement timestamp'),
    transactionId: z.string().optional().describe('OCPP transaction ID'),
    statusInfo: z.string().optional().describe('Additional status information'),
    receiptId: z.string().optional().describe('Receipt identifier'),
    receiptUrl: z.string().optional().describe('Receipt URL'),
    vatNumber: z.string().optional().describe('VAT number for company receipt'),
    vatCompany: z
      .record(z.unknown())
      .optional()
      .describe('VAT company address: { name, address1, city, country, ... }'),
  })
  .passthrough();

const sendNotifyPriorityChargingBody = z.object({
  transactionId: z.string().describe('Transaction ID'),
  activated: z.boolean().describe('Whether priority charging is activated'),
});

const sendNotifyQRCodeScannedBody = z.object({
  evseId: z.number().int().describe('EVSE ID'),
  timeout: z.number().int().describe('Timeout in seconds'),
});

const sendNotifyAllowedEnergyTransferBody = z.object({
  transactionId: z.string().describe('Transaction ID'),
  allowedEnergyTransfer: z
    .array(energyTransferModeEnum)
    .describe(
      'Allowed energy transfer types (AC_single_phase, AC_two_phase, AC_three_phase, DC, etc.)',
    ),
});

const sendGet15118EVCertificateBody = z.object({
  iso15118SchemaVersion: z
    .string()
    .describe('ISO 15118 schema version (e.g. urn:iso:15118:2:2013:MsgDef)'),
  action: certificateActionEnum.describe('Certificate action (Install, Update)'),
  exiRequest: z.string().describe('Base64-encoded EXI request'),
});

const sendGetCertificateChainStatusBody = z.object({
  certificateStatusRequests: z
    .array(
      z
        .object({
          source: certificateStatusSourceEnum.describe('Certificate status source (OCSP, CRL)'),
          urls: z.array(z.string()).describe('URL(s) of the source'),
          certificateHashData: z
            .object({
              hashAlgorithm: hashAlgorithmEnum.describe('Hash algorithm (SHA256, SHA384, SHA512)'),
              issuerNameHash: z.string().describe('Issuer name hash'),
              issuerKeyHash: z.string().describe('Issuer key hash'),
              serialNumber: z.string().describe('Certificate serial number'),
            })
            .passthrough()
            .describe('Certificate hash data'),
        })
        .passthrough(),
    )
    .min(1)
    .max(4)
    .describe('Certificate status request array (1-4 items)'),
});

const sendPublishFirmwareStatusNotificationBody = z.object({
  status: publishFirmwareStatusEnum.describe(
    'Publish firmware status (Idle, DownloadScheduled, Downloading, Downloaded, Published, etc.)',
  ),
  requestId: z.number().int().optional().describe('Request ID (defaults to 0)'),
});

const sendNotifyWebPaymentStartedBody = z.object({
  evseId: z.number().int().describe('EVSE ID'),
  timeout: z.number().int().describe('Timeout in seconds'),
});

const sendNotifyPeriodicEventStreamBody = z
  .object({
    id: z.number().int().describe('Event stream ID'),
    pending: z.number().int().describe('Number of pending event stream messages'),
    basetime: z.string().describe('ISO 8601 base time for the event stream data'),
    data: z.array(streamDataElementType).describe('Event stream data entries'),
  })
  .passthrough();

const sendNotifyDERAlarmBody = z
  .object({
    controlType: derControlEnum.describe('DER control type (EnterService, FreqDroop, etc.)'),
    timestamp: z.string().describe('ISO 8601 timestamp'),
    alarmEnded: z.boolean().optional().describe('True when alarm has ended'),
    gridEventFault: gridEventFaultEnum.optional().describe('Grid event fault type'),
    extraInfo: z.string().optional().describe('Extra information'),
  })
  .passthrough();

const sendNotifyDERStartStopBody = z
  .object({
    controlId: z.string().describe('Control ID (string, max 36 chars)'),
    started: z.boolean().describe('True if DER control started, false if stopped'),
    timestamp: z.string().describe('ISO 8601 timestamp'),
    supersededIds: z.array(z.string()).optional().describe('IDs of superseded controls'),
  })
  .passthrough();

const sendReportDERControlBody = z
  .object({
    requestId: z.number().int().describe('Request ID'),
    tbc: z.boolean().optional().describe('To be continued (default: false)'),
  })
  .passthrough();

const sendBatterySwapBody = z.object({
  eventType: z
    .enum(['BatteryIn', 'BatteryOut', 'BatteryOutTimeout'])
    .describe('Battery swap event type'),
  requestId: z.number().int().describe('Request ID to correlate BatteryIn/Out events'),
  idToken: z
    .object({ idToken: z.string(), type: z.string() })
    .passthrough()
    .describe('ID token object'),
  batteryData: z
    .array(
      z
        .object({
          evseId: z.number().int().describe('Slot number'),
          serialNumber: z.string().describe('Battery serial number'),
          soC: z.number().describe('State of charge (0-100)'),
          soH: z.number().describe('State of health (0-100)'),
          productionDate: z.string().optional().describe('Production date'),
          vendorInfo: z.string().optional().describe('Vendor info'),
        })
        .passthrough(),
    )
    .describe('Battery data array'),
});

const sendPullDynamicScheduleUpdateBody = z.object({
  chargingProfileId: z.number().int().describe('Charging profile ID'),
});

const sendVatNumberValidationBody = z.object({
  vatNumber: z.string().describe('VAT number to validate'),
  evseId: z.number().int().optional().describe('EVSE ID'),
});

// --- OCPP 1.6 only actions ---

const sendStartTransactionBody = z.object({
  connectorId: z.number().int().describe('Connector ID'),
  idTag: z.string().describe('ID tag'),
  meterStart: z.number().int().describe('Starting meter value in Wh'),
  timestamp: z.string().describe('ISO 8601 timestamp'),
  reservationId: z.number().int().optional().describe('Reservation ID'),
});

const sendStopTransactionBody = z.object({
  transactionId: z.string().describe('Transaction ID (integer as string for 1.6)'),
  timestamp: z.string().describe('ISO 8601 timestamp'),
  meterStop: z.number().int().describe('Final meter value in Wh'),
  idTag: z.string().optional().describe('ID tag'),
  reason: z
    .enum([
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
    ])
    .optional()
    .describe(
      'Stop reason (EmergencyStop, EVDisconnected, HardReset, Local, Other, PowerLoss, Reboot, Remote, SoftReset, UnlockCommand, DeAuthorized)',
    ),
  transactionData: z.array(meterValueType16).optional().describe('Transaction meter data'),
});

const sendDiagnosticsStatusNotificationBody = z.object({
  status: z
    .enum(['Idle', 'Uploaded', 'UploadFailed', 'Uploading'])
    .describe('Diagnostics status (Idle, Uploaded, UploadFailed, Uploading)'),
});

// ---------------------------------------------------------------------------
// Action route helper
// ---------------------------------------------------------------------------

function actionRoute(
  app: FastifyInstance,
  actionName: string,
  version: 'all' | 'ocpp1.6' | 'ocpp2.1',
  summary: string,
  bodySchema: z.ZodObject<z.ZodRawShape>,
): void {
  const versionPrefix = version === 'ocpp1.6' ? 'v16/' : version === 'ocpp2.1' ? 'v21/' : '';
  const tag =
    version === 'all'
      ? 'CSS Actions'
      : version === 'ocpp1.6'
        ? 'CSS OCPP 1.6 Actions'
        : 'CSS OCPP 2.1 Actions';

  const mergedBody = bodySchema.extend({
    stationId: z.string().min(1).describe('Station identifier string'),
  });

  app.post(
    `/css/actions/${versionPrefix}${actionName}`,
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: [tag],
        summary,
        operationId: `css_${versionPrefix.replace('/', '_')}${actionName}`,
        security: [{ bearerAuth: [] }],
        body: zodSchema(mergedBody),
        response: {
          200: itemResponse(actionResponse),
          400: errorResponse,
          404: errorResponse,
          504: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { stationId, ...params } = request.body as { stationId: string } & Record<
        string,
        unknown
      >;

      const [station] = await db
        .select({
          id: cssStations.id,
          stationId: cssStations.stationId,
          ocppProtocol: chargingStations.ocppProtocol,
          chargingStationId: chargingStations.id,
        })
        .from(cssStations)
        .innerJoin(chargingStations, eq(chargingStations.stationId, cssStations.stationId))
        .where(eq(cssStations.stationId, stationId))
        .limit(1);

      if (station == null) {
        return reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      }

      if (version !== 'all' && version !== station.ocppProtocol) {
        return reply.status(400).send({
          error: `Action ${actionName} requires ${version}, station ${station.stationId} is ${station.ocppProtocol ?? 'unknown'}`,
          code: 'OCPP_VERSION_MISMATCH',
        });
      }

      // Pre-check connector status for startCharging so the dashboard Simulate
      // tab returns a fast, explicit 400 when the cable isn't plugged in. The
      // simulator no longer hard-rejects this case; without the API guard the
      // simulator would emit a Charging StatusNotification with no cable
      // connected, which is non-conforming on the wire.
      //
      // This path (POST /v1/css/actions/startCharging) drives sim.startCharging
      // directly, which calls beginTransaction immediately and has no
      // accept-and-wait flow. Only states that mean "cable physically
      // connected" are valid here. The portal flow goes through OCPP
      // RequestStartTransaction instead, which DOES accept-and-wait via
      // EVConnectionTimeOut and so legitimately allows status=available.
      // Mirror StationSimulate.tsx getValidActions() so the dashboard UI
      // gating and the API enforcement agree.
      if (actionName === 'startCharging') {
        const evseId = (params as { evseId?: number }).evseId;
        if (typeof evseId === 'number') {
          const [evse] = await db
            .select({ id: evses.id })
            .from(evses)
            .where(and(eq(evses.stationId, station.chargingStationId), eq(evses.evseId, evseId)))
            .limit(1);
          if (evse == null) {
            return reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
          }
          const [connector] = await db
            .select({ status: connectors.status })
            .from(connectors)
            .where(eq(connectors.evseId, evse.id))
            .limit(1);
          const startableStatuses = ['preparing', 'occupied', 'ev_connected', 'finishing'];
          if (connector != null && !startableStatuses.includes(connector.status)) {
            return reply.status(400).send({
              error: 'Connector is not available for charging',
              code: 'CONNECTOR_NOT_AVAILABLE',
            });
          }
        }
      }

      const commandId = randomUUID();
      const pubsub = getPubSub();

      // Subscribe BEFORE publishing so we don't miss a fast result. The
      // SimulatorManager publishes {commandId, success, error?} on
      // css_command_results once dispatchAction completes (success or throw).
      const result = await waitForCssCommandResult(commandId, async () => {
        await pubsub.publish(
          'css_commands',
          JSON.stringify({
            commandId,
            stationId: station.stationId,
            action: actionName,
            params,
          }),
        );
      });

      if (result.timedOut) {
        return reply.status(504).send({
          error: 'Simulator did not respond within 5s',
          code: 'CSS_ACTION_TIMEOUT',
        });
      }
      if (!result.success) {
        return reply.status(400).send({
          error: result.error ?? 'Simulator rejected the action',
          code: 'CSS_ACTION_REJECTED',
        });
      }
      return reply.status(200).send({
        commandId,
        ...(result.data != null ? { data: result.data } : {}),
      });
    },
  );
}

interface CssCommandResultMessage {
  commandId: string;
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

interface CssCommandResult {
  timedOut: boolean;
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

const CSS_RESULT_TIMEOUT_MS = 5_000;
const CSS_RESULTS_CHANNEL = 'css_command_results';

async function waitForCssCommandResult(
  commandId: string,
  publish: () => Promise<void>,
): Promise<CssCommandResult> {
  const pubsub = getPubSub();

  // Set up the awaited promise with explicit resolver, then subscribe and
  // publish synchronously in this scope so the .then microtask chain stays
  // simple and testable.
  let resolveResult!: (r: CssCommandResult) => void;
  const resultPromise = new Promise<CssCommandResult>((resolve) => {
    resolveResult = resolve;
  });

  const timeout = setTimeout(() => {
    resolveResult({ timedOut: true, success: false });
  }, CSS_RESULT_TIMEOUT_MS);

  let subscription: import('@evtivity/lib').Subscription | null = null;
  try {
    subscription = await pubsub.subscribe(CSS_RESULTS_CHANNEL, (raw: string) => {
      let parsed: CssCommandResultMessage;
      try {
        parsed = JSON.parse(raw) as CssCommandResultMessage;
      } catch {
        return;
      }
      if (parsed.commandId !== commandId) return;
      clearTimeout(timeout);
      resolveResult({
        timedOut: false,
        success: parsed.success,
        ...(parsed.error != null ? { error: parsed.error } : {}),
        ...(parsed.data != null ? { data: parsed.data } : {}),
      });
    });

    await publish();
    const result = await resultPromise;
    return result;
  } catch (err: unknown) {
    clearTimeout(timeout);
    const message = err instanceof Error ? err.message : String(err);
    return { timedOut: false, success: false, error: message };
  } finally {
    if (subscription != null) {
      void subscription.unsubscribe().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function cssRoutes(app: FastifyInstance): void {
  // (GET /css/actions removed -- Simulate tab knows which actions to show)

  // POST /css/stations - Create station
  app.post(
    '/css/stations',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['CSS Management'],
        summary: 'Create a CSS station',
        operationId: 'createCssStation',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createStationBody),
        response: {
          201: itemResponse(stationItem),
          409: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createStationBody>;

      // Check for duplicate stationId (read-only, safe outside the transaction).
      const [existing] = await db
        .select({ id: cssStations.id })
        .from(cssStations)
        .where(eq(cssStations.stationId, body.stationId))
        .limit(1);

      if (existing != null) {
        return reply.status(409).send({
          error: 'Station ID already exists',
          code: 'DUPLICATE_STATION_ID',
        });
      }

      // Wrap all writes (chargingStations, cssStations, cssEvses, cssConfigVariables) in a
      // transaction so a partial failure cannot leave a chargingStations row with isSimulator=true
      // and an incomplete cssStations setup.
      const result = await db.transaction(async (tx) => {
        // Ensure a charging_stations row exists, marked as simulator.
        const [existingCs] = await tx
          .select({ id: chargingStations.id, isSimulator: chargingStations.isSimulator })
          .from(chargingStations)
          .where(eq(chargingStations.stationId, body.stationId))
          .limit(1);

        if (existingCs == null) {
          await tx.insert(chargingStations).values({
            stationId: body.stationId,
            model: body.model ?? 'CSS-1000',
            serialNumber: body.serialNumber ?? `SN-${body.stationId}`,
            firmwareVersion: body.firmwareVersion ?? '1.0.0',
            securityProfile: body.securityProfile ?? 1,
            ocppProtocol: body.ocppProtocol ?? 'ocpp1.6',
            isSimulator: true,
            onboardingStatus: 'accepted',
          });
        } else if (!existingCs.isSimulator) {
          await tx
            .update(chargingStations)
            .set({ isSimulator: true, updatedAt: new Date() })
            .where(eq(chargingStations.id, existingCs.id));
        }

        // Insert station
        const [station] = await tx
          .insert(cssStations)
          .values({
            stationId: body.stationId,
            targetUrl: body.targetUrl,
            password: body.password ?? null,
            clientCert: body.clientCert ?? null,
            clientKey: body.clientKey ?? null,
            caCert: body.caCert ?? null,
            sourceType: body.sourceType ?? 'api',
          })
          .returning();

        if (station == null) {
          throw new Error('Failed to create station');
        }

        // Insert EVSEs
        for (const evse of body.evses) {
          await tx.insert(cssEvses).values({
            cssStationId: station.id,
            evseId: evse.evseId,
            connectorId: evse.connectorId ?? 1,
            connectorType: evse.connectorType ?? 'ac_type2',
            maxPowerW: evse.maxPowerW ?? 22000,
            phases: evse.phases ?? 3,
            voltage: evse.voltage ?? 230,
          });
        }

        // Seed default config variables
        const protocol = body.ocppProtocol ?? 'ocpp1.6';
        const defaults = protocol === 'ocpp1.6' ? OCPP16_CONFIG_DEFAULTS : OCPP21_CONFIG_DEFAULTS;

        for (const [key, value] of Object.entries(defaults)) {
          await tx.insert(cssConfigVariables).values({
            cssStationId: station.id,
            key,
            value,
          });
        }

        // Re-fetch station with EVSEs inside the same transaction so the response reflects
        // the just-inserted rows.
        const evses = await tx.select().from(cssEvses).where(eq(cssEvses.cssStationId, station.id));

        return { station, evses };
      });

      return reply.status(201).send({ ...result.station, evses: result.evses });
    },
  );

  // GET /css/stations - List stations
  app.get(
    '/css/stations',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['CSS Management'],
        summary: 'List CSS stations',
        operationId: 'listCssStations',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(paginationQuery),
        response: {
          200: paginatedResponse(stationItem),
        },
      },
    },
    async (request) => {
      const query = request.query as z.infer<typeof paginationQuery>;
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [data, totalResult] = await Promise.all([
        db.select().from(cssStations).orderBy(cssStations.createdAt).limit(limit).offset(offset),
        db.select({ count: count() }).from(cssStations),
      ]);

      return { data, total: totalResult[0]?.count ?? 0 };
    },
  );

  // GET /css/stations/:stationId - Get single station
  app.get(
    '/css/stations/:stationId',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['CSS Management'],
        summary: 'Get a CSS station by station ID',
        operationId: 'getCssStation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        response: {
          200: itemResponse(stationItem),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { stationId } = request.params as z.infer<typeof stationIdParams>;

      const [station] = await db
        .select()
        .from(cssStations)
        .where(eq(cssStations.stationId, stationId));

      if (station == null) {
        return reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      }

      const [evses, [txCount]] = await Promise.all([
        db.select().from(cssEvses).where(eq(cssEvses.cssStationId, station.id)),
        db
          .select({ count: count() })
          .from(cssTransactions)
          .where(
            sql`${cssTransactions.cssStationId} = ${station.id} AND ${cssTransactions.status} = 'active'`,
          ),
      ]);

      return { ...station, evses, activeTransactionCount: txCount?.count ?? 0 };
    },
  );

  // PATCH /css/stations/:stationId - Update station
  app.patch(
    '/css/stations/:stationId',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['CSS Management'],
        summary: 'Update a CSS station',
        operationId: 'updateCssStation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        body: zodSchema(updateStationBody),
        response: {
          200: itemResponse(stationItem),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { stationId } = request.params as z.infer<typeof stationIdParams>;
      const body = request.body as z.infer<typeof updateStationBody>;

      const [existing] = await db
        .select({ id: cssStations.id })
        .from(cssStations)
        .where(eq(cssStations.stationId, stationId));

      if (existing == null) {
        return reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      }

      // Route deduplicated fields to charging_stations where they now live.
      const csUpdates: Record<string, unknown> = {};
      if (body.ocppProtocol !== undefined) csUpdates['ocppProtocol'] = body.ocppProtocol;
      if (body.securityProfile !== undefined) csUpdates['securityProfile'] = body.securityProfile;
      if (body.model !== undefined) csUpdates['model'] = body.model;
      if (body.serialNumber !== undefined) csUpdates['serialNumber'] = body.serialNumber;
      if (body.firmwareVersion !== undefined) csUpdates['firmwareVersion'] = body.firmwareVersion;

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.targetUrl !== undefined) updates['targetUrl'] = body.targetUrl;
      if (body.password !== undefined) updates['password'] = body.password;
      if (body.clientCert !== undefined) updates['clientCert'] = body.clientCert;
      if (body.clientKey !== undefined) updates['clientKey'] = body.clientKey;
      if (body.caCert !== undefined) updates['caCert'] = body.caCert;
      if (body.enabled !== undefined) updates['enabled'] = body.enabled;

      // When both tables get a write, run them atomically so a chargingStations success
      // followed by a cssStations failure cannot leave the two rows inconsistent.
      const updated = await db.transaction(async (tx) => {
        if (Object.keys(csUpdates).length > 0) {
          csUpdates['updatedAt'] = new Date();
          await tx
            .update(chargingStations)
            .set(csUpdates)
            .where(eq(chargingStations.stationId, stationId));
        }

        const [row] = await tx
          .update(cssStations)
          .set(updates)
          .where(eq(cssStations.id, existing.id))
          .returning();

        return row;
      });

      return updated;
    },
  );

  // DELETE /css/stations/:stationId - Delete station
  app.delete(
    '/css/stations/:stationId',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['CSS Management'],
        summary: 'Delete a CSS station',
        operationId: 'deleteCssStation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        response: {
          204: { type: 'null' as const },
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { stationId } = request.params as z.infer<typeof stationIdParams>;

      const [existing] = await db
        .select({ id: cssStations.id })
        .from(cssStations)
        .where(eq(cssStations.stationId, stationId));

      if (existing == null) {
        return reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      }

      await db.delete(cssStations).where(eq(cssStations.id, existing.id));

      return reply.status(204).send();
    },
  );

  // POST /css/stations/:stationId/enable - Enable station
  app.post(
    '/css/stations/:stationId/enable',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['CSS Management'],
        summary: 'Enable a CSS station',
        operationId: 'enableCssStation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        response: {
          200: itemResponse(stationItem),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { stationId } = request.params as z.infer<typeof stationIdParams>;

      const [existing] = await db
        .select({ id: cssStations.id })
        .from(cssStations)
        .where(eq(cssStations.stationId, stationId));

      if (existing == null) {
        return reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      }

      const [updated] = await db
        .update(cssStations)
        .set({ enabled: true, updatedAt: new Date() })
        .where(eq(cssStations.id, existing.id))
        .returning();

      return updated;
    },
  );

  // POST /css/stations/:stationId/disable - Disable station
  app.post(
    '/css/stations/:stationId/disable',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['CSS Management'],
        summary: 'Disable a CSS station',
        operationId: 'disableCssStation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        response: {
          200: itemResponse(stationItem),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { stationId } = request.params as z.infer<typeof stationIdParams>;

      const [existing] = await db
        .select({ id: cssStations.id })
        .from(cssStations)
        .where(eq(cssStations.stationId, stationId));

      if (existing == null) {
        return reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      }

      const [updated] = await db
        .update(cssStations)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(cssStations.id, existing.id))
        .returning();

      return updated;
    },
  );

  // -------------------------------------------------------------------------
  // Action routes (49 individual endpoints)
  // -------------------------------------------------------------------------

  // --- High-level actions (all versions) ---
  actionRoute(app, 'plugIn', 'all', 'Plug in charging cable', plugInBody);
  actionRoute(app, 'authorize', 'all', 'Authorize with token', authorizeBody);
  actionRoute(app, 'startCharging', 'all', 'Start a charging session', startChargingBody);
  actionRoute(app, 'stopCharging', 'all', 'Stop a charging session', stopChargingBody);
  actionRoute(app, 'unplug', 'all', 'Unplug charging cable', unplugBody);
  actionRoute(app, 'injectFault', 'all', 'Inject a fault on an EVSE', injectFaultBody);
  actionRoute(app, 'clearFault', 'all', 'Clear a fault on an EVSE', clearFaultBody);
  actionRoute(app, 'goOffline', 'all', 'Disconnect station from OCPP server', goOfflineBody);
  actionRoute(app, 'comeOnline', 'all', 'Reconnect station to OCPP server', comeOnlineBody);

  // --- Station-initiated messages (version-specific endpoints) ---
  for (const ver of ['ocpp1.6', 'ocpp2.1'] as const) {
    actionRoute(
      app,
      'sendBootNotification',
      ver,
      'Send BootNotification',
      sendBootNotificationBody,
    );
    actionRoute(app, 'sendHeartbeat', ver, 'Send Heartbeat', sendHeartbeatBody);
    actionRoute(
      app,
      'sendStatusNotification',
      ver,
      'Send StatusNotification',
      sendStatusNotificationBody,
    );
    actionRoute(app, 'sendMeterValues', ver, 'Send MeterValues', sendMeterValuesBody);
    actionRoute(app, 'sendAuthorize', ver, 'Send Authorize request', sendAuthorizeBody);
    actionRoute(
      app,
      'sendFirmwareStatusNotification',
      ver,
      'Send FirmwareStatusNotification',
      sendFirmwareStatusNotificationBody,
    );
    actionRoute(app, 'sendDataTransfer', ver, 'Send DataTransfer', sendDataTransferBody);
  }

  // --- OCPP 2.1 only actions ---
  actionRoute(
    app,
    'sendTransactionEvent',
    'ocpp2.1',
    'Send TransactionEvent',
    sendTransactionEventBody,
  );
  actionRoute(
    app,
    'sendLogStatusNotification',
    'ocpp2.1',
    'Send LogStatusNotification',
    sendLogStatusNotificationBody,
  );
  actionRoute(
    app,
    'sendSecurityEventNotification',
    'ocpp2.1',
    'Send SecurityEventNotification',
    sendSecurityEventNotificationBody,
  );
  actionRoute(app, 'sendNotifyEvent', 'ocpp2.1', 'Send NotifyEvent', sendNotifyEventBody);
  actionRoute(app, 'sendNotifyReport', 'ocpp2.1', 'Send NotifyReport', sendNotifyReportBody);
  actionRoute(
    app,
    'sendNotifyMonitoringReport',
    'ocpp2.1',
    'Send NotifyMonitoringReport',
    sendNotifyMonitoringReportBody,
  );
  actionRoute(
    app,
    'sendNotifyChargingLimit',
    'ocpp2.1',
    'Send NotifyChargingLimit',
    sendNotifyChargingLimitBody,
  );
  actionRoute(
    app,
    'sendNotifyEVChargingNeeds',
    'ocpp2.1',
    'Send NotifyEVChargingNeeds',
    sendNotifyEVChargingNeedsBody,
  );
  actionRoute(
    app,
    'sendClearedChargingLimit',
    'ocpp2.1',
    'Send ClearedChargingLimit',
    sendClearedChargingLimitBody,
  );
  actionRoute(
    app,
    'sendReservationStatusUpdate',
    'ocpp2.1',
    'Send ReservationStatusUpdate',
    sendReservationStatusUpdateBody,
  );
  actionRoute(
    app,
    'sendNotifyDisplayMessages',
    'ocpp2.1',
    'Send NotifyDisplayMessages',
    sendNotifyDisplayMessagesBody,
  );
  actionRoute(
    app,
    'sendNotifyCustomerInformation',
    'ocpp2.1',
    'Send NotifyCustomerInformation',
    sendNotifyCustomerInformationBody,
  );
  actionRoute(
    app,
    'sendSignCertificate',
    'ocpp2.1',
    'Send SignCertificate',
    sendSignCertificateBody,
  );
  actionRoute(
    app,
    'sendGetCertificateStatus',
    'ocpp2.1',
    'Send GetCertificateStatus',
    sendGetCertificateStatusBody,
  );
  actionRoute(
    app,
    'sendGetTransactionStatus',
    'ocpp2.1',
    'Send GetTransactionStatus',
    sendGetTransactionStatusBody,
  );
  actionRoute(
    app,
    'sendReportChargingProfiles',
    'ocpp2.1',
    'Send ReportChargingProfiles',
    sendReportChargingProfilesBody,
  );
  actionRoute(
    app,
    'sendNotifyEVChargingSchedule',
    'ocpp2.1',
    'Send NotifyEVChargingSchedule',
    sendNotifyEVChargingScheduleBody,
  );
  actionRoute(
    app,
    'sendNotifySettlement',
    'ocpp2.1',
    'Send NotifySettlement',
    sendNotifySettlementBody,
  );
  actionRoute(
    app,
    'sendNotifyPriorityCharging',
    'ocpp2.1',
    'Send NotifyPriorityCharging',
    sendNotifyPriorityChargingBody,
  );
  actionRoute(
    app,
    'sendNotifyQRCodeScanned',
    'ocpp2.1',
    'Send NotifyQRCodeScanned',
    sendNotifyQRCodeScannedBody,
  );
  actionRoute(
    app,
    'sendNotifyAllowedEnergyTransfer',
    'ocpp2.1',
    'Send NotifyAllowedEnergyTransfer',
    sendNotifyAllowedEnergyTransferBody,
  );
  actionRoute(
    app,
    'sendGet15118EVCertificate',
    'ocpp2.1',
    'Send Get15118EVCertificate',
    sendGet15118EVCertificateBody,
  );
  actionRoute(
    app,
    'sendGetCertificateChainStatus',
    'ocpp2.1',
    'Send GetCertificateChainStatus',
    sendGetCertificateChainStatusBody,
  );
  actionRoute(
    app,
    'sendPublishFirmwareStatusNotification',
    'ocpp2.1',
    'Send PublishFirmwareStatusNotification',
    sendPublishFirmwareStatusNotificationBody,
  );
  actionRoute(
    app,
    'sendNotifyWebPaymentStarted',
    'ocpp2.1',
    'Send NotifyWebPaymentStarted',
    sendNotifyWebPaymentStartedBody,
  );
  actionRoute(
    app,
    'sendNotifyPeriodicEventStream',
    'ocpp2.1',
    'Send NotifyPeriodicEventStream',
    sendNotifyPeriodicEventStreamBody,
  );
  actionRoute(app, 'sendNotifyDERAlarm', 'ocpp2.1', 'Send NotifyDERAlarm', sendNotifyDERAlarmBody);
  actionRoute(
    app,
    'sendNotifyDERStartStop',
    'ocpp2.1',
    'Send NotifyDERStartStop',
    sendNotifyDERStartStopBody,
  );
  actionRoute(
    app,
    'sendReportDERControl',
    'ocpp2.1',
    'Send ReportDERControl',
    sendReportDERControlBody,
  );
  actionRoute(app, 'sendBatterySwap', 'ocpp2.1', 'Send BatterySwap', sendBatterySwapBody);
  actionRoute(
    app,
    'sendPullDynamicScheduleUpdate',
    'ocpp2.1',
    'Send PullDynamicScheduleUpdate',
    sendPullDynamicScheduleUpdateBody,
  );
  actionRoute(
    app,
    'sendVatNumberValidation',
    'ocpp2.1',
    'Send VatNumberValidation',
    sendVatNumberValidationBody,
  );

  // --- OCPP 1.6 only actions ---
  actionRoute(
    app,
    'sendStartTransaction',
    'ocpp1.6',
    'Send StartTransaction',
    sendStartTransactionBody,
  );
  actionRoute(
    app,
    'sendStopTransaction',
    'ocpp1.6',
    'Send StopTransaction',
    sendStopTransactionBody,
  );
  actionRoute(
    app,
    'sendDiagnosticsStatusNotification',
    'ocpp1.6',
    'Send DiagnosticsStatusNotification',
    sendDiagnosticsStatusNotificationBody,
  );
}
