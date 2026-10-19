import { validateAuthorizeRequest, fitAuthorizeRequest } from './validators/AuthorizeRequest.validator.js';
import { validateAuthorizeResponse, fitAuthorizeResponse } from './validators/AuthorizeResponse.validator.js';
import { validateBootNotificationRequest, fitBootNotificationRequest } from './validators/BootNotificationRequest.validator.js';
import { validateBootNotificationResponse, fitBootNotificationResponse } from './validators/BootNotificationResponse.validator.js';
import { validateCancelReservationRequest, fitCancelReservationRequest } from './validators/CancelReservationRequest.validator.js';
import { validateCancelReservationResponse, fitCancelReservationResponse } from './validators/CancelReservationResponse.validator.js';
import { validateCertificateSignedRequest, fitCertificateSignedRequest } from './validators/CertificateSignedRequest.validator.js';
import { validateCertificateSignedResponse, fitCertificateSignedResponse } from './validators/CertificateSignedResponse.validator.js';
import { validateChangeAvailabilityRequest, fitChangeAvailabilityRequest } from './validators/ChangeAvailabilityRequest.validator.js';
import { validateChangeAvailabilityResponse, fitChangeAvailabilityResponse } from './validators/ChangeAvailabilityResponse.validator.js';
import { validateClearCacheRequest, fitClearCacheRequest } from './validators/ClearCacheRequest.validator.js';
import { validateClearCacheResponse, fitClearCacheResponse } from './validators/ClearCacheResponse.validator.js';
import { validateClearChargingProfileRequest, fitClearChargingProfileRequest } from './validators/ClearChargingProfileRequest.validator.js';
import { validateClearChargingProfileResponse, fitClearChargingProfileResponse } from './validators/ClearChargingProfileResponse.validator.js';
import { validateClearDisplayMessageRequest, fitClearDisplayMessageRequest } from './validators/ClearDisplayMessageRequest.validator.js';
import { validateClearDisplayMessageResponse, fitClearDisplayMessageResponse } from './validators/ClearDisplayMessageResponse.validator.js';
import { validateClearedChargingLimitRequest, fitClearedChargingLimitRequest } from './validators/ClearedChargingLimitRequest.validator.js';
import { validateClearedChargingLimitResponse, fitClearedChargingLimitResponse } from './validators/ClearedChargingLimitResponse.validator.js';
import { validateClearVariableMonitoringRequest, fitClearVariableMonitoringRequest } from './validators/ClearVariableMonitoringRequest.validator.js';
import { validateClearVariableMonitoringResponse, fitClearVariableMonitoringResponse } from './validators/ClearVariableMonitoringResponse.validator.js';
import { validateCostUpdatedRequest, fitCostUpdatedRequest } from './validators/CostUpdatedRequest.validator.js';
import { validateCostUpdatedResponse, fitCostUpdatedResponse } from './validators/CostUpdatedResponse.validator.js';
import { validateCustomerInformationRequest, fitCustomerInformationRequest } from './validators/CustomerInformationRequest.validator.js';
import { validateCustomerInformationResponse, fitCustomerInformationResponse } from './validators/CustomerInformationResponse.validator.js';
import { validateDataTransferRequest, fitDataTransferRequest } from './validators/DataTransferRequest.validator.js';
import { validateDataTransferResponse, fitDataTransferResponse } from './validators/DataTransferResponse.validator.js';
import { validateDeleteCertificateRequest, fitDeleteCertificateRequest } from './validators/DeleteCertificateRequest.validator.js';
import { validateDeleteCertificateResponse, fitDeleteCertificateResponse } from './validators/DeleteCertificateResponse.validator.js';
import { validateFirmwareStatusNotificationRequest, fitFirmwareStatusNotificationRequest } from './validators/FirmwareStatusNotificationRequest.validator.js';
import { validateFirmwareStatusNotificationResponse, fitFirmwareStatusNotificationResponse } from './validators/FirmwareStatusNotificationResponse.validator.js';
import { validateGet15118EVCertificateRequest, fitGet15118EVCertificateRequest } from './validators/Get15118EVCertificateRequest.validator.js';
import { validateGet15118EVCertificateResponse, fitGet15118EVCertificateResponse } from './validators/Get15118EVCertificateResponse.validator.js';
import { validateGetBaseReportRequest, fitGetBaseReportRequest } from './validators/GetBaseReportRequest.validator.js';
import { validateGetBaseReportResponse, fitGetBaseReportResponse } from './validators/GetBaseReportResponse.validator.js';
import { validateGetCertificateStatusRequest, fitGetCertificateStatusRequest } from './validators/GetCertificateStatusRequest.validator.js';
import { validateGetCertificateStatusResponse, fitGetCertificateStatusResponse } from './validators/GetCertificateStatusResponse.validator.js';
import { validateGetChargingProfilesRequest, fitGetChargingProfilesRequest } from './validators/GetChargingProfilesRequest.validator.js';
import { validateGetChargingProfilesResponse, fitGetChargingProfilesResponse } from './validators/GetChargingProfilesResponse.validator.js';
import { validateGetCompositeScheduleRequest, fitGetCompositeScheduleRequest } from './validators/GetCompositeScheduleRequest.validator.js';
import { validateGetCompositeScheduleResponse, fitGetCompositeScheduleResponse } from './validators/GetCompositeScheduleResponse.validator.js';
import { validateGetDisplayMessagesRequest, fitGetDisplayMessagesRequest } from './validators/GetDisplayMessagesRequest.validator.js';
import { validateGetDisplayMessagesResponse, fitGetDisplayMessagesResponse } from './validators/GetDisplayMessagesResponse.validator.js';
import { validateGetInstalledCertificateIdsRequest, fitGetInstalledCertificateIdsRequest } from './validators/GetInstalledCertificateIdsRequest.validator.js';
import { validateGetInstalledCertificateIdsResponse, fitGetInstalledCertificateIdsResponse } from './validators/GetInstalledCertificateIdsResponse.validator.js';
import { validateGetLocalListVersionRequest, fitGetLocalListVersionRequest } from './validators/GetLocalListVersionRequest.validator.js';
import { validateGetLocalListVersionResponse, fitGetLocalListVersionResponse } from './validators/GetLocalListVersionResponse.validator.js';
import { validateGetLogRequest, fitGetLogRequest } from './validators/GetLogRequest.validator.js';
import { validateGetLogResponse, fitGetLogResponse } from './validators/GetLogResponse.validator.js';
import { validateGetMonitoringReportRequest, fitGetMonitoringReportRequest } from './validators/GetMonitoringReportRequest.validator.js';
import { validateGetMonitoringReportResponse, fitGetMonitoringReportResponse } from './validators/GetMonitoringReportResponse.validator.js';
import { validateGetReportRequest, fitGetReportRequest } from './validators/GetReportRequest.validator.js';
import { validateGetReportResponse, fitGetReportResponse } from './validators/GetReportResponse.validator.js';
import { validateGetTransactionStatusRequest, fitGetTransactionStatusRequest } from './validators/GetTransactionStatusRequest.validator.js';
import { validateGetTransactionStatusResponse, fitGetTransactionStatusResponse } from './validators/GetTransactionStatusResponse.validator.js';
import { validateGetVariablesRequest, fitGetVariablesRequest } from './validators/GetVariablesRequest.validator.js';
import { validateGetVariablesResponse, fitGetVariablesResponse } from './validators/GetVariablesResponse.validator.js';
import { validateHeartbeatRequest, fitHeartbeatRequest } from './validators/HeartbeatRequest.validator.js';
import { validateHeartbeatResponse, fitHeartbeatResponse } from './validators/HeartbeatResponse.validator.js';
import { validateInstallCertificateRequest, fitInstallCertificateRequest } from './validators/InstallCertificateRequest.validator.js';
import { validateInstallCertificateResponse, fitInstallCertificateResponse } from './validators/InstallCertificateResponse.validator.js';
import { validateLogStatusNotificationRequest, fitLogStatusNotificationRequest } from './validators/LogStatusNotificationRequest.validator.js';
import { validateLogStatusNotificationResponse, fitLogStatusNotificationResponse } from './validators/LogStatusNotificationResponse.validator.js';
import { validateMeterValuesRequest, fitMeterValuesRequest } from './validators/MeterValuesRequest.validator.js';
import { validateMeterValuesResponse, fitMeterValuesResponse } from './validators/MeterValuesResponse.validator.js';
import { validateNotifyChargingLimitRequest, fitNotifyChargingLimitRequest } from './validators/NotifyChargingLimitRequest.validator.js';
import { validateNotifyChargingLimitResponse, fitNotifyChargingLimitResponse } from './validators/NotifyChargingLimitResponse.validator.js';
import { validateNotifyCustomerInformationRequest, fitNotifyCustomerInformationRequest } from './validators/NotifyCustomerInformationRequest.validator.js';
import { validateNotifyCustomerInformationResponse, fitNotifyCustomerInformationResponse } from './validators/NotifyCustomerInformationResponse.validator.js';
import { validateNotifyDisplayMessagesRequest, fitNotifyDisplayMessagesRequest } from './validators/NotifyDisplayMessagesRequest.validator.js';
import { validateNotifyDisplayMessagesResponse, fitNotifyDisplayMessagesResponse } from './validators/NotifyDisplayMessagesResponse.validator.js';
import { validateNotifyEVChargingNeedsRequest, fitNotifyEVChargingNeedsRequest } from './validators/NotifyEVChargingNeedsRequest.validator.js';
import { validateNotifyEVChargingNeedsResponse, fitNotifyEVChargingNeedsResponse } from './validators/NotifyEVChargingNeedsResponse.validator.js';
import { validateNotifyEVChargingScheduleRequest, fitNotifyEVChargingScheduleRequest } from './validators/NotifyEVChargingScheduleRequest.validator.js';
import { validateNotifyEVChargingScheduleResponse, fitNotifyEVChargingScheduleResponse } from './validators/NotifyEVChargingScheduleResponse.validator.js';
import { validateNotifyEventRequest, fitNotifyEventRequest } from './validators/NotifyEventRequest.validator.js';
import { validateNotifyEventResponse, fitNotifyEventResponse } from './validators/NotifyEventResponse.validator.js';
import { validateNotifyMonitoringReportRequest, fitNotifyMonitoringReportRequest } from './validators/NotifyMonitoringReportRequest.validator.js';
import { validateNotifyMonitoringReportResponse, fitNotifyMonitoringReportResponse } from './validators/NotifyMonitoringReportResponse.validator.js';
import { validateNotifyReportRequest, fitNotifyReportRequest } from './validators/NotifyReportRequest.validator.js';
import { validateNotifyReportResponse, fitNotifyReportResponse } from './validators/NotifyReportResponse.validator.js';
import { validatePublishFirmwareRequest, fitPublishFirmwareRequest } from './validators/PublishFirmwareRequest.validator.js';
import { validatePublishFirmwareResponse, fitPublishFirmwareResponse } from './validators/PublishFirmwareResponse.validator.js';
import { validatePublishFirmwareStatusNotificationRequest, fitPublishFirmwareStatusNotificationRequest } from './validators/PublishFirmwareStatusNotificationRequest.validator.js';
import { validatePublishFirmwareStatusNotificationResponse, fitPublishFirmwareStatusNotificationResponse } from './validators/PublishFirmwareStatusNotificationResponse.validator.js';
import { validateReportChargingProfilesRequest, fitReportChargingProfilesRequest } from './validators/ReportChargingProfilesRequest.validator.js';
import { validateReportChargingProfilesResponse, fitReportChargingProfilesResponse } from './validators/ReportChargingProfilesResponse.validator.js';
import { validateRequestStartTransactionRequest, fitRequestStartTransactionRequest } from './validators/RequestStartTransactionRequest.validator.js';
import { validateRequestStartTransactionResponse, fitRequestStartTransactionResponse } from './validators/RequestStartTransactionResponse.validator.js';
import { validateRequestStopTransactionRequest, fitRequestStopTransactionRequest } from './validators/RequestStopTransactionRequest.validator.js';
import { validateRequestStopTransactionResponse, fitRequestStopTransactionResponse } from './validators/RequestStopTransactionResponse.validator.js';
import { validateReservationStatusUpdateRequest, fitReservationStatusUpdateRequest } from './validators/ReservationStatusUpdateRequest.validator.js';
import { validateReservationStatusUpdateResponse, fitReservationStatusUpdateResponse } from './validators/ReservationStatusUpdateResponse.validator.js';
import { validateReserveNowRequest, fitReserveNowRequest } from './validators/ReserveNowRequest.validator.js';
import { validateReserveNowResponse, fitReserveNowResponse } from './validators/ReserveNowResponse.validator.js';
import { validateResetRequest, fitResetRequest } from './validators/ResetRequest.validator.js';
import { validateResetResponse, fitResetResponse } from './validators/ResetResponse.validator.js';
import { validateSecurityEventNotificationRequest, fitSecurityEventNotificationRequest } from './validators/SecurityEventNotificationRequest.validator.js';
import { validateSecurityEventNotificationResponse, fitSecurityEventNotificationResponse } from './validators/SecurityEventNotificationResponse.validator.js';
import { validateSendLocalListRequest, fitSendLocalListRequest } from './validators/SendLocalListRequest.validator.js';
import { validateSendLocalListResponse, fitSendLocalListResponse } from './validators/SendLocalListResponse.validator.js';
import { validateSetChargingProfileRequest, fitSetChargingProfileRequest } from './validators/SetChargingProfileRequest.validator.js';
import { validateSetChargingProfileResponse, fitSetChargingProfileResponse } from './validators/SetChargingProfileResponse.validator.js';
import { validateSetDisplayMessageRequest, fitSetDisplayMessageRequest } from './validators/SetDisplayMessageRequest.validator.js';
import { validateSetDisplayMessageResponse, fitSetDisplayMessageResponse } from './validators/SetDisplayMessageResponse.validator.js';
import { validateSetMonitoringBaseRequest, fitSetMonitoringBaseRequest } from './validators/SetMonitoringBaseRequest.validator.js';
import { validateSetMonitoringBaseResponse, fitSetMonitoringBaseResponse } from './validators/SetMonitoringBaseResponse.validator.js';
import { validateSetMonitoringLevelRequest, fitSetMonitoringLevelRequest } from './validators/SetMonitoringLevelRequest.validator.js';
import { validateSetMonitoringLevelResponse, fitSetMonitoringLevelResponse } from './validators/SetMonitoringLevelResponse.validator.js';
import { validateSetNetworkProfileRequest, fitSetNetworkProfileRequest } from './validators/SetNetworkProfileRequest.validator.js';
import { validateSetNetworkProfileResponse, fitSetNetworkProfileResponse } from './validators/SetNetworkProfileResponse.validator.js';
import { validateSetVariableMonitoringRequest, fitSetVariableMonitoringRequest } from './validators/SetVariableMonitoringRequest.validator.js';
import { validateSetVariableMonitoringResponse, fitSetVariableMonitoringResponse } from './validators/SetVariableMonitoringResponse.validator.js';
import { validateSetVariablesRequest, fitSetVariablesRequest } from './validators/SetVariablesRequest.validator.js';
import { validateSetVariablesResponse, fitSetVariablesResponse } from './validators/SetVariablesResponse.validator.js';
import { validateSignCertificateRequest, fitSignCertificateRequest } from './validators/SignCertificateRequest.validator.js';
import { validateSignCertificateResponse, fitSignCertificateResponse } from './validators/SignCertificateResponse.validator.js';
import { validateStatusNotificationRequest, fitStatusNotificationRequest } from './validators/StatusNotificationRequest.validator.js';
import { validateStatusNotificationResponse, fitStatusNotificationResponse } from './validators/StatusNotificationResponse.validator.js';
import { validateTransactionEventRequest, fitTransactionEventRequest } from './validators/TransactionEventRequest.validator.js';
import { validateTransactionEventResponse, fitTransactionEventResponse } from './validators/TransactionEventResponse.validator.js';
import { validateTriggerMessageRequest, fitTriggerMessageRequest } from './validators/TriggerMessageRequest.validator.js';
import { validateTriggerMessageResponse, fitTriggerMessageResponse } from './validators/TriggerMessageResponse.validator.js';
import { validateUnlockConnectorRequest, fitUnlockConnectorRequest } from './validators/UnlockConnectorRequest.validator.js';
import { validateUnlockConnectorResponse, fitUnlockConnectorResponse } from './validators/UnlockConnectorResponse.validator.js';
import { validateUnpublishFirmwareRequest, fitUnpublishFirmwareRequest } from './validators/UnpublishFirmwareRequest.validator.js';
import { validateUnpublishFirmwareResponse, fitUnpublishFirmwareResponse } from './validators/UnpublishFirmwareResponse.validator.js';
import { validateUpdateFirmwareRequest, fitUpdateFirmwareRequest } from './validators/UpdateFirmwareRequest.validator.js';
import { validateUpdateFirmwareResponse, fitUpdateFirmwareResponse } from './validators/UpdateFirmwareResponse.validator.js';

