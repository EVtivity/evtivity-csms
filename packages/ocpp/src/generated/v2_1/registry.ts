import { validateAdjustPeriodicEventStreamRequest } from './validators/AdjustPeriodicEventStreamRequest.validator.js';
import { validateAdjustPeriodicEventStreamResponse } from './validators/AdjustPeriodicEventStreamResponse.validator.js';
import { validateAFRRSignalRequest } from './validators/AFRRSignalRequest.validator.js';
import { validateAFRRSignalResponse } from './validators/AFRRSignalResponse.validator.js';
import { validateAuthorizeRequest } from './validators/AuthorizeRequest.validator.js';
import { validateAuthorizeResponse } from './validators/AuthorizeResponse.validator.js';
import { validateBatterySwapRequest } from './validators/BatterySwapRequest.validator.js';
import { validateBatterySwapResponse } from './validators/BatterySwapResponse.validator.js';
import { validateBootNotificationRequest } from './validators/BootNotificationRequest.validator.js';
import { validateBootNotificationResponse } from './validators/BootNotificationResponse.validator.js';
import { validateCancelReservationRequest } from './validators/CancelReservationRequest.validator.js';
import { validateCancelReservationResponse } from './validators/CancelReservationResponse.validator.js';
import { validateCertificateSignedRequest } from './validators/CertificateSignedRequest.validator.js';
import { validateCertificateSignedResponse } from './validators/CertificateSignedResponse.validator.js';
import { validateChangeAvailabilityRequest } from './validators/ChangeAvailabilityRequest.validator.js';
import { validateChangeAvailabilityResponse } from './validators/ChangeAvailabilityResponse.validator.js';
import { validateChangeTransactionTariffRequest } from './validators/ChangeTransactionTariffRequest.validator.js';
import { validateChangeTransactionTariffResponse } from './validators/ChangeTransactionTariffResponse.validator.js';
import { validateClearCacheRequest } from './validators/ClearCacheRequest.validator.js';
import { validateClearCacheResponse } from './validators/ClearCacheResponse.validator.js';
import { validateClearChargingProfileRequest } from './validators/ClearChargingProfileRequest.validator.js';
import { validateClearChargingProfileResponse } from './validators/ClearChargingProfileResponse.validator.js';
import { validateClearDERControlRequest } from './validators/ClearDERControlRequest.validator.js';
import { validateClearDERControlResponse } from './validators/ClearDERControlResponse.validator.js';
import { validateClearDisplayMessageRequest } from './validators/ClearDisplayMessageRequest.validator.js';
import { validateClearDisplayMessageResponse } from './validators/ClearDisplayMessageResponse.validator.js';
import { validateClearedChargingLimitRequest } from './validators/ClearedChargingLimitRequest.validator.js';
import { validateClearedChargingLimitResponse } from './validators/ClearedChargingLimitResponse.validator.js';
import { validateClearTariffsRequest } from './validators/ClearTariffsRequest.validator.js';
import { validateClearTariffsResponse } from './validators/ClearTariffsResponse.validator.js';
import { validateClearVariableMonitoringRequest } from './validators/ClearVariableMonitoringRequest.validator.js';
import { validateClearVariableMonitoringResponse } from './validators/ClearVariableMonitoringResponse.validator.js';
import { validateClosePeriodicEventStreamRequest } from './validators/ClosePeriodicEventStreamRequest.validator.js';
import { validateClosePeriodicEventStreamResponse } from './validators/ClosePeriodicEventStreamResponse.validator.js';
import { validateCostUpdatedRequest } from './validators/CostUpdatedRequest.validator.js';
import { validateCostUpdatedResponse } from './validators/CostUpdatedResponse.validator.js';
import { validateCustomerInformationRequest } from './validators/CustomerInformationRequest.validator.js';
import { validateCustomerInformationResponse } from './validators/CustomerInformationResponse.validator.js';
import { validateDataTransferRequest } from './validators/DataTransferRequest.validator.js';
import { validateDataTransferResponse } from './validators/DataTransferResponse.validator.js';
import { validateDeleteCertificateRequest } from './validators/DeleteCertificateRequest.validator.js';
import { validateDeleteCertificateResponse } from './validators/DeleteCertificateResponse.validator.js';
import { validateFirmwareStatusNotificationRequest } from './validators/FirmwareStatusNotificationRequest.validator.js';
import { validateFirmwareStatusNotificationResponse } from './validators/FirmwareStatusNotificationResponse.validator.js';
import { validateGet15118EVCertificateRequest } from './validators/Get15118EVCertificateRequest.validator.js';
import { validateGet15118EVCertificateResponse } from './validators/Get15118EVCertificateResponse.validator.js';
import { validateGetBaseReportRequest } from './validators/GetBaseReportRequest.validator.js';
import { validateGetBaseReportResponse } from './validators/GetBaseReportResponse.validator.js';
import { validateGetCertificateChainStatusRequest } from './validators/GetCertificateChainStatusRequest.validator.js';
import { validateGetCertificateChainStatusResponse } from './validators/GetCertificateChainStatusResponse.validator.js';
import { validateGetCertificateStatusRequest } from './validators/GetCertificateStatusRequest.validator.js';
import { validateGetCertificateStatusResponse } from './validators/GetCertificateStatusResponse.validator.js';
import { validateGetChargingProfilesRequest } from './validators/GetChargingProfilesRequest.validator.js';
import { validateGetChargingProfilesResponse } from './validators/GetChargingProfilesResponse.validator.js';
import { validateGetCompositeScheduleRequest } from './validators/GetCompositeScheduleRequest.validator.js';
import { validateGetCompositeScheduleResponse } from './validators/GetCompositeScheduleResponse.validator.js';
import { validateGetDERControlRequest } from './validators/GetDERControlRequest.validator.js';
import { validateGetDERControlResponse } from './validators/GetDERControlResponse.validator.js';
import { validateGetDisplayMessagesRequest } from './validators/GetDisplayMessagesRequest.validator.js';
import { validateGetDisplayMessagesResponse } from './validators/GetDisplayMessagesResponse.validator.js';
import { validateGetInstalledCertificateIdsRequest } from './validators/GetInstalledCertificateIdsRequest.validator.js';
import { validateGetInstalledCertificateIdsResponse } from './validators/GetInstalledCertificateIdsResponse.validator.js';
import { validateGetLocalListVersionRequest } from './validators/GetLocalListVersionRequest.validator.js';
import { validateGetLocalListVersionResponse } from './validators/GetLocalListVersionResponse.validator.js';
import { validateGetLogRequest } from './validators/GetLogRequest.validator.js';
import { validateGetLogResponse } from './validators/GetLogResponse.validator.js';
import { validateGetMonitoringReportRequest } from './validators/GetMonitoringReportRequest.validator.js';
import { validateGetMonitoringReportResponse } from './validators/GetMonitoringReportResponse.validator.js';
import { validateGetPeriodicEventStreamRequest } from './validators/GetPeriodicEventStreamRequest.validator.js';
import { validateGetPeriodicEventStreamResponse } from './validators/GetPeriodicEventStreamResponse.validator.js';
import { validateGetReportRequest } from './validators/GetReportRequest.validator.js';
import { validateGetReportResponse } from './validators/GetReportResponse.validator.js';
import { validateGetTariffsRequest } from './validators/GetTariffsRequest.validator.js';
import { validateGetTariffsResponse } from './validators/GetTariffsResponse.validator.js';
import { validateGetTransactionStatusRequest } from './validators/GetTransactionStatusRequest.validator.js';
import { validateGetTransactionStatusResponse } from './validators/GetTransactionStatusResponse.validator.js';
import { validateGetVariablesRequest } from './validators/GetVariablesRequest.validator.js';
import { validateGetVariablesResponse } from './validators/GetVariablesResponse.validator.js';
import { validateHeartbeatRequest } from './validators/HeartbeatRequest.validator.js';
import { validateHeartbeatResponse } from './validators/HeartbeatResponse.validator.js';
import { validateInstallCertificateRequest } from './validators/InstallCertificateRequest.validator.js';
import { validateInstallCertificateResponse } from './validators/InstallCertificateResponse.validator.js';
import { validateLogStatusNotificationRequest } from './validators/LogStatusNotificationRequest.validator.js';
import { validateLogStatusNotificationResponse } from './validators/LogStatusNotificationResponse.validator.js';
import { validateMeterValuesRequest } from './validators/MeterValuesRequest.validator.js';
import { validateMeterValuesResponse } from './validators/MeterValuesResponse.validator.js';
import { validateNotifyAllowedEnergyTransferRequest } from './validators/NotifyAllowedEnergyTransferRequest.validator.js';
import { validateNotifyAllowedEnergyTransferResponse } from './validators/NotifyAllowedEnergyTransferResponse.validator.js';
import { validateNotifyChargingLimitRequest } from './validators/NotifyChargingLimitRequest.validator.js';
import { validateNotifyChargingLimitResponse } from './validators/NotifyChargingLimitResponse.validator.js';
import { validateNotifyCustomerInformationRequest } from './validators/NotifyCustomerInformationRequest.validator.js';
import { validateNotifyCustomerInformationResponse } from './validators/NotifyCustomerInformationResponse.validator.js';
import { validateNotifyDERAlarmRequest } from './validators/NotifyDERAlarmRequest.validator.js';
import { validateNotifyDERAlarmResponse } from './validators/NotifyDERAlarmResponse.validator.js';
import { validateNotifyDERStartStopRequest } from './validators/NotifyDERStartStopRequest.validator.js';
import { validateNotifyDERStartStopResponse } from './validators/NotifyDERStartStopResponse.validator.js';
import { validateNotifyDisplayMessagesRequest } from './validators/NotifyDisplayMessagesRequest.validator.js';
import { validateNotifyDisplayMessagesResponse } from './validators/NotifyDisplayMessagesResponse.validator.js';
import { validateNotifyEVChargingNeedsRequest } from './validators/NotifyEVChargingNeedsRequest.validator.js';
import { validateNotifyEVChargingNeedsResponse } from './validators/NotifyEVChargingNeedsResponse.validator.js';
import { validateNotifyEVChargingScheduleRequest } from './validators/NotifyEVChargingScheduleRequest.validator.js';
import { validateNotifyEVChargingScheduleResponse } from './validators/NotifyEVChargingScheduleResponse.validator.js';
import { validateNotifyEventRequest } from './validators/NotifyEventRequest.validator.js';
import { validateNotifyEventResponse } from './validators/NotifyEventResponse.validator.js';
import { validateNotifyMonitoringReportRequest } from './validators/NotifyMonitoringReportRequest.validator.js';
import { validateNotifyMonitoringReportResponse } from './validators/NotifyMonitoringReportResponse.validator.js';
import { validateNotifyPriorityChargingRequest } from './validators/NotifyPriorityChargingRequest.validator.js';
import { validateNotifyPriorityChargingResponse } from './validators/NotifyPriorityChargingResponse.validator.js';
import { validateNotifyReportRequest } from './validators/NotifyReportRequest.validator.js';
import { validateNotifyReportResponse } from './validators/NotifyReportResponse.validator.js';
import { validateNotifySettlementRequest } from './validators/NotifySettlementRequest.validator.js';
import { validateNotifySettlementResponse } from './validators/NotifySettlementResponse.validator.js';
import { validateNotifyWebPaymentStartedRequest } from './validators/NotifyWebPaymentStartedRequest.validator.js';
import { validateNotifyWebPaymentStartedResponse } from './validators/NotifyWebPaymentStartedResponse.validator.js';
import { validateOpenPeriodicEventStreamRequest } from './validators/OpenPeriodicEventStreamRequest.validator.js';
import { validateOpenPeriodicEventStreamResponse } from './validators/OpenPeriodicEventStreamResponse.validator.js';
import { validatePublishFirmwareRequest } from './validators/PublishFirmwareRequest.validator.js';
import { validatePublishFirmwareResponse } from './validators/PublishFirmwareResponse.validator.js';
import { validatePublishFirmwareStatusNotificationRequest } from './validators/PublishFirmwareStatusNotificationRequest.validator.js';
import { validatePublishFirmwareStatusNotificationResponse } from './validators/PublishFirmwareStatusNotificationResponse.validator.js';
import { validatePullDynamicScheduleUpdateRequest } from './validators/PullDynamicScheduleUpdateRequest.validator.js';
import { validatePullDynamicScheduleUpdateResponse } from './validators/PullDynamicScheduleUpdateResponse.validator.js';
import { validateReportChargingProfilesRequest } from './validators/ReportChargingProfilesRequest.validator.js';
import { validateReportChargingProfilesResponse } from './validators/ReportChargingProfilesResponse.validator.js';
import { validateReportDERControlRequest } from './validators/ReportDERControlRequest.validator.js';
import { validateReportDERControlResponse } from './validators/ReportDERControlResponse.validator.js';
import { validateRequestBatterySwapRequest } from './validators/RequestBatterySwapRequest.validator.js';
import { validateRequestBatterySwapResponse } from './validators/RequestBatterySwapResponse.validator.js';
import { validateRequestStartTransactionRequest } from './validators/RequestStartTransactionRequest.validator.js';
import { validateRequestStartTransactionResponse } from './validators/RequestStartTransactionResponse.validator.js';
import { validateRequestStopTransactionRequest } from './validators/RequestStopTransactionRequest.validator.js';
import { validateRequestStopTransactionResponse } from './validators/RequestStopTransactionResponse.validator.js';
import { validateReservationStatusUpdateRequest } from './validators/ReservationStatusUpdateRequest.validator.js';
import { validateReservationStatusUpdateResponse } from './validators/ReservationStatusUpdateResponse.validator.js';
import { validateReserveNowRequest } from './validators/ReserveNowRequest.validator.js';
import { validateReserveNowResponse } from './validators/ReserveNowResponse.validator.js';
import { validateResetRequest } from './validators/ResetRequest.validator.js';
import { validateResetResponse } from './validators/ResetResponse.validator.js';
import { validateSecurityEventNotificationRequest } from './validators/SecurityEventNotificationRequest.validator.js';
import { validateSecurityEventNotificationResponse } from './validators/SecurityEventNotificationResponse.validator.js';
import { validateSendLocalListRequest } from './validators/SendLocalListRequest.validator.js';
import { validateSendLocalListResponse } from './validators/SendLocalListResponse.validator.js';
import { validateSetChargingProfileRequest } from './validators/SetChargingProfileRequest.validator.js';
import { validateSetChargingProfileResponse } from './validators/SetChargingProfileResponse.validator.js';
import { validateSetDefaultTariffRequest } from './validators/SetDefaultTariffRequest.validator.js';
import { validateSetDefaultTariffResponse } from './validators/SetDefaultTariffResponse.validator.js';
import { validateSetDERControlRequest } from './validators/SetDERControlRequest.validator.js';
import { validateSetDERControlResponse } from './validators/SetDERControlResponse.validator.js';
import { validateSetDisplayMessageRequest } from './validators/SetDisplayMessageRequest.validator.js';
import { validateSetDisplayMessageResponse } from './validators/SetDisplayMessageResponse.validator.js';
import { validateSetMonitoringBaseRequest } from './validators/SetMonitoringBaseRequest.validator.js';
import { validateSetMonitoringBaseResponse } from './validators/SetMonitoringBaseResponse.validator.js';
import { validateSetMonitoringLevelRequest } from './validators/SetMonitoringLevelRequest.validator.js';
import { validateSetMonitoringLevelResponse } from './validators/SetMonitoringLevelResponse.validator.js';
import { validateSetNetworkProfileRequest } from './validators/SetNetworkProfileRequest.validator.js';
import { validateSetNetworkProfileResponse } from './validators/SetNetworkProfileResponse.validator.js';
import { validateSetVariableMonitoringRequest } from './validators/SetVariableMonitoringRequest.validator.js';
import { validateSetVariableMonitoringResponse } from './validators/SetVariableMonitoringResponse.validator.js';
import { validateSetVariablesRequest } from './validators/SetVariablesRequest.validator.js';
import { validateSetVariablesResponse } from './validators/SetVariablesResponse.validator.js';
import { validateSignCertificateRequest } from './validators/SignCertificateRequest.validator.js';
import { validateSignCertificateResponse } from './validators/SignCertificateResponse.validator.js';
import { validateStatusNotificationRequest } from './validators/StatusNotificationRequest.validator.js';
import { validateStatusNotificationResponse } from './validators/StatusNotificationResponse.validator.js';
import { validateTransactionEventRequest } from './validators/TransactionEventRequest.validator.js';
import { validateTransactionEventResponse } from './validators/TransactionEventResponse.validator.js';
import { validateTriggerMessageRequest } from './validators/TriggerMessageRequest.validator.js';
import { validateTriggerMessageResponse } from './validators/TriggerMessageResponse.validator.js';
import { validateUnlockConnectorRequest } from './validators/UnlockConnectorRequest.validator.js';
import { validateUnlockConnectorResponse } from './validators/UnlockConnectorResponse.validator.js';
import { validateUnpublishFirmwareRequest } from './validators/UnpublishFirmwareRequest.validator.js';
import { validateUnpublishFirmwareResponse } from './validators/UnpublishFirmwareResponse.validator.js';
import { validateUpdateDynamicScheduleRequest } from './validators/UpdateDynamicScheduleRequest.validator.js';
import { validateUpdateDynamicScheduleResponse } from './validators/UpdateDynamicScheduleResponse.validator.js';
import { validateUpdateFirmwareRequest } from './validators/UpdateFirmwareRequest.validator.js';
import { validateUpdateFirmwareResponse } from './validators/UpdateFirmwareResponse.validator.js';
import { validateUsePriorityChargingRequest } from './validators/UsePriorityChargingRequest.validator.js';
import { validateUsePriorityChargingResponse } from './validators/UsePriorityChargingResponse.validator.js';
import { validateVatNumberValidationRequest } from './validators/VatNumberValidationRequest.validator.js';
import { validateVatNumberValidationResponse } from './validators/VatNumberValidationResponse.validator.js';

