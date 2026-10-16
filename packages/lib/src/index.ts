// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export { createBullMQConnection, logBullMQErrors } from './bullmq.js';

export {
  connectionName,
  CONNECTION_NAME_PREFIX,
  LEGACY_CONNECTION_NAME,
} from './connection-name.js';

export { withLock } from './redis-lock.js';
export { aiArgsHash, canonicalJson } from './canonical-json.js';
export type { WithLockOptions, WithLockResult } from './redis-lock.js';

export { createLogger, logFormatOptions } from './logger.js';
export type { Logger, ServiceLogger } from './logger.js';

export {
  AppError,
  ValidationError,
  NotFoundError,
  AuthError,
  ForbiddenError,
  OcppError,
} from './errors.js';

export { InMemoryEventBus } from './events.js';
export { createInFlightTracker } from './in-flight.js';
export type { InFlightTracker } from './in-flight.js';
export type { DomainEvent, EventHandler, EventPersistence, EventBus } from './events.js';

export { generateId, ID_PREFIXES } from './id.js';
export type { EntityType } from './id.js';

export { container, injectable, inject, singleton, resetContainer } from './container.js';
export type { DependencyContainer } from './container.js';

export {
  DEFAULT_TIMEZONE,
  formatDateTime,
  formatDate,
  formatRelativeTime,
  isValidTimezone,
  zonedMidnight,
} from './timezone.js';

export { encryptString, decryptString, decryptSettingOrNull } from './encryption.js';

export { keyedSubjectHash, authorizationSubjectId } from './insight-subject.js';

export {
  assertTemplateAllowed,
  compileAllowedTemplate,
  TemplateNotAllowedError,
  type AllowedTemplateOptions,
  type TemplateRenderer,
} from './template-safety.js';

export { csvEscape, buildCsv, neutraliseSpreadsheetFormula } from './csv-escape.js';

export { verifyRecaptcha } from './recaptcha.js';
export type { RecaptchaResult } from './recaptcha.js';

export { generateTotpSecret, generateTotpUri, verifyTotpCode, matchTotpStep } from './totp.js';

export { createMfaChallenge, verifyMfaChallenge, MFA_CHALLENGE_MAX_ATTEMPTS } from './mfa.js';
export type { CreateChallengeResult, MfaChallengeResult } from './mfa.js';

export type { PubSubClient, Subscription } from './pubsub.js';
export {
  publishOcppCommand,
  OCPP_COMMANDS_CHANNEL,
  OCPP_COMMAND_RESULTS_CHANNEL,
} from './ocpp-command-publish.js';
export type { OcppCommand } from './ocpp-command-publish.js';
export { buildOcppTariff, ocppTariffConditions } from './ocpp-tariff.js';
export type {
  OcppTariff,
  OcppTariffConditions,
  OcppTariffInput,
  OcppTariffSource,
  OcppTariffStationSupport,
} from './ocpp-tariff.js';
export { awaitPubSubReply } from './pubsub-reply.js';
export type { AwaitReplyOptions } from './pubsub-reply.js';
export { PNC_COMMANDS_CHANNEL, PNC_COMMAND_RESULTS_CHANNEL } from './pnc-commands.js';
export type { PncCommand, PncCommandResult } from './pnc-commands.js';
export { RedisPubSubClient } from './pubsub-redis.js';
export { logRedisErrors } from './redis-errors.js';
export { createRedisClient, redisTlsOptions } from './redis-client.js';

export { RedisConnectionRegistry } from './connection-registry.js';
export type { ConnectionRegistry } from './connection-registry.js';
export {
  LIVENESS_WRITE_INTERVAL_SECONDS,
  MIN_HEARTBEAT_TIMEOUT_MS,
  OFFLINE_SWEEP_SLACK_MS,
  heartbeatTimeoutFor,
  offlineSweepThresholdMs,
  shouldMarkStationOffline,
  isStationLiveForSegmentSwitch,
} from './station-liveness.js';

