// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export * from './schema/index.js';
export { db, client } from './config.js';
export { PgEventPersistence } from './event-persistence.js';
export {
  pgErrorCode,
  pgConstraintName,
  PG_UNIQUE_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
} from './lib/pg-errors.js';
export { isRoamingEnabled, clearRoamingCache } from './lib/roaming-setting.js';
export {
  isPncEnabled,
  getOcspAllowedPrivateHosts,
  clearPncSettingsCache,
  PNC_SETTINGS_CACHE_TTL_MS,
} from './lib/pnc-setting.js';
export {
  getWebhookAllowedPrivateHosts,
  clearWebhookSettingsCache,
  WEBHOOK_ALLOWED_PRIVATE_HOSTS_KEY,
} from './lib/webhook-settings.js';
export { isSiteFreeVendEnabledByStation, clearFreeVendCache } from './lib/free-vend-setting.js';
export {
  getElectricityRatePeriodsForSite,
  clearElectricityRateCache,
} from './lib/electricity-rate.js';
export {
  isReservationEnabled,
  getReservationSettings,
  invalidateReservationSettingsCache,
} from './lib/reservation-setting.js';
export type { ReservationSettings } from './lib/reservation-setting.js';
export { isSupportEnabled } from './lib/support-setting.js';
export { getPlatformFeePercent, clearPlatformFeeCache } from './lib/payment-settings.js';
export { writeReservationAudit, reservationDiffChanged } from './lib/reservation-audit.js';
export type {
  ReservationAuditAction,
  ReservationAuditActor,
  WriteReservationAuditArgs,
} from './lib/reservation-audit.js';
export { writeAudit, redactAuditPayload } from './lib/audit.js';
export { createCreditCdr, creditCdrData, negateOcpiPrice } from './lib/ocpi-credit-cdr.js';
export type { CreditCdrResult } from './lib/ocpi-credit-cdr.js';
export { ocpiLocationAudience } from './lib/ocpi-location-audience.js';
export type { OcpiLocationAudience } from './lib/ocpi-location-audience.js';
export {
  OCPI_REMOVED_EVSE_RETENTION_DAYS,
  recordRemovedOcpiEvses,
  removedOcpiEvses,
  pruneRemovedOcpiEvses,
} from './lib/ocpi-removed-evses.js';
export type { RemovedOcpiEvse, RemovedEvseConnector } from './lib/ocpi-removed-evses.js';
export {
  loadSessionPricing,
  sessionIdleMinutesAt,
  reservationHoldingMinutes,
  priceSession,
  priceSessionAt,
  zeroCostBreakdown,
  faultUnbilledSession,
  storeRunningCost,
  storeFinalCost,
  snapshotSessionTariff,
  closeOpenSegment,
  openSegmentTariffId,
  switchTariffSegment,
} from './lib/session-pricing.js';
export type { SessionPricingRow, TariffPriceSnapshot } from './lib/session-pricing.js';
export {
  loadStationPricing,
  resolveStationTariff,
  resolveGroupTariffs,
  pickTariff,
  isStationChargingFree,
  getPricingHolidays,
  clearTariffResolutionCache,
} from './lib/tariff-resolution.js';
export { sessionFeeGrossCents, siteMaxSessionFeeGrossCents } from './lib/session-fee-floor.js';
export type {
  PricingGroupSource,
  ResolvedPricingGroup,
  GroupTariff,
  StationTariff,
  StationPricing,
  TariffQuery,
} from './lib/tariff-resolution.js';
export {
  recomputeStationAvailability,
  setStationDisabled,
  setStationFirmwareState,
  clearStationFirmwareInstalling,
  setStationReportedStatus,
  startStatusOrderingEpoch,
  applyConnectorStatus,
  applyEvseChargingState,
  stationAvailabilitySql,
  stationStatusReasonSql,
  isStationLevelUnavailable,
} from './lib/station-status.js';
export type {
  StationAvailability,
  StationDisabledReason,
  StationFirmwareState,
  StationStatusReason,
  AvailabilityChange,
  StationReportedStatusChange,
  ConnectorStatusInput,
  ConnectorStatusResult,
  StationLevelState,
} from './lib/station-status.js';
export type { AuditActor, WriteAuditArgs } from './lib/audit.js';
export { isFleetEnabled } from './lib/fleet-setting.js';
export { isPortalRegistrationEnabled } from './lib/portal-registration-setting.js';
export { isGuestChargingEnabled } from './lib/guest-setting.js';
export { getIdlingGracePeriodMinutes } from './lib/idling-setting.js';
export { getStaleSessionTimeoutHours } from './lib/session-settings.js';
export {
  REMOTE_START_TIMEOUT_CHANNEL,
  EV_CONNECTION_TIMEOUT_SETTING,
  DEFAULT_EV_CONNECTION_TIMEOUT_SECONDS,
  REMOTE_START_TIMEOUT_MARGIN_SECONDS,
  EV_CONNECT_TIMEOUT_REASON,
  getEvConnectionTimeoutDefaultSeconds,
  clearEvConnectionTimeoutCache,
  getStationConnectionTimeoutSeconds,
  remoteStartTimeoutDelayMs,
  failUnstartedRemoteSession,
} from './lib/remote-start-timeout.js';
export type {
  RemoteStartTimeoutMessage,
  RemoteStartTimeoutTarget,
  UnstartedSession,
  UnstartedSessionOutcome,
} from './lib/remote-start-timeout.js';
export {
  SESSION_END_REQUEST_CHANNEL,
  CSMS_SESSION_END_REASONS,
  recordSessionEndRequest,
} from './lib/session-end-request.js';
export type { CsmsSessionEndReason, SessionEndRequestMessage } from './lib/session-end-request.js';
export {
  getSystemTimezone,
  getCompanyCurrency,
  getCompanyPriceDisplay,
  getCompanyTaxBasis,
  getCompanyCountry,
  clearSystemSettingsCache,
} from './lib/system-settings.js';
export {
  getRecaptchaConfig,
  getMfaConfig,
  clearSecuritySettingsCache,
} from './lib/security-settings.js';
export type { RecaptchaConfig, MfaConfig } from './lib/security-settings.js';
export { isSplitBillingEnabled, clearPricingSettingsCache } from './lib/pricing-settings.js';
export {
  isStationMessageEnabled,
  getStationMessagePricingFormat,
  getStationMessageRefreshSeconds,
  getStationMessageEventTtlSeconds,
  getStationMessageBrandLine,
  getStationMessageLanguage,
  clearStationMessageSettingsCache,
} from './lib/station-message-settings.js';
export {
  getHeartbeatIntervalSeconds,
  getOfflineCommandTtlHours,
  getMeterValueIntervalSeconds,
  getClockAlignedIntervalSeconds,
  getSampledMeasurands,
  getAlignedMeasurands,
  getTxEndedMeasurands,
} from './lib/ocpp-settings.js';
export {
  getRegistrationPolicy,
  clearRegistrationPolicyCache,
} from './lib/registration-settings.js';
export { isAutoDisableOnCriticalEnabled } from './lib/auto-disable-setting.js';
export { getSentryConfig } from './lib/sentry-settings.js';
export { isChatbotAiEnabled, clearChatbotAiSettingsCache } from './lib/ai-settings.js';
export { isSupportAiEnabled, clearSupportAiSettingsCache } from './lib/support-ai-setting.js';
export { getSsoConfig, clearSsoSettingsCache } from './lib/sso-settings.js';
export type { SsoConfig } from './lib/sso-settings.js';
export { getAttestationConfig, clearAttestationConfigCache } from './lib/attestation-settings.js';
export type { AttestationConfig } from './lib/attestation-settings.js';
export { getMobileAppConfig, clearMobileAppConfigCache } from './lib/mobile-app-settings.js';
