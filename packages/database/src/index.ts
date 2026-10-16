// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export * from './schema/index.js';
export { db, client } from './config.js';
export { sessionSiteIdSql } from './lib/session-site.js';
export { toDate, toDateOrNull, toIsoOrNull } from './lib/raw-timestamp.js';
export type { RawTimestamp } from './lib/raw-timestamp.js';
export { PgEventPersistence } from './event-persistence.js';
export {
  pgErrorCode,
  pgConstraintName,
  pgConnectionErrorKind,
  PG_UNIQUE_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
} from './lib/pg-errors.js';
export type { PgConnectionErrorKind } from './lib/pg-errors.js';
export { guardPgConnectionRejections } from './lib/pg-connection-rejections.js';
export type { PgConnectionRejectionLogger } from './lib/pg-connection-rejections.js';
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
  loadElectricityRatePeriodsForSite,
  clearElectricityRateCache,
} from './lib/electricity-rate.js';
export {
  isReservationEnabled,
  getReservationSettings,
  invalidateReservationSettingsCache,
} from './lib/reservation-setting.js';
export type { ReservationSettings } from './lib/reservation-setting.js';
export {
  snapshotReservationFeeTerms,
  resolveReservationFeeTerms,
} from './lib/reservation-fee-terms.js';
export type { ReservationFeeSnapshot, ReservationFeeTerms } from './lib/reservation-fee-terms.js';
export { isSupportEnabled, clearSupportCache } from './lib/support-setting.js';
export { getPlatformFeePercent, clearPlatformFeeCache } from './lib/payment-settings.js';
export { writeReservationAudit, reservationDiffChanged } from './lib/reservation-audit.js';
export { writeCsmsSessionAudit } from './lib/session-csms-audit.js';
export type { CsmsSessionAuditArgs } from './lib/session-csms-audit.js';
export type {
  ReservationAuditAction,
  ReservationAuditActor,
  WriteReservationAuditArgs,
} from './lib/reservation-audit.js';
export {
  writeAudit,
  redactAuditPayload,
  runWithAuditViaAi,
  currentAuditViaAi,
} from './lib/audit.js';
export {
  claimCdrPushRetry,
  createCreditCdr,
  creditCdrData,
  negateOcpiPrice,
  supersedeCreditedSessionCdrs,
} from './lib/ocpi-credit-cdr.js';
export type {
  CreditCdrResult,
  ReissueCdrResult,
  RetryCdrPushResult,
} from './lib/ocpi-credit-cdr.js';
export { ocpiLocationAudience } from './lib/ocpi-location-audience.js';
export { issueOcpiRegistrationToken } from './lib/ocpi-registration-token.js';
export type { OcpiLocationAudience } from './lib/ocpi-location-audience.js';
export { resolveOcpiTokenOwner, publishOcpiSessionPush } from './lib/ocpi-token-owner.js';
export { OCPI_START_CONTEXT_MINUTES, isStartableOcpiToken } from './lib/ocpi-token-startable.js';
export type {
  OcpiCpoAuthMethod,
  OcpiTokenOwner,
  OcpiTokenOwnerResult,
} from './lib/ocpi-token-owner.js';
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
  eventTimeAtMostNow,
  reservationHoldingMinutes,
  priceSession,
  priceSessionAt,
  zeroCostBreakdown,
  faultUnbilledSession,
  storeRunningCost,
  storeFinalCost,
  snapshotSessionTariff,
  openFirstTariffSegment,
  closeSegmentsAt,
  segmentsAt,
  switchTariffSegment,
  repriceSessionForDriver,
} from './lib/session-pricing.js';
export type { SessionPricingRow, TariffPriceSnapshot } from './lib/session-pricing.js';
export {
  applyRegisterReading,
  applySessionEnergyReading,
  registerStateFromRow,
} from './lib/session-energy.js';
export type {
  RegisterReadingKind,
  RegisterReadingResult,
  SessionEnergyUpdate,
  SessionRegisterState,
} from './lib/session-energy.js';
export {
  SESSION_REBILL_LEASE_SECONDS,
  claimSessionRebill,
  releaseSessionRebill,
  priceRebill,
  completeRebilledSession,
} from './lib/session-rebill.js';
export type { RebillPricing, SessionRebillOutcome } from './lib/session-rebill.js';
export {
  loadStationPricing,
  loadStationPricingChain,
  loadGroupPricingAtStation,
  pickFromChain,
  hasPaidTariff,
  sessionGroupHasPaidTariff,
  listPricingGroupsWithoutDefault,
  resolveStationTariff,
  resolveStationPricing,
  resolveGroupTariffs,
  pickTariff,
  isStationChargingFree,
  getPricingHolidays,
  clearTariffResolutionCache,
  resolveDriverPricingSource,
} from './lib/tariff-resolution.js';
export {
  ACCOUNT_BILLING_MIN_VERSION,
  MEMBER_INVOICE_MIN_VERSION,
  resolveAccountBilling,
  loadBillingMemberships,
  pickAccountBilling,
  stampSessionBilling,
  sessionBillingColumns,
  toSessionBilling,
  moveSessionBillingRecipient,
  listMovableFleetSessions,
} from './lib/fleet-billing.js';
export type {
  AccountBilling,
  BillingMembership,
  SessionBilling,
  SessionBillingMove,
  SessionBillingMoveOutcome,
} from './lib/fleet-billing.js';
export {
  DEFAULT_CREDIT_LIMIT_WARNING_PERCENT,
  fleetCreditLevel,
  loadFleetCreditExposure,
  checkFleetCreditLimit,
  readFleetCreditLimit,
  fleetCreditRemaining,
  loadDriverAccountCredit,
  claimFleetCreditLimitNotice,
  loadFleetBillingContacts,
  CEILING_EXTEND_HEADROOM_PERCENT,
  sessionReservationCents,
  ceilingExtensionDue,
  extendedCeilingCents,
  extendFleetSessionCeiling,
  fleetCreditNoticesClaimed,
} from './lib/fleet-credit-limit.js';
export type {
  FleetCreditExposure,
  FleetCreditLevel,
  FleetCreditCheck,
  FleetBillingContacts,
  DriverAccountCredit,
  FleetCreditTransaction,
  FleetCeilingExtension,
  CeilingExtensionInput,
} from './lib/fleet-credit-limit.js';
export {
  FLEET_CREDIT_RESERVATION_KEY,
  DEFAULT_FLEET_CREDIT_RESERVATION_CENTS,
  MAX_FLEET_CREDIT_RESERVATION_CENTS,
  parseFleetCreditReservationCents,
  getFleetCreditReservationCents,
  clearFleetCreditSettingsCache,
} from './lib/fleet-credit-settings.js';
export { invoiceNumberPrefix, allocateInvoiceNumber } from './lib/invoice-number.js';
export type { InvoiceNumberExecutor } from './lib/invoice-number.js';
export { sessionFeeGrossCents, siteMaxSessionFeeGrossCents } from './lib/session-fee-floor.js';
export type {
  PricingGroupSource,
  ResolvedPricingGroup,
  GroupTariff,
  StationTariff,
  StationPricing,
  TariffQuery,
  DriverPricingSource,
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
  stationLevelUnavailableSql,
} from './lib/station-status.js';
export {
  STARTABLE_CONNECTOR_STATUSES,
  stationOpenToDriversSql,
  evseReservedSql,
  evseOpenToDriversSql,
  evseAvailableSql,
  availableEvseCountSql,
} from './lib/driver-availability.js';
export {
  OFFLINE_SWEEP_REASON,
  findStaleOnlineStations,
  markStationOfflineIfStale,
} from './lib/station-offline.js';
export type { StaleOnlineStation, StationMarkedOffline } from './lib/station-offline.js';
export {
  LEGACY_OCPP_HEALTH_ID,
  OCPP_HEALTH_PRUNE_MS,
  OCPP_HEALTH_SNAPSHOT_INTERVAL_MS,
  OCPP_HEALTH_STALE_MS,
  aggregateOcppHealth,
  deleteOcppInstanceHealth,
  getOcppFleetHealth,
  pruneStaleOcppHealth,
  writeOcppInstanceHealth,
} from './lib/ocpp-server-health.js';
export type {
  OcppFleetHealth,
  OcppInstanceHealth,
  OcppInstanceHealthSnapshot,
} from './lib/ocpp-server-health.js';
export {
  STATION_WATCH_JOB_NAME,
  findDueStationWatch,
  alertStationWatchersIfAvailable,
  claimStationWatches,
} from './lib/station-watch.js';
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
export type { AuditActor, AuditViaAi, WriteAuditArgs } from './lib/audit.js';
export {
  FIRMWARE_UPDATE_TERMINAL_STATUSES,
  FIRMWARE_UPDATE_REFUSED_RESPONSES,
  FIRMWARE_STATUS_TO_CAMPAIGN_STATION,
  isTerminalFirmwareUpdateStatus,
  applyFirmwareCampaignStationStatus,
  completeFirmwareCampaignIfDone,
  rejectFirmwareUpdate,
  failCanceledFirmwareCampaignUpdates,
  dropQueuedCampaignFirmwareUpdates,
} from './lib/firmware-updates.js';
export type {
  FirmwareCampaignStationStatus,
  CampaignStationUpdate,
} from './lib/firmware-updates.js';
export {
  dispatchPendingFirmwareCampaigns,
  newFirmwareRequestId,
} from './lib/firmware-campaign-dispatch.js';
export {
  markLoadManagementStale,
  recordLoadManagementProfileReply,
} from './lib/load-management-state.js';
export type { LoadManagementRateUnit } from './lib/load-management-state.js';
export { isFleetEnabled, clearFleetCache } from './lib/fleet-setting.js';
export {
  guardVersion,
  isOlderRelease,
  LEGACY_CLEAN_MS,
  oldProcessCheck,
  parseWatchState,
  PROCESS_VERSION_WATCH_KEY,
  recordProcessWatch,
  releaseUpgradePending,
  WATCH_FRESH_MS,
} from './lib/process-versions.js';
export type {
  OldProcessCheck,
  ProcessWatchState,
  ProcessWatchStore,
  ReleaseUpgradePending,
} from './lib/process-versions.js';
export { isPortalRegistrationEnabled } from './lib/portal-registration-setting.js';
export { touchExpiredDriverTokens } from './lib/driver-token-expiry.js';
export {
  isGuestChargingEnabled,
  clearGuestChargingCache,
  getGuestVelocityLimits,
  clearGuestVelocityCache,
  parseGuestVelocityLimit,
  GUEST_STARTS_PER_IP_PER_HOUR_KEY,
  GUEST_DECLINES_PER_IP_PER_HOUR_KEY,
  DEFAULT_GUEST_STARTS_PER_IP_PER_HOUR,
  DEFAULT_GUEST_DECLINES_PER_IP_PER_HOUR,
  MAX_GUEST_VELOCITY_LIMIT,
} from './lib/guest-setting.js';
export type { GuestVelocityLimits } from './lib/guest-setting.js';
export {
  AUTOCHARGE_ENABLED_KEY,
  clearAutochargeCache,
  findAutochargeVehicle,
  findBlockedVehicle,
  isAutochargeEnabled,
  isAutochargeEnabledForStation,
  isAutochargeOffered,
  type AutochargeVehicleMatch,
} from './lib/autocharge.js';
export {
  COMPANY_PORTAL_URL_KEY,
  clearCompanyPortalUrlCache,
  getCompanyPortalUrl,
} from './lib/portal-url-setting.js';
export { getIdlingGracePeriodMinutes, clearIdlingSettingCache } from './lib/idling-setting.js';
export {
  PREPAID_LOW_CREDIT_THRESHOLD_KEY,
  DEFAULT_PREPAID_LOW_CREDIT_THRESHOLD_CENTS,
  MAX_PREPAID_LOW_CREDIT_THRESHOLD_CENTS,
  parsePrepaidLowCreditThresholdCents,
  getPrepaidLowCreditThresholdCents,
  clearPrepaidSettingsCache,
} from './lib/prepaid-settings.js';
export {
  INVOICE_PAYMENT_TERMS_DAYS_KEY,
  DEFAULT_INVOICE_PAYMENT_TERMS_DAYS,
  MAX_INVOICE_PAYMENT_TERMS_DAYS,
  parseInvoicePaymentTermsDays,
  getInvoicePaymentTermsDays,
  FLEET_INVOICE_RUN_DAY_KEY,
  DEFAULT_FLEET_INVOICE_RUN_DAY,
  MAX_FLEET_INVOICE_RUN_DAY,
  parseFleetInvoiceRunDay,
  getFleetInvoiceRunDay,
  clearInvoiceSettingsCache,
} from './lib/invoice-settings.js';
export {
  getStaleSessionTimeoutHours,
  STALE_CLEANUP_IN_TRANSACTION_STATUSES,
} from './lib/session-settings.js';
export {
  REMOTE_START_TIMEOUT_CHANNEL,
  EV_CONNECTION_TIMEOUT_SETTING,
  DEFAULT_EV_CONNECTION_TIMEOUT_SECONDS,
  REMOTE_START_TIMEOUT_MARGIN_SECONDS,
  EV_CONNECT_TIMEOUT_REASON,
  REMOTE_START_TIMEOUT_REASON,
  REMOTE_START_REJECTED_REASON,
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
  SESSION_END_FAILED_REASON,
  recordSessionEndRequest,
} from './lib/session-end-request.js';
export type { CsmsSessionEndReason, SessionEndRequestMessage } from './lib/session-end-request.js';
export {
  getSystemTimezone,
  getCompanyCurrency,
  getCompanyPriceDisplay,
  getCompanyTaxBasis,
  getCompanyCountry,
  getInvoicePaymentSettings,
  readInvoicePaymentSettings,
  clearSystemSettingsCache,
} from './lib/system-settings.js';
export type { InvoicePaymentSettings } from './lib/system-settings.js';
export {
  getRecaptchaConfig,
  getMfaConfig,
  clearSecuritySettingsCache,
} from './lib/security-settings.js';
export type { RecaptchaConfig, MfaConfig } from './lib/security-settings.js';
export { isSplitBillingEnabled, clearPricingSettingsCache } from './lib/pricing-settings.js';
export {
  buildStationOcppTariff,
  sendSessionTariffChange,
  stationTariffCapabilities,
} from './lib/ocpp-session-tariff.js';
export type {
  StationTariffCapabilities,
  StationTariffQuery,
  TariffChangeOutcome,
} from './lib/ocpp-session-tariff.js';
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
  isIso15118Enabled,
  getDefaultMaxPowerW,
} from './lib/ocpp-settings.js';
export {
  getRegistrationPolicy,
  clearRegistrationPolicyCache,
} from './lib/registration-settings.js';
export { isAutoDisableOnCriticalEnabled } from './lib/auto-disable-setting.js';
export { getSentryConfig } from './lib/sentry-settings.js';
export {
  getAiSettings,
  isChatbotAiEnabled,
  isSupportAiEnabled,
  getOpsAiSettings,
  isOpsAiEnabled,
  getDriverAiSettings,
  isDriverAiEnabled,
  getAiInsightSettings,
  getInsightAiSettings,
  getAiWorkerSettings,
  getAiMcpSettings,
  isAiMcpEnabled,
  isAiInsightsEnabled,
  clearAiSettingsCache,
} from './lib/ai-settings.js';
export { computeInsightScopeCounts, insightSiteScopeCounts } from './lib/insight-scope.js';
export type { InsightScopeInput } from './lib/insight-scope.js';
export {
  AI_USAGE_THRESHOLD_EVENT,
  aiBudgetLevel,
  aiUsageBySiteAndSurface,
  aiUsageMonth,
  aiUsageMonthOf,
  aiUsageOfUser,
  aiUsageTopUsers,
  aiUsageUtcDay,
  checkAiBudgets,
  clearAiUsageCache,
  evaluateAiBudgets,
  getCompanyAiBudgetStatus,
  getSiteMonthlyTokenBudget,
  isAiUsageMonth,
  recordAiUsage,
} from './lib/ai-usage.js';
export type {
  AiBudgetContext,
  AiBudgetNotice,
  CompanyAiBudgetStatus,
  AiBudgetLimits,
  AiBudgetSumKey,
  AiUsageMonth,
  AiUsagePeriod,
  AiUsageRecord,
  AiUsageSums,
} from './lib/ai-usage.js';
export {
  AI_PROVIDER_PROBE_INTERVAL_MS,
  claimAiProviderAlertNotice,
  claimAiProviderProbe,
  clearAiProviderAlert,
  clearAiProviderAlertsCache,
  getActiveAiProviderAlerts,
  recordAiProviderQuotaFailure,
} from './lib/ai-provider-alerts.js';
export type { AiProviderAlert } from './lib/ai-provider-alerts.js';
export { getSsoConfig, clearSsoSettingsCache } from './lib/sso-settings.js';
export type { SsoConfig } from './lib/sso-settings.js';
export { getAttestationConfig, clearAttestationConfigCache } from './lib/attestation-settings.js';
export type { AttestationConfig } from './lib/attestation-settings.js';
export { getMobileAppConfig, clearMobileAppConfigCache } from './lib/mobile-app-settings.js';
export {
  CONFORMANCE_STATION_ID_PREFIX,
  CONFORMANCE_CS_STATION_ID_PREFIX,
  operatorStationSql,
  operatorStationIdSql,
  isOperatorStation,
  inOperatorStation,
  CONFORMANCE_DELETE_BATCH,
  deleteConformanceStations,
  deleteConformanceTestDriver,
  conformanceTestDriverInUse,
} from './lib/conformance-stations.js';
export type {
  ConformanceStationDeleteOptions,
  ConformanceDriverDeleteResult,
} from './lib/conformance-stations.js';
export {
  SITE_INSIGHT_SUPPRESSION_SOURCES,
  STATION_INSIGHT_SUPPRESSION_SOURCES,
  siteInsightsOperatorSuppressedSql,
  siteInsightsSuppressedSql,
  siteInsightSuppressionSourcesSql,
  siteUnderActiveMaintenanceSql,
  stationInsightsOperatorSuppressedSql,
  stationInsightsSuppressedSql,
  stationInsightSuppressionSourcesSql,
  stationSiteInsightsSuppressedSql,
  stationUnderActiveMaintenanceSql,
} from './lib/ai-insight-suppression.js';
export type {
  SiteInsightSuppressionSource,
  StationInsightSuppressionSource,
} from './lib/ai-insight-suppression.js';