export {
  DEFAULT_CURRENCY,
  SUPPORTED_CURRENCIES,
  isSupportedCurrency,
  formatCurrencyAmount,
  formatUnitPrice,
  formatUnitPriceWithLabel,
  formatFlatPrice,
  formatTariffSummary,
  centsToMajorInput,
  parseMajorInputToCents,
} from './currency.js';
export type { SupportedCurrency, TariffSummaryLabels, TariffSummaryPrices } from './currency.js';
export { ISO3166_ALPHA2_TO_ALPHA3, toIso3166Alpha3, isKnownCountry } from './country.js';
export {
  PRICE_DISPLAYS,
  DEFAULT_PRICE_DISPLAY,
  isPriceDisplay,
  resolvePriceDisplay,
  TAX_BASES,
  DEFAULT_TAX_BASIS,
  isTaxBasis,
  resolveTaxBasis,
  netUnitPrice,
  grossUnitPrice,
  priceForDisplay,
  unitPriceForDisplay,
  taxRateFraction,
  tariffPriceView,
  formatTaxRatePercent,
  costContainsTax,
  sessionCostTax,
  taxOnNet,
  multiplyCents,
  taxLineFromNet,
  netFromGross,
  splitGrossByTaxRate,
  taxBreakdownByRate,
  taxBreakdownWithGross,
  taxTotals,
  allocateCents,
  reconcileTaxLines,
  revenueFromGrossGroups,
  dimensionTaxCents,
  COST_DIMENSIONS,
  vatPercentFromFraction,
  splitDimensionByTaxLines,
  dimensionAmounts,
  taxLineForAmount,
  taxPerRate,
  chargedCostBreakdown,
  reconcileCostBreakdown,
  capCostBreakdown,
  componentTaxLines,
  parseSessionCostBreakdown,
} from './price-display.js';
export type {
  PriceDisplay,
  TariffPriceView,
  TaxBasis,
  SessionCostTax,
  SessionCostBreakdown,
  CostComponentGroup,
  TaxLine,
  TaxBreakdownLine,
  CostTaxLine,
  CostDimension,
  TaxTotals,
  GrossAmountGroup,
  RatedAmount,
} from './price-display.js';
export {
  STATION_PASSWORD_CHARSET,
  stationPasswordRules,
  validateStationPassword,
  generateStationPassword,
  toAuthorizationKeyHex,
  STATION_PASSWORD_HASH_OPTIONS,
} from './station-password.js';
export {
  CACHE_INVALIDATE_CHANNEL,
  STATION_AUTH_INVALIDATION_KIND,
  stationAuthInvalidationPayload,
  parseStationAuthInvalidation,
  publishStationAuthInvalidation,
  STATION_DISCONNECT_KIND,
  stationDisconnectPayload,
  parseStationDisconnect,
  publishStationDisconnect,
} from './station-auth-invalidation.js';
export type { StationOcppProtocol, StationPasswordError } from './station-password.js';
export {
  PNC16_VENDOR_ID,
  PNC16_MESSAGE_IDS,
  isPnc16MessageId,
  wrapPnc16,
  unwrapPnc16Data,
  unwrapPnc16Answer,
  type Pnc16MessageId,
} from './iso15118-pnc16.js';
export {
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULES,
  passwordRuleResults,
  missingPasswordRules,
} from './password-policy.js';
export type { PasswordRule } from './password-policy.js';
export { UI_LANGUAGES, isUiLanguage, toUiLanguage } from './languages.js';
export type { UiLanguage } from './languages.js';
export {
  REQUIRED_DRIVER_EVENT_TYPES,
  isRequiredDriverEventType,
  OCPP_NOTIFICATION_EVENTS,
  OCPP_NOTIFICATION_EVENT_TYPES,
  ocppNotificationEventsFor,
} from './notification-events.js';
export type { OcppNotificationVersion, OcppNotificationEventType } from './notification-events.js';
export {
  LOAD_ALLOCATION_STRATEGIES,
  PANEL_VOLTAGES,
  LINE_TO_LINE_ONLY_VOLTAGES,
  CONTINUOUS_LOAD_FACTOR,
  isPanelVoltageAllowed,
  circuitConductorPhases,
  computeMaxContinuousKw,
  conductorFactor,
  isCircuitVoltageAllowed,
  effectiveCircuitVoltageV,
  SUB_PANEL_PHASE_CONNECTIONS,
  isSubPanelPhaseConnectionAllowed,
} from './load-allocation.js';
export type { LoadAllocationStrategy, SubPanelPhaseConnection } from './load-allocation.js';
export { OCPI_PULL_MODULES, OCPI_TARIFF_SETTING_KEYS } from './ocpi-modules.js';
export type { OcpiPullModule } from './ocpi-modules.js';
export {
  OCPI_TOKEN_TYPE_BY_DRIVER_TYPE,
  isNewOcpiToken,
  ocpiTokenTypeOf,
} from './ocpi-token-types.js';
export type { OcpiTokenTypeName } from './ocpi-token-types.js';
export {
  FIRMWARE_SIGNING_CERTIFICATE_MAX_LENGTH,
  FIRMWARE_SIGNATURE_MAX_LENGTH,
  isBase64,
  isPemCertificate,
  validateFirmwareSignature,
} from './firmware-signature.js';
export type { FirmwareSignatureError } from './firmware-signature.js';
export {
  FIRMWARE_RETRIES_MAX,
  FIRMWARE_RETRY_INTERVAL_MAX_SECONDS,
  buildCampaignUpdateFirmware,
} from './firmware-campaign.js';
export type { FirmwareCampaignCommandSource } from './firmware-campaign.js';
export { TOTP_VERSION_V1, totpV1, totpV1ForInterval, verifyTotpV1 } from './web-payment-totp.js';
export type { TotpParameters } from './web-payment-totp.js';
export {
  calculateSessionCost,
  calculateSplitSessionCost,
  calculateSessionCostAt,
  toSessionCostBreakdown,
} from './cost-calculator.js';
export type {
  TariffInput,
  CostBreakdown,
  SplitCostBreakdown,
  TariffSegment,
  SessionSegmentInput,
  SessionPricingInput,
} from './cost-calculator.js';

