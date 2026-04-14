// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export { createBullMQConnection } from './bullmq.js';

export { createLogger } from './logger.js';
export type { Logger } from './logger.js';

export {
  AppError,
  ValidationError,
  NotFoundError,
  AuthError,
  ForbiddenError,
  OcppError,
} from './errors.js';

export { InMemoryEventBus } from './events.js';
export type { DomainEvent, EventHandler, EventPersistence, EventBus } from './events.js';

export { generateId, ID_PREFIXES } from './id.js';
export type { EntityType } from './id.js';

export { container, injectable, inject, singleton, resetContainer } from './container.js';
export type { DependencyContainer } from './container.js';

export { formatDateTime, formatDate, formatRelativeTime, isValidTimezone } from './timezone.js';

export { encryptString, decryptString } from './encryption.js';

export { verifyRecaptcha } from './recaptcha.js';
export type { RecaptchaResult } from './recaptcha.js';

export { generateTotpSecret, generateTotpUri, verifyTotpCode } from './totp.js';

export { createMfaChallenge, verifyMfaChallenge } from './mfa.js';
export type { CreateChallengeResult } from './mfa.js';

export type { PubSubClient, Subscription } from './pubsub.js';
export { RedisPubSubClient } from './pubsub-redis.js';

export { RedisConnectionRegistry } from './connection-registry.js';
export type { ConnectionRegistry } from './connection-registry.js';

export { calculateSessionCost, calculateSplitSessionCost } from './cost-calculator.js';
export type { TariffInput, CostBreakdown, TariffSegment } from './cost-calculator.js';

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
  formatPricingDisplay,
  currencySymbol,
  getCurrencySymbols,
  setCurrencySymbols,
} from './pricing-display.js';

export {
  DEFAULT_EMAIL_WRAPPER,
  wrapEmailHtml,
  getNotificationSettings,
  resolveRecipients,
  loadTemplateFile,
  loadDbTemplate,
  compileTemplate,
  renderTemplate,
  sendEmail,
  sendSms,
  sendWebhook,
  logNotification,
  dispatchDriverNotification,
  dispatchSystemNotification,
  DATE_VARIABLE_NAMES,
  formatDateVariables,
} from './notification-dispatch.js';
export type {
  SmtpConfig,
  TwilioConfig,
  NotificationSettings,
  Recipient,
  RenderedTemplate,
  EmailAttachment,
} from './notification-dispatch.js';

export { isPrivateUrl } from './url-validation.js';

export { initSentry } from './sentry.js';
export type { SentryConfig } from './sentry.js';

export { calculateCo2AvoidedKg, GASOLINE_CO2_KG_PER_KWH } from './carbon.js';

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