export const ActionRegistry = {
  AdjustPeriodicEventStream: {
    validateRequest: validateAdjustPeriodicEventStreamRequest,
    validateResponse: validateAdjustPeriodicEventStreamResponse,
  },
  AFRRSignal: {
    validateRequest: validateAFRRSignalRequest,
    validateResponse: validateAFRRSignalResponse,
  },
  Authorize: {
    validateRequest: validateAuthorizeRequest,
    validateResponse: validateAuthorizeResponse,
  },
  BatterySwap: {
    validateRequest: validateBatterySwapRequest,
    validateResponse: validateBatterySwapResponse,
  },
  BootNotification: {
    validateRequest: validateBootNotificationRequest,
    validateResponse: validateBootNotificationResponse,
  },
  CancelReservation: {
    validateRequest: validateCancelReservationRequest,
    validateResponse: validateCancelReservationResponse,
  },
  CertificateSigned: {
    validateRequest: validateCertificateSignedRequest,
    validateResponse: validateCertificateSignedResponse,
  },
  ChangeAvailability: {
    validateRequest: validateChangeAvailabilityRequest,
    validateResponse: validateChangeAvailabilityResponse,
  },
  ChangeTransactionTariff: {
    validateRequest: validateChangeTransactionTariffRequest,
    validateResponse: validateChangeTransactionTariffResponse,
  },
  ClearCache: {
    validateRequest: validateClearCacheRequest,
    validateResponse: validateClearCacheResponse,
  },
  ClearChargingProfile: {
    validateRequest: validateClearChargingProfileRequest,
    validateResponse: validateClearChargingProfileResponse,
  },
  ClearDERControl: {
    validateRequest: validateClearDERControlRequest,
    validateResponse: validateClearDERControlResponse,
  },
  ClearDisplayMessage: {
    validateRequest: validateClearDisplayMessageRequest,
    validateResponse: validateClearDisplayMessageResponse,
  },
  ClearedChargingLimit: {
    validateRequest: validateClearedChargingLimitRequest,
    validateResponse: validateClearedChargingLimitResponse,
  },
  ClearTariffs: {
    validateRequest: validateClearTariffsRequest,
    validateResponse: validateClearTariffsResponse,
  },
  ClearVariableMonitoring: {
    validateRequest: validateClearVariableMonitoringRequest,
    validateResponse: validateClearVariableMonitoringResponse,
  },
  ClosePeriodicEventStream: {
    validateRequest: validateClosePeriodicEventStreamRequest,
    validateResponse: validateClosePeriodicEventStreamResponse,
  },
  CostUpdated: {
    validateRequest: validateCostUpdatedRequest,
    validateResponse: validateCostUpdatedResponse,
  },
  CustomerInformation: {
    validateRequest: validateCustomerInformationRequest,
    validateResponse: validateCustomerInformationResponse,
  },
  DataTransfer: {
    validateRequest: validateDataTransferRequest,
    validateResponse: validateDataTransferResponse,
  },
  DeleteCertificate: {
    validateRequest: validateDeleteCertificateRequest,
    validateResponse: validateDeleteCertificateResponse,
  },
  FirmwareStatusNotification: {
    validateRequest: validateFirmwareStatusNotificationRequest,
    validateResponse: validateFirmwareStatusNotificationResponse,
  },
  Get15118EVCertificate: {
    validateRequest: validateGet15118EVCertificateRequest,
    validateResponse: validateGet15118EVCertificateResponse,
  },
  GetBaseReport: {
    validateRequest: validateGetBaseReportRequest,
    validateResponse: validateGetBaseReportResponse,
  },
  GetCertificateChainStatus: {
    validateRequest: validateGetCertificateChainStatusRequest,
    validateResponse: validateGetCertificateChainStatusResponse,
  },
  GetCertificateStatus: {
    validateRequest: validateGetCertificateStatusRequest,
    validateResponse: validateGetCertificateStatusResponse,
  },
  GetChargingProfiles: {
    validateRequest: validateGetChargingProfilesRequest,
    validateResponse: validateGetChargingProfilesResponse,
  },
  GetCompositeSchedule: {
    validateRequest: validateGetCompositeScheduleRequest,
    validateResponse: validateGetCompositeScheduleResponse,
  },
  GetDERControl: {
    validateRequest: validateGetDERControlRequest,
    validateResponse: validateGetDERControlResponse,
  },
  GetDisplayMessages: {
    validateRequest: validateGetDisplayMessagesRequest,
    validateResponse: validateGetDisplayMessagesResponse,
  },
  GetInstalledCertificateIds: {
    validateRequest: validateGetInstalledCertificateIdsRequest,
    validateResponse: validateGetInstalledCertificateIdsResponse,
  },
  GetLocalListVersion: {
    validateRequest: validateGetLocalListVersionRequest,
    validateResponse: validateGetLocalListVersionResponse,
  },
  GetLog: {
    validateRequest: validateGetLogRequest,
    validateResponse: validateGetLogResponse,
  },
  GetMonitoringReport: {
    validateRequest: validateGetMonitoringReportRequest,
    validateResponse: validateGetMonitoringReportResponse,
  },
  GetPeriodicEventStream: {
    validateRequest: validateGetPeriodicEventStreamRequest,
    validateResponse: validateGetPeriodicEventStreamResponse,
  },
  GetReport: {
    validateRequest: validateGetReportRequest,
    validateResponse: validateGetReportResponse,
  },
  GetTariffs: {
    validateRequest: validateGetTariffsRequest,
    validateResponse: validateGetTariffsResponse,
  },
  GetTransactionStatus: {
    validateRequest: validateGetTransactionStatusRequest,
    validateResponse: validateGetTransactionStatusResponse,
  },
  GetVariables: {
    validateRequest: validateGetVariablesRequest,
    validateResponse: validateGetVariablesResponse,
  },
  Heartbeat: {
    validateRequest: validateHeartbeatRequest,
    validateResponse: validateHeartbeatResponse,
  },
  InstallCertificate: {
    validateRequest: validateInstallCertificateRequest,
    validateResponse: validateInstallCertificateResponse,
  },
  LogStatusNotification: {
    validateRequest: validateLogStatusNotificationRequest,
    validateResponse: validateLogStatusNotificationResponse,
  },
  MeterValues: {
    validateRequest: validateMeterValuesRequest,
    validateResponse: validateMeterValuesResponse,
  },
  NotifyAllowedEnergyTransfer: {
    validateRequest: validateNotifyAllowedEnergyTransferRequest,
    validateResponse: validateNotifyAllowedEnergyTransferResponse,
  },
  NotifyChargingLimit: {
    validateRequest: validateNotifyChargingLimitRequest,
    validateResponse: validateNotifyChargingLimitResponse,
  },
  NotifyCustomerInformation: {
    validateRequest: validateNotifyCustomerInformationRequest,
    validateResponse: validateNotifyCustomerInformationResponse,
  },
  NotifyDERAlarm: {
    validateRequest: validateNotifyDERAlarmRequest,
    validateResponse: validateNotifyDERAlarmResponse,
  },
  NotifyDERStartStop: {
    validateRequest: validateNotifyDERStartStopRequest,
    validateResponse: validateNotifyDERStartStopResponse,
  },
  NotifyDisplayMessages: {
    validateRequest: validateNotifyDisplayMessagesRequest,
    validateResponse: validateNotifyDisplayMessagesResponse,
  },
  NotifyEVChargingNeeds: {
    validateRequest: validateNotifyEVChargingNeedsRequest,
    validateResponse: validateNotifyEVChargingNeedsResponse,
  },
  NotifyEVChargingSchedule: {
    validateRequest: validateNotifyEVChargingScheduleRequest,
    validateResponse: validateNotifyEVChargingScheduleResponse,
  },
  NotifyEvent: {
    validateRequest: validateNotifyEventRequest,
    validateResponse: validateNotifyEventResponse,
  },
  NotifyMonitoringReport: {
    validateRequest: validateNotifyMonitoringReportRequest,
    validateResponse: validateNotifyMonitoringReportResponse,
  },
  NotifyPriorityCharging: {
    validateRequest: validateNotifyPriorityChargingRequest,
    validateResponse: validateNotifyPriorityChargingResponse,
  },
  NotifyReport: {
    validateRequest: validateNotifyReportRequest,
    validateResponse: validateNotifyReportResponse,
  },
  NotifySettlement: {
    validateRequest: validateNotifySettlementRequest,
    validateResponse: validateNotifySettlementResponse,
  },
  NotifyWebPaymentStarted: {
    validateRequest: validateNotifyWebPaymentStartedRequest,
    validateResponse: validateNotifyWebPaymentStartedResponse,
  },
  OpenPeriodicEventStream: {
    validateRequest: validateOpenPeriodicEventStreamRequest,
    validateResponse: validateOpenPeriodicEventStreamResponse,
  },
  PublishFirmware: {
    validateRequest: validatePublishFirmwareRequest,
    validateResponse: validatePublishFirmwareResponse,
  },
  PublishFirmwareStatusNotification: {
    validateRequest: validatePublishFirmwareStatusNotificationRequest,
    validateResponse: validatePublishFirmwareStatusNotificationResponse,
  },
  PullDynamicScheduleUpdate: {
    validateRequest: validatePullDynamicScheduleUpdateRequest,
    validateResponse: validatePullDynamicScheduleUpdateResponse,
  },
  ReportChargingProfiles: {
    validateRequest: validateReportChargingProfilesRequest,
    validateResponse: validateReportChargingProfilesResponse,
  },
  ReportDERControl: {
    validateRequest: validateReportDERControlRequest,
    validateResponse: validateReportDERControlResponse,
  },
  RequestBatterySwap: {
    validateRequest: validateRequestBatterySwapRequest,
    validateResponse: validateRequestBatterySwapResponse,
  },
  RequestStartTransaction: {
    validateRequest: validateRequestStartTransactionRequest,
    validateResponse: validateRequestStartTransactionResponse,
  },
  RequestStopTransaction: {
    validateRequest: validateRequestStopTransactionRequest,
    validateResponse: validateRequestStopTransactionResponse,
  },
  ReservationStatusUpdate: {
    validateRequest: validateReservationStatusUpdateRequest,
    validateResponse: validateReservationStatusUpdateResponse,
  },
  ReserveNow: {
    validateRequest: validateReserveNowRequest,
    validateResponse: validateReserveNowResponse,
  },
  Reset: {
    validateRequest: validateResetRequest,
    validateResponse: validateResetResponse,
  },
  SecurityEventNotification: {
    validateRequest: validateSecurityEventNotificationRequest,
    validateResponse: validateSecurityEventNotificationResponse,
  },
  SendLocalList: {
    validateRequest: validateSendLocalListRequest,
    validateResponse: validateSendLocalListResponse,
  },
  SetChargingProfile: {
    validateRequest: validateSetChargingProfileRequest,
    validateResponse: validateSetChargingProfileResponse,
  },
  SetDefaultTariff: {
    validateRequest: validateSetDefaultTariffRequest,
    validateResponse: validateSetDefaultTariffResponse,
  },
  SetDERControl: {
    validateRequest: validateSetDERControlRequest,
    validateResponse: validateSetDERControlResponse,
  },
  SetDisplayMessage: {
    validateRequest: validateSetDisplayMessageRequest,
    validateResponse: validateSetDisplayMessageResponse,
  },
  SetMonitoringBase: {
    validateRequest: validateSetMonitoringBaseRequest,
    validateResponse: validateSetMonitoringBaseResponse,
  },
  SetMonitoringLevel: {
    validateRequest: validateSetMonitoringLevelRequest,
    validateResponse: validateSetMonitoringLevelResponse,
  },
  SetNetworkProfile: {
    validateRequest: validateSetNetworkProfileRequest,
    validateResponse: validateSetNetworkProfileResponse,
  },
  SetVariableMonitoring: {
    validateRequest: validateSetVariableMonitoringRequest,
    validateResponse: validateSetVariableMonitoringResponse,
  },
  SetVariables: {
    validateRequest: validateSetVariablesRequest,
    validateResponse: validateSetVariablesResponse,
  },
  SignCertificate: {
    validateRequest: validateSignCertificateRequest,
    validateResponse: validateSignCertificateResponse,
  },
  StatusNotification: {
    validateRequest: validateStatusNotificationRequest,
    validateResponse: validateStatusNotificationResponse,
  },
  TransactionEvent: {
    validateRequest: validateTransactionEventRequest,
    validateResponse: validateTransactionEventResponse,
  },
  TriggerMessage: {
    validateRequest: validateTriggerMessageRequest,
    validateResponse: validateTriggerMessageResponse,
  },
  UnlockConnector: {
    validateRequest: validateUnlockConnectorRequest,
    validateResponse: validateUnlockConnectorResponse,
  },
  UnpublishFirmware: {
    validateRequest: validateUnpublishFirmwareRequest,
    validateResponse: validateUnpublishFirmwareResponse,
  },
  UpdateDynamicSchedule: {
    validateRequest: validateUpdateDynamicScheduleRequest,
    validateResponse: validateUpdateDynamicScheduleResponse,
  },
  UpdateFirmware: {
    validateRequest: validateUpdateFirmwareRequest,
    validateResponse: validateUpdateFirmwareResponse,
  },
  UsePriorityCharging: {
    validateRequest: validateUsePriorityChargingRequest,
    validateResponse: validateUsePriorityChargingResponse,
  },
  VatNumberValidation: {
    validateRequest: validateVatNumberValidationRequest,
    validateResponse: validateVatNumberValidationResponse,
  },
} as const;

export type ActionName = keyof typeof ActionRegistry;