export { isTariffFree } from './payment-helpers.js';

export {
  platformFeeCents,
  incrementalPlatformFeeCents,
  netOfCharge,
  sessionChargeTax,
} from './platform-fee.js';
export type { ChargeTax } from './platform-fee.js';

export {
  LocalizedValue,
  MoneyValue,
  UnitPriceValue,
  TaxRateValue,
  TaxLinesValue,
  notificationMoney,
  notificationUnitPrice,
  notificationTaxRate,
  formatLocalizedVariables,
} from './notification-values.js';
export {
  receiptBilling,
  receiptCapturedCents,
  sessionReceiptVariables,
} from './session-receipt.js';
export type { SessionReceiptInput } from './session-receipt.js';

export {
  tariffRestrictionsSchema,
  derivePriority,
  tariffMatchesNow,
} from './tariff-restrictions.js';
export type { TariffRestrictions } from './tariff-restrictions.js';

export { validateNoOverlap } from './tariff-overlap.js';
export { checkGroupDefault, isUnrestrictedTariff } from './tariff-default.js';
export type { GroupDefaultTariff, GroupDefaultCheck } from './tariff-default.js';

export { resolveActiveTariff, compareTariffs } from './tariff-resolver.js';
export type { TariffWithRestrictions } from './tariff-resolver.js';

