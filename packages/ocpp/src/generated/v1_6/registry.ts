import { validateAuthorize } from './validators/Authorize.validator.js';
import { validateAuthorizeResponse } from './validators/AuthorizeResponse.validator.js';
import { validateBootNotification } from './validators/BootNotification.validator.js';
import { validateBootNotificationResponse } from './validators/BootNotificationResponse.validator.js';
import { validateCancelReservation } from './validators/CancelReservation.validator.js';
import { validateCancelReservationResponse } from './validators/CancelReservationResponse.validator.js';
import { validateCertificateSigned } from './validators/CertificateSigned.validator.js';
import { validateCertificateSignedResponse } from './validators/CertificateSignedResponse.validator.js';
import { validateChangeAvailability } from './validators/ChangeAvailability.validator.js';
import { validateChangeAvailabilityResponse } from './validators/ChangeAvailabilityResponse.validator.js';
import { validateChangeConfiguration } from './validators/ChangeConfiguration.validator.js';
import { validateChangeConfigurationResponse } from './validators/ChangeConfigurationResponse.validator.js';
import { validateClearCache } from './validators/ClearCache.validator.js';
import { validateClearCacheResponse } from './validators/ClearCacheResponse.validator.js';
import { validateClearChargingProfile } from './validators/ClearChargingProfile.validator.js';
import { validateClearChargingProfileResponse } from './validators/ClearChargingProfileResponse.validator.js';
import { validateDataTransfer } from './validators/DataTransfer.validator.js';
import { validateDataTransferResponse } from './validators/DataTransferResponse.validator.js';
import { validateDeleteCertificate } from './validators/DeleteCertificate.validator.js';
import { validateDeleteCertificateResponse } from './validators/DeleteCertificateResponse.validator.js';
import { validateDiagnosticsStatusNotification } from './validators/DiagnosticsStatusNotification.validator.js';
import { validateDiagnosticsStatusNotificationResponse } from './validators/DiagnosticsStatusNotificationResponse.validator.js';
import { validateExtendedTriggerMessage } from './validators/ExtendedTriggerMessage.validator.js';
import { validateExtendedTriggerMessageResponse } from './validators/ExtendedTriggerMessageResponse.validator.js';
import { validateFirmwareStatusNotification } from './validators/FirmwareStatusNotification.validator.js';
import { validateFirmwareStatusNotificationResponse } from './validators/FirmwareStatusNotificationResponse.validator.js';
import { validateGetCompositeSchedule } from './validators/GetCompositeSchedule.validator.js';
import { validateGetCompositeScheduleResponse } from './validators/GetCompositeScheduleResponse.validator.js';
import { validateGetConfiguration } from './validators/GetConfiguration.validator.js';
import { validateGetConfigurationResponse } from './validators/GetConfigurationResponse.validator.js';
import { validateGetDiagnostics } from './validators/GetDiagnostics.validator.js';
import { validateGetDiagnosticsResponse } from './validators/GetDiagnosticsResponse.validator.js';
import { validateGetInstalledCertificateIds } from './validators/GetInstalledCertificateIds.validator.js';
import { validateGetInstalledCertificateIdsResponse } from './validators/GetInstalledCertificateIdsResponse.validator.js';
import { validateGetLocalListVersion } from './validators/GetLocalListVersion.validator.js';
import { validateGetLocalListVersionResponse } from './validators/GetLocalListVersionResponse.validator.js';
import { validateGetLog } from './validators/GetLog.validator.js';
import { validateGetLogResponse } from './validators/GetLogResponse.validator.js';
import { validateHeartbeat } from './validators/Heartbeat.validator.js';
import { validateHeartbeatResponse } from './validators/HeartbeatResponse.validator.js';
import { validateInstallCertificate } from './validators/InstallCertificate.validator.js';
import { validateInstallCertificateResponse } from './validators/InstallCertificateResponse.validator.js';
import { validateLogStatusNotification } from './validators/LogStatusNotification.validator.js';
import { validateLogStatusNotificationResponse } from './validators/LogStatusNotificationResponse.validator.js';
import { validateMeterValues } from './validators/MeterValues.validator.js';
import { validateMeterValuesResponse } from './validators/MeterValuesResponse.validator.js';
import { validateRemoteStartTransaction } from './validators/RemoteStartTransaction.validator.js';
import { validateRemoteStartTransactionResponse } from './validators/RemoteStartTransactionResponse.validator.js';
import { validateRemoteStopTransaction } from './validators/RemoteStopTransaction.validator.js';
import { validateRemoteStopTransactionResponse } from './validators/RemoteStopTransactionResponse.validator.js';
import { validateReserveNow } from './validators/ReserveNow.validator.js';
import { validateReserveNowResponse } from './validators/ReserveNowResponse.validator.js';
import { validateReset } from './validators/Reset.validator.js';
import { validateResetResponse } from './validators/ResetResponse.validator.js';
import { validateSecurityEventNotification } from './validators/SecurityEventNotification.validator.js';
import { validateSecurityEventNotificationResponse } from './validators/SecurityEventNotificationResponse.validator.js';
import { validateSendLocalList } from './validators/SendLocalList.validator.js';
import { validateSendLocalListResponse } from './validators/SendLocalListResponse.validator.js';
import { validateSetChargingProfile } from './validators/SetChargingProfile.validator.js';
import { validateSetChargingProfileResponse } from './validators/SetChargingProfileResponse.validator.js';
import { validateSignCertificate } from './validators/SignCertificate.validator.js';
import { validateSignCertificateResponse } from './validators/SignCertificateResponse.validator.js';
import { validateSignedFirmwareStatusNotification } from './validators/SignedFirmwareStatusNotification.validator.js';
import { validateSignedFirmwareStatusNotificationResponse } from './validators/SignedFirmwareStatusNotificationResponse.validator.js';
import { validateSignedUpdateFirmware } from './validators/SignedUpdateFirmware.validator.js';
import { validateSignedUpdateFirmwareResponse } from './validators/SignedUpdateFirmwareResponse.validator.js';
import { validateStartTransaction } from './validators/StartTransaction.validator.js';
import { validateStartTransactionResponse } from './validators/StartTransactionResponse.validator.js';
import { validateStatusNotification } from './validators/StatusNotification.validator.js';
import { validateStatusNotificationResponse } from './validators/StatusNotificationResponse.validator.js';
import { validateStopTransaction } from './validators/StopTransaction.validator.js';
import { validateStopTransactionResponse } from './validators/StopTransactionResponse.validator.js';
import { validateTriggerMessage } from './validators/TriggerMessage.validator.js';
import { validateTriggerMessageResponse } from './validators/TriggerMessageResponse.validator.js';
import { validateUnlockConnector } from './validators/UnlockConnector.validator.js';
import { validateUnlockConnectorResponse } from './validators/UnlockConnectorResponse.validator.js';
import { validateUpdateFirmware } from './validators/UpdateFirmware.validator.js';
import { validateUpdateFirmwareResponse } from './validators/UpdateFirmwareResponse.validator.js';