export const ActionRegistry = {
  Authorize: {
    validateRequest: validateAuthorizeRequest,
    validateResponse: validateAuthorizeResponse,
    fitRequest: fitAuthorizeRequest,
    fitResponse: fitAuthorizeResponse,
  },
  BootNotification: {
    validateRequest: validateBootNotificationRequest,
    validateResponse: validateBootNotificationResponse,
    fitRequest: fitBootNotificationRequest,
    fitResponse: fitBootNotificationResponse,
  },
  CancelReservation: {
    validateRequest: validateCancelReservationRequest,
    validateResponse: validateCancelReservationResponse,
    fitRequest: fitCancelReservationRequest,
    fitResponse: fitCancelReservationResponse,
  },
  CertificateSigned: {
    validateRequest: validateCertificateSignedRequest,
    validateResponse: validateCertificateSignedResponse,
    fitRequest: fitCertificateSignedRequest,
    fitResponse: fitCertificateSignedResponse,
  },
  ChangeAvailability: {
    validateRequest: validateChangeAvailabilityRequest,
    validateResponse: validateChangeAvailabilityResponse,
    fitRequest: fitChangeAvailabilityRequest,
    fitResponse: fitChangeAvailabilityResponse,
  },
  ClearCache: {
    validateRequest: validateClearCacheRequest,
    validateResponse: validateClearCacheResponse,
    fitRequest: fitClearCacheRequest,
    fitResponse: fitClearCacheResponse,
  },
  ClearChargingProfile: {
    validateRequest: validateClearChargingProfileRequest,
    validateResponse: validateClearChargingProfileResponse,
    fitRequest: fitClearChargingProfileRequest,
    fitResponse: fitClearChargingProfileResponse,
  },
  ClearDisplayMessage: {
    validateRequest: validateClearDisplayMessageRequest,
    validateResponse: validateClearDisplayMessageResponse,
    fitRequest: fitClearDisplayMessageRequest,
    fitResponse: fitClearDisplayMessageResponse,
  },
  ClearedChargingLimit: {
    validateRequest: validateClearedChargingLimitRequest,
    validateResponse: validateClearedChargingLimitResponse,
    fitRequest: fitClearedChargingLimitRequest,
    fitResponse: fitClearedChargingLimitResponse,
  },
  ClearVariableMonitoring: {
    validateRequest: validateClearVariableMonitoringRequest,
    validateResponse: validateClearVariableMonitoringResponse,
    fitRequest: fitClearVariableMonitoringRequest,
    fitResponse: fitClearVariableMonitoringResponse,
  },
  CostUpdated: {
    validateRequest: validateCostUpdatedRequest,
    validateResponse: validateCostUpdatedResponse,
    fitRequest: fitCostUpdatedRequest,
    fitResponse: fitCostUpdatedResponse,
  },
  CustomerInformation: {
    validateRequest: validateCustomerInformationRequest,
    validateResponse: validateCustomerInformationResponse,
    fitRequest: fitCustomerInformationRequest,
    fitResponse: fitCustomerInformationResponse,
  },
  DataTransfer: {
    validateRequest: validateDataTransferRequest,
    validateResponse: validateDataTransferResponse,
    fitRequest: fitDataTransferRequest,
    fitResponse: fitDataTransferResponse,
  },
  DeleteCertificate: {
    validateRequest: validateDeleteCertificateRequest,
    validateResponse: validateDeleteCertificateResponse,
    fitRequest: fitDeleteCertificateRequest,
    fitResponse: fitDeleteCertificateResponse,
  },
  FirmwareStatusNotification: {
    validateRequest: validateFirmwareStatusNotificationRequest,
    validateResponse: validateFirmwareStatusNotificationResponse,
    fitRequest: fitFirmwareStatusNotificationRequest,
    fitResponse: fitFirmwareStatusNotificationResponse,
  },
  Get15118EVCertificate: {
    validateRequest: validateGet15118EVCertificateRequest,
    validateResponse: validateGet15118EVCertificateResponse,
    fitRequest: fitGet15118EVCertificateRequest,
    fitResponse: fitGet15118EVCertificateResponse,
  },
  GetBaseReport: {
    validateRequest: validateGetBaseReportRequest,
    validateResponse: validateGetBaseReportResponse,
    fitRequest: fitGetBaseReportRequest,
    fitResponse: fitGetBaseReportResponse,
  },
  GetCertificateStatus: {
    validateRequest: validateGetCertificateStatusRequest,
    validateResponse: validateGetCertificateStatusResponse,
    fitRequest: fitGetCertificateStatusRequest,
    fitResponse: fitGetCertificateStatusResponse,
  },
  GetChargingProfiles: {
    validateRequest: validateGetChargingProfilesRequest,
    validateResponse: validateGetChargingProfilesResponse,
    fitRequest: fitGetChargingProfilesRequest,
    fitResponse: fitGetChargingProfilesResponse,
  },
  GetCompositeSchedule: {
    validateRequest: validateGetCompositeScheduleRequest,
    validateResponse: validateGetCompositeScheduleResponse,
    fitRequest: fitGetCompositeScheduleRequest,
    fitResponse: fitGetCompositeScheduleResponse,
  },
  GetDisplayMessages: {
    validateRequest: validateGetDisplayMessagesRequest,
    validateResponse: validateGetDisplayMessagesResponse,
    fitRequest: fitGetDisplayMessagesRequest,
    fitResponse: fitGetDisplayMessagesResponse,
  },
  GetInstalledCertificateIds: {
    validateRequest: validateGetInstalledCertificateIdsRequest,
    validateResponse: validateGetInstalledCertificateIdsResponse,
    fitRequest: fitGetInstalledCertificateIdsRequest,
    fitResponse: fitGetInstalledCertificateIdsResponse,
  },
  GetLocalListVersion: {
    validateRequest: validateGetLocalListVersionRequest,
    validateResponse: validateGetLocalListVersionResponse,
    fitRequest: fitGetLocalListVersionRequest,
    fitResponse: fitGetLocalListVersionResponse,
  },
  GetLog: {
    validateRequest: validateGetLogRequest,
    validateResponse: validateGetLogResponse,
    fitRequest: fitGetLogRequest,
    fitResponse: fitGetLogResponse,
  },
  GetMonitoringReport: {
    validateRequest: validateGetMonitoringReportRequest,
    validateResponse: validateGetMonitoringReportResponse,
    fitRequest: fitGetMonitoringReportRequest,
    fitResponse: fitGetMonitoringReportResponse,
  },
  GetReport: {
    validateRequest: validateGetReportRequest,
    validateResponse: validateGetReportResponse,
    fitRequest: fitGetReportRequest,
    fitResponse: fitGetReportResponse,
  },
  GetTransactionStatus: {
    validateRequest: validateGetTransactionStatusRequest,
    validateResponse: validateGetTransactionStatusResponse,
    fitRequest: fitGetTransactionStatusRequest,
    fitResponse: fitGetTransactionStatusResponse,
  },
  GetVariables: {
    validateRequest: validateGetVariablesRequest,
    validateResponse: validateGetVariablesResponse,
    fitRequest: fitGetVariablesRequest,
    fitResponse: fitGetVariablesResponse,
  },
  Heartbeat: {
    validateRequest: validateHeartbeatRequest,
    validateResponse: validateHeartbeatResponse,
    fitRequest: fitHeartbeatRequest,
    fitResponse: fitHeartbeatResponse,
  },
  InstallCertificate: {
    validateRequest: validateInstallCertificateRequest,
    validateResponse: validateInstallCertificateResponse,
    fitRequest: fitInstallCertificateRequest,
    fitResponse: fitInstallCertificateResponse,
  },
  LogStatusNotification: {
    validateRequest: validateLogStatusNotificationRequest,
    validateResponse: validateLogStatusNotificationResponse,
    fitRequest: fitLogStatusNotificationRequest,
    fitResponse: fitLogStatusNotificationResponse,
  },
  MeterValues: {
    validateRequest: validateMeterValuesRequest,
    validateResponse: validateMeterValuesResponse,
    fitRequest: fitMeterValuesRequest,
    fitResponse: fitMeterValuesResponse,
  },
  NotifyChargingLimit: {
    validateRequest: validateNotifyChargingLimitRequest,
    validateResponse: validateNotifyChargingLimitResponse,
    fitRequest: fitNotifyChargingLimitRequest,
    fitResponse: fitNotifyChargingLimitResponse,
  },
  NotifyCustomerInformation: {
    validateRequest: validateNotifyCustomerInformationRequest,
    validateResponse: validateNotifyCustomerInformationResponse,
    fitRequest: fitNotifyCustomerInformationRequest,
    fitResponse: fitNotifyCustomerInformationResponse,
  },
  NotifyDisplayMessages: {
    validateRequest: validateNotifyDisplayMessagesRequest,
    validateResponse: validateNotifyDisplayMessagesResponse,
    fitRequest: fitNotifyDisplayMessagesRequest,
    fitResponse: fitNotifyDisplayMessagesResponse,
  },
  NotifyEVChargingNeeds: {
    validateRequest: validateNotifyEVChargingNeedsRequest,
    validateResponse: validateNotifyEVChargingNeedsResponse,
    fitRequest: fitNotifyEVChargingNeedsRequest,
    fitResponse: fitNotifyEVChargingNeedsResponse,
  },
  NotifyEVChargingSchedule: {
    validateRequest: validateNotifyEVChargingScheduleRequest,
    validateResponse: validateNotifyEVChargingScheduleResponse,
    fitRequest: fitNotifyEVChargingScheduleRequest,
    fitResponse: fitNotifyEVChargingScheduleResponse,
  },
  NotifyEvent: {
    validateRequest: validateNotifyEventRequest,
    validateResponse: validateNotifyEventResponse,
    fitRequest: fitNotifyEventRequest,
    fitResponse: fitNotifyEventResponse,
  },
  NotifyMonitoringReport: {
    validateRequest: validateNotifyMonitoringReportRequest,
    validateResponse: validateNotifyMonitoringReportResponse,
    fitRequest: fitNotifyMonitoringReportRequest,
    fitResponse: fitNotifyMonitoringReportResponse,
  },
  NotifyReport: {
    validateRequest: validateNotifyReportRequest,
    validateResponse: validateNotifyReportResponse,
    fitRequest: fitNotifyReportRequest,
    fitResponse: fitNotifyReportResponse,
  },
  PublishFirmware: {
    validateRequest: validatePublishFirmwareRequest,
    validateResponse: validatePublishFirmwareResponse,
    fitRequest: fitPublishFirmwareRequest,
    fitResponse: fitPublishFirmwareResponse,
  },
  PublishFirmwareStatusNotification: {
    validateRequest: validatePublishFirmwareStatusNotificationRequest,
    validateResponse: validatePublishFirmwareStatusNotificationResponse,
    fitRequest: fitPublishFirmwareStatusNotificationRequest,
    fitResponse: fitPublishFirmwareStatusNotificationResponse,
  },
  ReportChargingProfiles: {
    validateRequest: validateReportChargingProfilesRequest,
    validateResponse: validateReportChargingProfilesResponse,
    fitRequest: fitReportChargingProfilesRequest,
    fitResponse: fitReportChargingProfilesResponse,
  },
  RequestStartTransaction: {
    validateRequest: validateRequestStartTransactionRequest,
    validateResponse: validateRequestStartTransactionResponse,
    fitRequest: fitRequestStartTransactionRequest,
    fitResponse: fitRequestStartTransactionResponse,
  },
  RequestStopTransaction: {
    validateRequest: validateRequestStopTransactionRequest,
    validateResponse: validateRequestStopTransactionResponse,
    fitRequest: fitRequestStopTransactionRequest,
    fitResponse: fitRequestStopTransactionResponse,
  },
  ReservationStatusUpdate: {
    validateRequest: validateReservationStatusUpdateRequest,
    validateResponse: validateReservationStatusUpdateResponse,
    fitRequest: fitReservationStatusUpdateRequest,
    fitResponse: fitReservationStatusUpdateResponse,
  },
  ReserveNow: {
    validateRequest: validateReserveNowRequest,
    validateResponse: validateReserveNowResponse,
    fitRequest: fitReserveNowRequest,
    fitResponse: fitReserveNowResponse,
  },
  Reset: {
    validateRequest: validateResetRequest,
    validateResponse: validateResetResponse,
    fitRequest: fitResetRequest,
    fitResponse: fitResetResponse,
  },
  SecurityEventNotification: {
    validateRequest: validateSecurityEventNotificationRequest,
    validateResponse: validateSecurityEventNotificationResponse,
    fitRequest: fitSecurityEventNotificationRequest,
    fitResponse: fitSecurityEventNotificationResponse,
  },
  SendLocalList: {
    validateRequest: validateSendLocalListRequest,
    validateResponse: validateSendLocalListResponse,
    fitRequest: fitSendLocalListRequest,
    fitResponse: fitSendLocalListResponse,
  },
  SetChargingProfile: {
    validateRequest: validateSetChargingProfileRequest,
    validateResponse: validateSetChargingProfileResponse,
    fitRequest: fitSetChargingProfileRequest,
    fitResponse: fitSetChargingProfileResponse,
  },
  SetDisplayMessage: {
    validateRequest: validateSetDisplayMessageRequest,
    validateResponse: validateSetDisplayMessageResponse,
    fitRequest: fitSetDisplayMessageRequest,
    fitResponse: fitSetDisplayMessageResponse,
  },
  SetMonitoringBase: {
    validateRequest: validateSetMonitoringBaseRequest,
    validateResponse: validateSetMonitoringBaseResponse,
    fitRequest: fitSetMonitoringBaseRequest,
    fitResponse: fitSetMonitoringBaseResponse,
  },
  SetMonitoringLevel: {
    validateRequest: validateSetMonitoringLevelRequest,
    validateResponse: validateSetMonitoringLevelResponse,
    fitRequest: fitSetMonitoringLevelRequest,
    fitResponse: fitSetMonitoringLevelResponse,
  },
  SetNetworkProfile: {
    validateRequest: validateSetNetworkProfileRequest,
    validateResponse: validateSetNetworkProfileResponse,
    fitRequest: fitSetNetworkProfileRequest,
    fitResponse: fitSetNetworkProfileResponse,
  },
  SetVariableMonitoring: {
    validateRequest: validateSetVariableMonitoringRequest,
    validateResponse: validateSetVariableMonitoringResponse,
    fitRequest: fitSetVariableMonitoringRequest,
    fitResponse: fitSetVariableMonitoringResponse,
  },
  SetVariables: {
    validateRequest: validateSetVariablesRequest,
    validateResponse: validateSetVariablesResponse,
    fitRequest: fitSetVariablesRequest,
    fitResponse: fitSetVariablesResponse,
  },
  SignCertificate: {
    validateRequest: validateSignCertificateRequest,
    validateResponse: validateSignCertificateResponse,
    fitRequest: fitSignCertificateRequest,
    fitResponse: fitSignCertificateResponse,
  },
  StatusNotification: {
    validateRequest: validateStatusNotificationRequest,
    validateResponse: validateStatusNotificationResponse,
    fitRequest: fitStatusNotificationRequest,
    fitResponse: fitStatusNotificationResponse,
  },
  TransactionEvent: {
    validateRequest: validateTransactionEventRequest,
    validateResponse: validateTransactionEventResponse,
    fitRequest: fitTransactionEventRequest,
    fitResponse: fitTransactionEventResponse,
  },
  TriggerMessage: {
    validateRequest: validateTriggerMessageRequest,
    validateResponse: validateTriggerMessageResponse,
    fitRequest: fitTriggerMessageRequest,
    fitResponse: fitTriggerMessageResponse,
  },
  UnlockConnector: {
    validateRequest: validateUnlockConnectorRequest,
    validateResponse: validateUnlockConnectorResponse,
    fitRequest: fitUnlockConnectorRequest,
    fitResponse: fitUnlockConnectorResponse,
  },
  UnpublishFirmware: {
    validateRequest: validateUnpublishFirmwareRequest,
    validateResponse: validateUnpublishFirmwareResponse,
    fitRequest: fitUnpublishFirmwareRequest,
    fitResponse: fitUnpublishFirmwareResponse,
  },
  UpdateFirmware: {
    validateRequest: validateUpdateFirmwareRequest,
    validateResponse: validateUpdateFirmwareResponse,
    fitRequest: fitUpdateFirmwareRequest,
    fitResponse: fitUpdateFirmwareResponse,
  },
} as const;

export type ActionName = keyof typeof ActionRegistry;