export {
  DEFAULT_EMAIL_WRAPPER,
  wrapEmailHtml,
  getNotificationSettings,
  getCompanySettings,
  getSystemTimezoneCached,
  resolveRecipients,
  loadTemplateFile,
  loadSubjectTemplate,
  loadDbTemplate,
  compileTemplate,
  renderTemplate,
  sendEmail,
  sendSms,
  sendWebhook,
  normalizeE164,
  logNotification,
  dispatchDriverNotification,
  dispatchSystemNotification,
  clearNotificationSettingsCache,
  recordNotificationAttempt,
  DATE_VARIABLE_NAMES,
  formatDateVariables,
  redactSensitiveNotificationContent,
} from './notification-dispatch.js';
export type {
  SmtpConfig,
  TwilioConfig,
  SmsSendContext,
  NotificationSettings,
  Recipient,
  RenderedTemplate,
  EmailAttachment,
  DriverNotificationOptions,
  NotificationDelivery,
  NotificationDispatchResult,
} from './notification-dispatch.js';

export {
  isPrivateUrl,
  parseAllowedPrivateHosts,
  MAX_ALLOWED_PRIVATE_HOSTS,
  validateAiBaseUrl,
} from './url-validation.js';
export {
  AI_PROVIDER_IDS,
  AI_EFFORTS,
  DEFAULT_AI_EFFORT,
  DEFAULT_OPS_AI_EFFORT,
  DEFAULT_DRIVER_AI_EFFORT,
  AI_SUPPORT_TONES,
  DEFAULT_AI_SUPPORT_TONE,
  AI_SURFACE_PREFIXES,
  AI_LIMIT_SETTINGS,
  AI_THRESHOLD_SETTINGS,
  AI_DRIVER_NUMBER_SETTINGS,
  AI_NUMBER_SETTINGS,
  AI_FLAG_SETTINGS,
  AI_SETTING_DEFAULTS,
  AI_SETTING_KEY_PREFIXES,
  AI_MCP_MAX_ALLOWED_ORIGINS,
  isAiFlagSettingKey,
  isAiNumberSettingKey,
  parseAiMcpAllowedOrigins,
  REMOVED_AI_SETTING_KEYS,
  isAiProviderId,
  isAiEffort,
  isAiSupportTone,
  isAiSettingKey,
  isAiBaseUrlSettingKey,
  isAiLimitSettingKey,
  parseAiLimitValue,
  aiProviderApiKeySettingKey,
  aiProviderBaseUrlSettingKey,
  normalizeAiSettingValue,
  buildAiSettings,
} from './ai-config.js';
export type {
  AiProviderId,
  AiEffort,
  AiSupportTone,
  AiSurface,
  AiLimitSettingKey,
  AiThresholdSettingKey,
  AiDriverNumberSettingKey,
  AiNumberSettingKey,
  AiSettings,
  AiSurfaceSettings,
  AiSupportSurfaceSettings,
  AiDriverSurfaceSettings,
  AiProviderSettings,
  AiLimits,
  AiFlagSettingKey,
  AiInsightSettings,
  AiWorkerSettings,
  AiMcpSettings,
} from './ai-config.js';
export {
  safeFetch,
  isNonPublicAddress,
  isUnroutableAddress,
  BlockedDestinationError,
  blockedDestinationOf,
  createGuardedLookup,
  createGuardedAgent,
} from './safe-fetch.js';
export type { GuardOptions, SafeFetchInit, SafeFetchResponse } from './safe-fetch.js';

export { sendExpoPush, isExpoPushToken } from './push-send.js';
export type { ExpoPushMessage, ExpoPushResult, PushSendContext } from './push-send.js';
export {
  resolveNotificationTestSinkUrl,
  getNotificationTestSinkUrl,
  clearNotificationTestSinkCache,
  postToNotificationTestSink,
} from './notification-test-sink.js';
export type {
  NotificationTestSinkEnv,
  NotificationTestSinkMessage,
} from './notification-test-sink.js';

