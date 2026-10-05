// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export { createBullMQConnection, logBullMQErrors } from './bullmq.js';

export {
  connectionName,
  CONNECTION_NAME_PREFIX,
  LEGACY_CONNECTION_NAME,
} from './connection-name.js';

export { withLock } from './redis-lock.js';
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

export { formatDateTime, formatDate, formatRelativeTime, isValidTimezone } from './timezone.js';

export { encryptString, decryptString } from './encryption.js';

export {
  assertTemplateAllowed,
  compileAllowedTemplate,
  TemplateNotAllowedError,
  type TemplateRenderer,
} from './template-safety.js';

export { csvEscape, buildCsv, neutraliseSpreadsheetFormula } from './csv-escape.js';

export { verifyRecaptcha } from './recaptcha.js';
export type { RecaptchaResult } from './recaptcha.js';

export { generateTotpSecret, generateTotpUri, verifyTotpCode } from './totp.js';

export { createMfaChallenge, verifyMfaChallenge } from './mfa.js';
export type { CreateChallengeResult } from './mfa.js';

export type { PubSubClient, Subscription } from './pubsub.js';
export {
  publishOcppCommand,
  OCPP_COMMANDS_CHANNEL,
  OCPP_COMMAND_RESULTS_CHANNEL,
} from './ocpp-command-publish.js';
export type { OcppCommand } from './ocpp-command-publish.js';
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
  costIncludesTax,
  costContainsTax,
  sessionCostTax,
  taxOnNet,
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
} from './station-password.js';
export type { StationOcppProtocol, StationPasswordError } from './station-password.js';
export { UI_LANGUAGES, isUiLanguage, toUiLanguage } from './languages.js';
export type { UiLanguage } from './languages.js';
export {
  FIRMWARE_SIGNING_CERTIFICATE_MAX_LENGTH,
  FIRMWARE_SIGNATURE_MAX_LENGTH,
  isBase64,
  isPemCertificate,
  validateFirmwareSignature,
} from './firmware-signature.js';
export type { FirmwareSignatureError } from './firmware-signature.js';
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
  notificationMoney,
  notificationUnitPrice,
  notificationTaxRate,
  formatLocalizedVariables,
} from './notification-values.js';

export {
  tariffRestrictionsSchema,
  derivePriority,
  tariffMatchesNow,
} from './tariff-restrictions.js';
export type { TariffRestrictions } from './tariff-restrictions.js';

export { validateNoOverlap } from './tariff-overlap.js';

export { resolveActiveTariff } from './tariff-resolver.js';
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
  NotificationSettings,
  Recipient,
  RenderedTemplate,
  EmailAttachment,
} from './notification-dispatch.js';

export {
  isPrivateUrl,
  parseAllowedPrivateHosts,
  MAX_ALLOWED_PRIVATE_HOSTS,
} from './url-validation.js';
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
export type { ExpoPushMessage, ExpoPushResult } from './push-send.js';

export { initSentry } from './sentry.js';
export type { SentryConfig } from './sentry.js';

export { calculateCo2AvoidedKg, GASOLINE_CO2_KG_PER_KWH } from './carbon.js';

export { FREE_VEND_OCPP_21_VARIABLES, FREE_VEND_OCPP_16_KEYS } from './free-vend-defaults.js';
export type { ConfigTemplateVariable } from './free-vend-defaults.js';

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
  PERMISSIONS,
  PAGE_PERMISSIONS,
  SETTINGS_PERMISSIONS,
  ADMIN_DEFAULT_PERMISSIONS,
  OPERATOR_DEFAULT_PERMISSIONS,
  VIEWER_DEFAULT_PERMISSIONS,
  PERMISSION_GROUPS,
  hasPermission,
  isSubsetOf,
  hasAnySettingsPermission,
} from './permissions.js';
export type { Permission } from './permissions.js';

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
} from './electricity-rate.js';
export type {
  ElectricityRatePeriod,
  ElectricityRatePeriodRestrictions,
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

export { findTemplateTargetConfiguration } from './config-drift.js';
export type { ReportedConfiguration } from './config-drift.js';

export { storedCostBreakdown, storedSessionCostTax } from './session-tax.js';

export {
  SIMULATOR_CONNECTION_HEADER,
  SIMULATOR_CONNECTION_HEADER_VALUE,
} from './simulator-connection.js';