export const ActionRegistry = {
  Authorize: {
    validateRequest: validateAuthorize,
    validateResponse: validateAuthorizeResponse,
  },
  BootNotification: {
    validateRequest: validateBootNotification,
    validateResponse: validateBootNotificationResponse,
  },
  CancelReservation: {
    validateRequest: validateCancelReservation,
    validateResponse: validateCancelReservationResponse,
  },
  CertificateSigned: {
    validateRequest: validateCertificateSigned,
    validateResponse: validateCertificateSignedResponse,
  },
  ChangeAvailability: {
    validateRequest: validateChangeAvailability,
    validateResponse: validateChangeAvailabilityResponse,
  },
  ChangeConfiguration: {
    validateRequest: validateChangeConfiguration,
    validateResponse: validateChangeConfigurationResponse,
  },
  ClearCache: {
    validateRequest: validateClearCache,
    validateResponse: validateClearCacheResponse,
  },
  ClearChargingProfile: {
    validateRequest: validateClearChargingProfile,
    validateResponse: validateClearChargingProfileResponse,
  },
  DataTransfer: {
    validateRequest: validateDataTransfer,
    validateResponse: validateDataTransferResponse,
  },
  DeleteCertificate: {
    validateRequest: validateDeleteCertificate,
    validateResponse: validateDeleteCertificateResponse,
  },
  DiagnosticsStatusNotification: {
    validateRequest: validateDiagnosticsStatusNotification,
    validateResponse: validateDiagnosticsStatusNotificationResponse,
  },
  ExtendedTriggerMessage: {
    validateRequest: validateExtendedTriggerMessage,
    validateResponse: validateExtendedTriggerMessageResponse,
  },
  FirmwareStatusNotification: {
    validateRequest: validateFirmwareStatusNotification,
    validateResponse: validateFirmwareStatusNotificationResponse,
  },
  GetCompositeSchedule: {
    validateRequest: validateGetCompositeSchedule,
    validateResponse: validateGetCompositeScheduleResponse,
  },
  GetConfiguration: {
    validateRequest: validateGetConfiguration,
    validateResponse: validateGetConfigurationResponse,
  },
  GetDiagnostics: {
    validateRequest: validateGetDiagnostics,
    validateResponse: validateGetDiagnosticsResponse,
  },
  GetInstalledCertificateIds: {
    validateRequest: validateGetInstalledCertificateIds,
    validateResponse: validateGetInstalledCertificateIdsResponse,
  },
  GetLocalListVersion: {
    validateRequest: validateGetLocalListVersion,
    validateResponse: validateGetLocalListVersionResponse,
  },
  GetLog: {
    validateRequest: validateGetLog,
    validateResponse: validateGetLogResponse,
  },
  Heartbeat: {
    validateRequest: validateHeartbeat,
    validateResponse: validateHeartbeatResponse,
  },
  InstallCertificate: {
    validateRequest: validateInstallCertificate,
    validateResponse: validateInstallCertificateResponse,
  },
  LogStatusNotification: {
    validateRequest: validateLogStatusNotification,
    validateResponse: validateLogStatusNotificationResponse,
  },
  MeterValues: {
    validateRequest: validateMeterValues,
    validateResponse: validateMeterValuesResponse,
  },
  RemoteStartTransaction: {
    validateRequest: validateRemoteStartTransaction,
    validateResponse: validateRemoteStartTransactionResponse,
  },
  RemoteStopTransaction: {
    validateRequest: validateRemoteStopTransaction,
    validateResponse: validateRemoteStopTransactionResponse,
  },
  ReserveNow: {
    validateRequest: validateReserveNow,
    validateResponse: validateReserveNowResponse,
  },
  Reset: {
    validateRequest: validateReset,
    validateResponse: validateResetResponse,
  },
  SecurityEventNotification: {
    validateRequest: validateSecurityEventNotification,
    validateResponse: validateSecurityEventNotificationResponse,
  },
  SendLocalList: {
    validateRequest: validateSendLocalList,
    validateResponse: validateSendLocalListResponse,
  },
  SetChargingProfile: {
    validateRequest: validateSetChargingProfile,
    validateResponse: validateSetChargingProfileResponse,
  },
  SignCertificate: {
    validateRequest: validateSignCertificate,
    validateResponse: validateSignCertificateResponse,
  },
  SignedFirmwareStatusNotification: {
    validateRequest: validateSignedFirmwareStatusNotification,
    validateResponse: validateSignedFirmwareStatusNotificationResponse,
  },
  SignedUpdateFirmware: {
    validateRequest: validateSignedUpdateFirmware,
    validateResponse: validateSignedUpdateFirmwareResponse,
  },
  StartTransaction: {
    validateRequest: validateStartTransaction,
    validateResponse: validateStartTransactionResponse,
  },
  StatusNotification: {
    validateRequest: validateStatusNotification,
    validateResponse: validateStatusNotificationResponse,
  },
  StopTransaction: {
    validateRequest: validateStopTransaction,
    validateResponse: validateStopTransactionResponse,
  },
  TriggerMessage: {
    validateRequest: validateTriggerMessage,
    validateResponse: validateTriggerMessageResponse,
  },
  UnlockConnector: {
    validateRequest: validateUnlockConnector,
    validateResponse: validateUnlockConnectorResponse,
  },
  UpdateFirmware: {
    validateRequest: validateUpdateFirmware,
    validateResponse: validateUpdateFirmwareResponse,
  },
} as const;

export type ActionName = keyof typeof ActionRegistry;