export { initSentry } from './sentry.js';
export type { SentryConfig } from './sentry.js';

export { calculateCo2AvoidedKg, GASOLINE_CO2_KG_PER_KWH } from './carbon.js';

export {
  FREE_VEND_OCPP_21_VARIABLES,
  FREE_VEND_OCPP_16_KEYS,
  FREE_VEND_RESTORE_TX_START_POINT,
  FREE_VEND_RESTORE_OCPP_16_DEFAULTS,
  freeVendRestoreVariables21,
  freeVendRestoreKeys16,
} from './free-vend-defaults.js';
export type { ConfigTemplateVariable, FreeVendRestoreKey16 } from './free-vend-defaults.js';

export {
  renderStationMessage,
  clearStationMessageCache,
  buildStationPriceContext,
  stationTaxNoteContext,
  formatStationIdleFeeRate,
  formatStationTime,
  formatStationElapsed,
  formatStationQuantity,
} from './station-message.js';
export type {
  StationMessageState,
  StationMessageContext,
  StationPriceContext,
} from './station-message.js';

export {
  STATION_MESSAGE_DEFAULTS,
  STATION_MESSAGE_LANGUAGES,
  DEFAULT_STATION_MESSAGE_LANGUAGE,
  isStationMessageLanguage,
  STATION_PRICE_SUMMARY_LABELS,
  STATION_PER_MINUTE_LABELS,
} from './station-message-defaults.js';
export type { StationMessageLanguage } from './station-message-defaults.js';
export { dispatchOneShotStationMessage, clearStationMessage } from './station-message-dispatch.js';
export type {
  OneShotStationMessageOptions,
  ClearStationMessageOptions,
} from './station-message-dispatch.js';

export {
  PermissionCatalog,
  createPermissionCatalog,
  permissionCatalog,
  AI_MCP_USE_PERMISSION,
  hasPermission,
  isSubsetOf,
  hasAnySettingsPermission,
} from './permissions.js';
export type {
  Permission,
  PermissionAction,
  PermissionGroup,
  PermissionGroupDefinition,
  PermissionKind,
} from './permissions.js';

export {
  renderMaintenanceMessage,
  DEFAULT_MAINTENANCE_MESSAGE_TEMPLATE,
} from './maintenance-message.js';
export type { MaintenanceMessageVars } from './maintenance-message.js';

export {
  CSS_CONNECTOR_TYPES,
  mapConnectorTypeToCss,
  mapCssToOcppConnectorType,
  randomCssConnectorType,
} from './css-connector-types.js';
export type { CssConnectorType } from './css-connector-types.js';

export {
  buildCssConfigDefaults,
  CSS_RECONNECT_SPREAD_S,
  CSS_RETRY_BACK_OFF_DEFAULTS,
  CSS_STATUS_REPORTING_KEY,
  CSS_STATUS_REPORTING_VALUES,
  CSS_STATUS_REPORTING_DEFAULT,
  cssSecurityCtrlrDefaults,
} from './css-config-defaults.js';
export type {
  CssConfigDefaultsInput,
  CssConfigDefaultsEvse,
  CssConfigDefault,
  CssStatusReporting,
} from './css-config-defaults.js';

export {
  resolveElectricityRate,
  calculateElectricityCostCents,
  deriveElectricityRatePriority,
  electricityRateRestrictionsSchema,
  computeSessionElectricityCost,
} from './electricity-rate.js';
export type {
  ElectricityRatePeriod,
  ElectricityRatePeriodRestrictions,
  SessionElectricityCost,
  SessionElectricityCostSkipReason,
} from './electricity-rate.js';
export {
  MOBILE_APP_URL_SCHEMES_KEY,
  MOBILE_APP_ANDROID_PACKAGES_KEY,
  isAppUrlScheme,
  isAndroidPackageName,
  isMobileAppSettingKey,
  parseMobileAppList,
} from './mobile-app.js';
export type { MobileAppConfig } from './mobile-app.js';

export {
  findTemplateTargetConfiguration,
  configTemplateTarget,
  configTemplateMatchesStation,
} from './config-drift.js';
export type { ReportedConfiguration, ConfigTemplateTarget } from './config-drift.js';

export { storedCostBreakdown, storedSessionCostTax } from './session-tax.js';

export {
  SIMULATOR_CONNECTION_HEADER,
  SIMULATOR_CONNECTION_HEADER_VALUE,
} from './simulator-connection.js';

export { OCTT_TEST_DRIVER_EMAIL } from './octt-test-driver.js';

export { tryParseJson } from './safe-json.js';

export { reservationHoldingMinutes } from './reservation-holding.js';

export {
  centsFromMajorUnits,
  chargeSplit,
  priceEnergyCents,
  dimensionGrossCents,
  priceFee,
  priceSessionCost,
  priceTimedFee,
  pricedSessionFromBreakdown,
  sessionCostDimensions,
  sessionCostDimensionsByCharging,
} from './pricing-engine.js';
export type {
  ComponentTime,
  PricedAmount,
  PricedSegment,
  PricedSession,
  SessionCostInput,
} from './pricing-engine.js';
export { CostInputError } from './cost-calculator.js';
export {
  PDF_LOGO_KEY,
  PDF_FOOTER_KEY,
  DEFAULT_PDF_FOOTER,
  MAX_PDF_LOGO_BYTES,
  MAX_PDF_FOOTER_LENGTH,
  MAX_PDF_FOOTER_LINES,
  DEFAULT_PDF_LOGO_SVG,
  normalizePdfFooter,
  defaultPdfLogoDataUri,
} from './pdf-branding.js';
export { sanitizeSvg, decodePdfLogo, normalizePdfLogo } from './pdf-logo.js';
export {
  COMPANY_TAX_ID_KEY,
  COMPANY_TAX_ID_LABEL_KEY,
  COMPANY_REGISTRATION_NUMBER_KEY,
  COMPANY_INVOICE_EMAIL_KEY,
  COMPANY_INVOICE_PHONE_KEY,
  INVOICE_SELLER_MAX_LENGTHS,
  INVOICE_SELLER_SETTING_KEYS,
  isInvoiceSellerSettingKey,
  normalizeInvoiceSellerSetting,
} from './invoice-seller.js';
export type { InvoiceSellerSettingKey } from './invoice-seller.js';
export {
  COMPANY_BANK_ACCOUNT_HOLDER_KEY,
  COMPANY_IBAN_KEY,
  COMPANY_BIC_KEY,
  COMPANY_BANK_NAME_KEY,
  INVOICE_EPC_QR_ENABLED_KEY,
  INVOICE_PAYMENT_MAX_LENGTHS,
  INVOICE_PAYMENT_SETTING_KEYS,
  isInvoicePaymentSettingKey,
  normalizeInvoicePaymentSetting,
  normalizeIban,
  normalizeBic,
  formatIban,
} from './invoice-payment.js';
export type { InvoicePaymentSettingKey } from './invoice-payment.js';
export {
  EPC_MAX_NAME_LENGTH,
  EPC_MAX_REMITTANCE_LENGTH,
  EPC_MAX_AMOUNT_CENTS,
  EPC_MAX_PAYLOAD_BYTES,
  buildEpcQrPayload,
} from './epc-qr.js';
export type { EpcQrInput } from './epc-qr.js';
export type { DecodedPdfLogo } from './pdf-logo.js';
export {
  CLEARABLE_PROFILE_PURPOSES,
  UNCLEARABLE_PROFILE_PURPOSES,
  chargingProfileClearCriteria,
  chargingProfileClearFilter,
} from './charging-profile-clear.js';
export type {
  ChargingProfileClearCriteria,
  ChargingProfileClearFilter,
} from './charging-profile-clear.js';
