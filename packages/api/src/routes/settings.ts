// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, like, or, inArray } from 'drizzle-orm';
import {
  db,
  getReservationSettings,
  isReservationEnabled,
  isSupportEnabled,
  isRoamingEnabled,
  isPncEnabled,
  isFleetEnabled,
  isGuestChargingEnabled,
  isChatbotAiEnabled,
  clearRoamingCache,
  clearSupportCache,
  clearFleetCache,
  clearGuestChargingCache,
  clearAiSettingsCache,
  clearPncSettingsCache,
  writeAudit,
  settingAuditLog,
} from '@evtivity/database';
import {
  settings,
  getCompanyCurrency,
  getCompanyPriceDisplay,
  getCompanyTaxBasis,
  clearSystemSettingsCache,
  clearStationMessageSettingsCache,
  invalidateReservationSettingsCache,
  clearMobileAppConfigCache,
  clearWebhookSettingsCache,
  WEBHOOK_ALLOWED_PRIVATE_HOSTS_KEY,
  PREPAID_LOW_CREDIT_THRESHOLD_KEY,
  MAX_PREPAID_LOW_CREDIT_THRESHOLD_CENTS,
  parsePrepaidLowCreditThresholdCents,
  clearPrepaidSettingsCache,
  INVOICE_PAYMENT_TERMS_DAYS_KEY,
  MAX_INVOICE_PAYMENT_TERMS_DAYS,
  parseInvoicePaymentTermsDays,
  FLEET_INVOICE_RUN_DAY_KEY,
  MAX_FLEET_INVOICE_RUN_DAY,
  parseFleetInvoiceRunDay,
  clearInvoiceSettingsCache,
  FLEET_CREDIT_RESERVATION_KEY,
  MAX_FLEET_CREDIT_RESERVATION_CENTS,
  parseFleetCreditReservationCents,
  clearFleetCreditSettingsCache,
} from '@evtivity/database';
import { clearPaymentCaches, isPaymentSettingKey } from '../lib/payments.js';
import {
  assertPaymentProviderWritable,
  replyIfProviderUpgradePending,
} from '../lib/provider-switch.js';
import {
  encryptString,
  clearNotificationSettingsCache,
  isSupportedCurrency,
  SUPPORTED_CURRENCIES,
  isPriceDisplay,
  PRICE_DISPLAYS,
  isStationMessageLanguage,
  STATION_MESSAGE_LANGUAGES,
  isTaxBasis,
  TAX_BASES,
  UI_LANGUAGES,
  isMobileAppSettingKey,
  parseMobileAppList,
  MOBILE_APP_URL_SCHEMES_KEY,
  MOBILE_APP_ANDROID_PACKAGES_KEY,
  parseAllowedPrivateHosts,
  MAX_ALLOWED_PRIVATE_HOSTS,
  validateAiBaseUrl,
  isAiBaseUrlSettingKey,
  isAiSettingKey,
  isAiLimitSettingKey,
  normalizeAiSettingValue,
  AI_LIMIT_SETTINGS,
  AI_PROVIDER_IDS,
  AI_EFFORTS,
  AI_SUPPORT_TONES,
  REMOVED_AI_SETTING_KEYS,
  createLogger,
  PDF_LOGO_KEY,
  PDF_FOOTER_KEY,
  MAX_PDF_LOGO_BYTES,
  MAX_PDF_FOOTER_LENGTH,
  MAX_PDF_FOOTER_LINES,
  normalizePdfLogo,
  normalizePdfFooter,
  INVOICE_SELLER_MAX_LENGTHS,
  COMPANY_INVOICE_EMAIL_KEY,
  isInvoiceSellerSettingKey,
  normalizeInvoiceSellerSetting,
} from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { requestStationMessageRepush } from '@evtivity/services/station-message.service';

/** The SVG drawn in the center of station QR codes. */
const QR_CODE_ICON_KEY = 'qr_code_icon';

const NOTIFICATION_SETTINGS_KEY_PREFIXES = ['smtp.', 'twilio.', 'email.', 'company.'];
const NOTIFICATION_SETTINGS_EXACT_KEYS = new Set(['system.timezone']);

function affectsNotificationSettings(key: string): boolean {
  if (NOTIFICATION_SETTINGS_EXACT_KEYS.has(key)) return true;
  return NOTIFICATION_SETTINGS_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

const logger = createLogger('settings');

async function invalidateNotificationSettings(): Promise<void> {
  clearNotificationSettingsCache();
  try {
    await getPubSub().publish(
      'cache_invalidate',
      JSON.stringify({ kind: 'notification_settings' }),
    );
  } catch (err) {
    logger.warn(
      { err },
      'Notification settings invalidation publish failed, peers refresh within 60s',
    );
  }
}
import { zodSchema } from '../lib/zod-schema.js';
import { successResponse, itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { clearS3ConfigCache } from '../services/s3.service.js';
import { DEFAULT_CONTENT } from './default-content.js';
import { authorize } from '../middleware/rbac.js';
import { isAllSiteUser, requireAllSiteAccess } from '../lib/site-access.js';
import { config as apiConfig } from '../lib/config.js';
import { storedSystemPrompt } from '../services/ai/engine/prompt-defaults.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { decryptForRead, encryptForWrite, isServerManagedSetting } from '../lib/settings-crypto.js';

const settingParams = z.object({
  key: z.string().min(1).describe('Setting key'),
});

const updateSettingBody = z.object({
  value: z.unknown(),
});

const COMPANY_CURRENCY_KEY = 'company.currency';
const COMPANY_PRICE_DISPLAY_KEY = 'company.priceDisplay';
const STATION_MESSAGE_LANGUAGE_KEY = 'stationMessage.language';
const COMPANY_TAX_BASIS_KEY = 'company.taxBasis';

// Keys read through the cached getters in @evtivity/database system-settings.
function isCachedSystemSetting(key: string): boolean {
  return (
    key === COMPANY_CURRENCY_KEY ||
    key === COMPANY_PRICE_DISPLAY_KEY ||
    key === COMPANY_TAX_BASIS_KEY
  );
}

/**
 * Validates and normalizes values for keys with a constrained format. Returns
 * null when the value is invalid.
 */
function normalizeSettingValue(key: string, value: unknown): { value: unknown } | null {
  if (isServerManagedSetting(key) || isDedicatedRouteSetting(key)) return null;
  if (isAiBaseUrlSettingKey(key)) {
    // A mock provider on localhost is allowed in development only.
    const url = validateAiBaseUrl(value, {
      allowPrivateHosts: apiConfig.NODE_ENV === 'development',
    });
    return url != null ? { value: url } : null;
  }
  const ai = normalizeAiSettingValue(key, value);
  if (ai !== undefined) return ai;
  // A saved but unchanged built-in prompt is stored empty, so the surface
  // keeps following the built-in prompt and its later improvements.
  if (typeof value === 'string' && key === 'chatbotAi.systemPrompt') {
    return { value: storedSystemPrompt('chatbot', value) };
  }
  if (typeof value === 'string' && key === 'supportAi.systemPrompt') {
    return { value: storedSystemPrompt('support', value) };
  }
  if (key === COMPANY_PRICE_DISPLAY_KEY) return isPriceDisplay(value) ? { value } : null;
  if (key === STATION_MESSAGE_LANGUAGE_KEY) {
    return isStationMessageLanguage(value) ? { value } : null;
  }
  if (key === COMPANY_TAX_BASIS_KEY) return isTaxBasis(value) ? { value } : null;
  if (isMobileAppSettingKey(key)) {
    const list = parseMobileAppList(key, value);
    return list != null ? { value: list } : null;
  }
  if (key === WEBHOOK_ALLOWED_PRIVATE_HOSTS_KEY) {
    const hosts = parseAllowedPrivateHosts(value);
    return hosts != null ? { value: hosts } : null;
  }
  if (key === PREPAID_LOW_CREDIT_THRESHOLD_KEY) {
    const cents = parsePrepaidLowCreditThresholdCents(value);
    return cents != null ? { value: cents } : null;
  }
  if (key === INVOICE_PAYMENT_TERMS_DAYS_KEY) {
    const days = parseInvoicePaymentTermsDays(value);
    return days != null ? { value: days } : null;
  }
  if (key === FLEET_CREDIT_RESERVATION_KEY) {
    const cents = parseFleetCreditReservationCents(value);
    return cents != null ? { value: cents } : null;
  }
  if (key === FLEET_INVOICE_RUN_DAY_KEY) {
    const day = parseFleetInvoiceRunDay(value);
    return day != null ? { value: day } : null;
  }
  if (key === PDF_LOGO_KEY) {
    // An SVG is stored sanitized: no scripts, no references outside the file.
    const logo = normalizePdfLogo(value);
    return logo != null ? { value: logo } : null;
  }
  if (key === PDF_FOOTER_KEY) {
    const footer = normalizePdfFooter(value);
    return footer != null ? { value: footer } : null;
  }
  if (isInvoiceSellerSettingKey(key)) {
    const seller = normalizeInvoiceSellerSetting(key, value);
    return seller != null ? { value: seller } : null;
  }
  if (key !== COMPANY_CURRENCY_KEY) return { value };
  const code = typeof value === 'string' ? value.trim().toUpperCase() : value;
  return isSupportedCurrency(code) ? { value: code } : null;
}

const invalidCurrencyError = {
  error: `company.currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`,
  code: 'VALIDATION_ERROR',
};

const invalidPriceDisplayError = {
  error: `company.priceDisplay must be one of: ${PRICE_DISPLAYS.join(', ')}`,
  code: 'VALIDATION_ERROR',
};

const invalidStationMessageLanguageError = {
  error: `stationMessage.language must be one of: ${STATION_MESSAGE_LANGUAGES.join(', ')}`,
  code: 'VALIDATION_ERROR',
};

const invalidTaxBasisError = {
  error: `company.taxBasis must be one of: ${TAX_BASES.join(', ')}`,
  code: 'VALIDATION_ERROR',
};

const invalidMobileAppSchemesError = {
  error:
    'mobile.app.urlSchemes must be an array of custom URL schemes (letters, digits, + - .; not http, https or adyencheckout)',
  code: 'VALIDATION_ERROR',
};

const invalidMobileAppPackagesError = {
  error: 'mobile.app.androidPackageNames must be an array of Android application ids',
  code: 'VALIDATION_ERROR',
};

const invalidWebhookAllowedHostsError = {
  error: `${WEBHOOK_ALLOWED_PRIVATE_HOSTS_KEY} must be an array of at most ${String(MAX_ALLOWED_PRIVATE_HOSTS)} hostnames or IP addresses without scheme or port`,
  code: 'VALIDATION_ERROR',
};

const invalidPrepaidLowCreditThresholdError = {
  error: `${PREPAID_LOW_CREDIT_THRESHOLD_KEY} must be a whole number of cents from 0 to ${String(MAX_PREPAID_LOW_CREDIT_THRESHOLD_CENTS)}`,
  code: 'VALIDATION_ERROR',
};

const invalidInvoicePaymentTermsError = {
  error: `${INVOICE_PAYMENT_TERMS_DAYS_KEY} must be a whole number of days from 0 to ${String(MAX_INVOICE_PAYMENT_TERMS_DAYS)}`,
  code: 'VALIDATION_ERROR',
};

const invalidFleetCreditReservationError = {
  error: `${FLEET_CREDIT_RESERVATION_KEY} must be a whole number of cents from 1 to ${String(MAX_FLEET_CREDIT_RESERVATION_CENTS)}`,
  code: 'VALIDATION_ERROR',
};

const invalidPdfLogoError = {
  error: `${PDF_LOGO_KEY} must be an empty string (the default logo) or a PNG or SVG data URI of at most ${String(MAX_PDF_LOGO_BYTES / 1024)} KB`,
  code: 'VALIDATION_ERROR',
};

const invalidPdfFooterError = {
  error: `${PDF_FOOTER_KEY} must be plain text of at most ${String(MAX_PDF_FOOTER_LENGTH)} characters and ${String(MAX_PDF_FOOTER_LINES)} lines`,
  code: 'VALIDATION_ERROR',
};

function invalidInvoiceSellerError(key: keyof typeof INVOICE_SELLER_MAX_LENGTHS): {
  error: string;
  code: string;
} {
  const max = String(INVOICE_SELLER_MAX_LENGTHS[key]);
  const email = key === COMPANY_INVOICE_EMAIL_KEY ? ', empty or an email address' : '';
  return {
    error: `${key} must be one line of text of at most ${max} characters${email}`,
    code: 'VALIDATION_ERROR',
  };
}

const invalidFleetInvoiceRunDayError = {
  error: `${FLEET_INVOICE_RUN_DAY_KEY} must be a whole day of the month from 1 to ${String(MAX_FLEET_INVOICE_RUN_DAY)}`,
  code: 'VALIDATION_ERROR',
};

const serverManagedSettingError = {
  error: 'This setting is managed by the CSMS and cannot be written directly',
  code: 'VALIDATION_ERROR',
};

/**
 * SSO and security settings decide who signs in and how. Only their own routes
 * write and return them (`/v1/sso/settings`, `/v1/security/*`: the
 * settings.security permissions and all-site access), never the generic ones.
 */
function isDedicatedRouteSetting(key: string): boolean {
  return key.startsWith('sso.') || key.startsWith('security.');
}

const dedicatedRouteSettingError = {
  error: 'This setting is written through /v1/sso/settings or /v1/security/*',
  code: 'VALIDATION_ERROR',
};

/**
 * The keys a site-restricted user may read through the generic routes: the
 * general payment settings the CSMS shows it read-only (Settings > Payments,
 * PrepaidSettings and InvoiceSettings). They are company-wide, so writing
 * them, like reading or writing every other key, needs access to every site
 * and answers a restricted user 404 SETTING_NOT_FOUND (owner decisions
 * 2026-10-09 and 2026-10-10, features/site-access-control.md). Never add an `*Enc`,
 * `payments.*`, `company.*`, `smtp.*`, `twilio.*`, `s3.*`, `sso.*` or
 * `security.*` key.
 */
export const SITE_RESTRICTED_SETTING_KEYS: ReadonlySet<string> = new Set([
  PREPAID_LOW_CREDIT_THRESHOLD_KEY,
  INVOICE_PAYMENT_TERMS_DAYS_KEY,
  FLEET_INVOICE_RUN_DAY_KEY,
]);

const settingNotFound = { error: 'Setting not found', code: 'SETTING_NOT_FOUND' } as const;

/** Whether the request may read this key through the generic routes. */
async function mayReadSettingKey(request: FastifyRequest, key: string): Promise<boolean> {
  if (SITE_RESTRICTED_SETTING_KEYS.has(key)) return true;
  const { userId } = request.user as { userId: string };
  return isAllSiteUser(userId);
}

function invalidAiSettingError(key: string): { error: string; code: string } | null {
  if (isAiBaseUrlSettingKey(key)) {
    return {
      error: `${key} must be empty or an https URL without credentials, query or fragment on a public host`,
      code: 'AI_BASE_URL_INVALID',
    };
  }
  const replacement = REMOVED_AI_SETTING_KEYS[key];
  if (replacement !== undefined) {
    return { error: `${key} was removed, use ${replacement}`, code: 'VALIDATION_ERROR' };
  }
  if (isAiLimitSettingKey(key)) {
    const { min, max } = AI_LIMIT_SETTINGS[key];
    return {
      error: `${key} must be a whole number from ${String(min)} to ${String(max)}`,
      code: 'VALIDATION_ERROR',
    };
  }
  const allowed: Record<string, readonly string[]> = {
    'chatbotAi.provider': ['', ...AI_PROVIDER_IDS],
    'supportAi.provider': ['', ...AI_PROVIDER_IDS],
    'chatbotAi.effort': AI_EFFORTS,
    'supportAi.effort': AI_EFFORTS,
    'supportAi.tone': AI_SUPPORT_TONES,
  };
  const values = allowed[key];
  if (values !== undefined) {
    const list = values.map((v) => (v === '' ? '(empty)' : v)).join(', ');
    return { error: `${key} must be one of: ${list}`, code: 'VALIDATION_ERROR' };
  }
  if (key === 'chatbotAi.enabled' || key === 'supportAi.enabled') {
    return { error: `${key} must be true or false`, code: 'VALIDATION_ERROR' };
  }
  return null;
}

function invalidSettingError(key: string): { error: string; code: string } {
  if (isServerManagedSetting(key)) return serverManagedSettingError;
  if (isDedicatedRouteSetting(key)) return dedicatedRouteSettingError;
  const aiError = invalidAiSettingError(key);
  if (aiError != null) return aiError;
  if (key === WEBHOOK_ALLOWED_PRIVATE_HOSTS_KEY) return invalidWebhookAllowedHostsError;
  if (key === PREPAID_LOW_CREDIT_THRESHOLD_KEY) return invalidPrepaidLowCreditThresholdError;
  if (key === INVOICE_PAYMENT_TERMS_DAYS_KEY) return invalidInvoicePaymentTermsError;
  if (key === FLEET_CREDIT_RESERVATION_KEY) return invalidFleetCreditReservationError;
  if (key === FLEET_INVOICE_RUN_DAY_KEY) return invalidFleetInvoiceRunDayError;
  if (key === PDF_LOGO_KEY) return invalidPdfLogoError;
  if (key === PDF_FOOTER_KEY) return invalidPdfFooterError;
  if (isInvoiceSellerSettingKey(key)) return invalidInvoiceSellerError(key);
  if (key === MOBILE_APP_URL_SCHEMES_KEY) return invalidMobileAppSchemesError;
  if (key === MOBILE_APP_ANDROID_PACKAGES_KEY) return invalidMobileAppPackagesError;
  if (key === COMPANY_PRICE_DISPLAY_KEY) return invalidPriceDisplayError;
  if (key === COMPANY_TAX_BASIS_KEY) return invalidTaxBasisError;
  if (key === STATION_MESSAGE_LANGUAGE_KEY) return invalidStationMessageLanguageError;
  return invalidCurrencyError;
}

// Settings that change what station screens show. A changed value re-renders
// them (requestStationMessageRepush); unchanged content is not resent.
const STATION_MESSAGE_RENDER_KEYS = new Set([
  'stationMessage.enabled',
  'stationMessage.pricingFormat',
  'stationMessage.brandLine',
  'stationMessage.language',
  'company.name',
  'company.supportPhone',
  'company.currency',
  'company.priceDisplay',
  'company.taxBasis',
]);

async function repushStationMessagesIfChanged(
  key: string,
  before: unknown,
  after: unknown,
  log: FastifyBaseLogger,
): Promise<void> {
  if (!STATION_MESSAGE_RENDER_KEYS.has(key)) return;
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  await requestStationMessageRepush(log);
}

// Keys read through cached getters in @evtivity/database clear their cache on change.
function clearCachesForKey(key: string): void {
  if (isCachedSystemSetting(key)) clearSystemSettingsCache();
  if (key.startsWith('stationMessage.')) clearStationMessageSettingsCache();
  if (key.startsWith('reservation.')) invalidateReservationSettingsCache();
  if (isPaymentSettingKey(key)) clearPaymentCaches();
  if (isMobileAppSettingKey(key)) clearMobileAppConfigCache();
  if (key === WEBHOOK_ALLOWED_PRIVATE_HOSTS_KEY) clearWebhookSettingsCache();
  if (key === PREPAID_LOW_CREDIT_THRESHOLD_KEY) clearPrepaidSettingsCache();
  if (key === INVOICE_PAYMENT_TERMS_DAYS_KEY || key === FLEET_INVOICE_RUN_DAY_KEY) {
    clearInvoiceSettingsCache();
  }
  if (key === FLEET_CREDIT_RESERVATION_KEY) clearFleetCreditSettingsCache();
  if (key === 'roaming.enabled') clearRoamingCache();
  if (key === 'support.enabled') clearSupportCache();
  if (key === 'fleet.enabled') clearFleetCache();
  if (key === 'guest.enabled') clearGuestChargingCache();
  if (key.startsWith('pnc.')) clearPncSettingsCache();
  if (isAiSettingKey(key)) clearAiSettingsCache();
}

const settingItem = z
  .object({
    key: z.string().max(100).describe('Setting key'),
    value: z.unknown().describe('Setting value (any JSON type)'),
  })
  .passthrough();

const s3StatusResponse = z
  .object({
    configured: z
      .boolean()
      .describe('Whether S3 storage is fully configured (bucket, region, and credentials present)'),
  })
  .passthrough();

export function settingsRoutes(app: FastifyInstance): void {
  // Public endpoint for portal branding (no auth required)
  app.get(
    '/portal/branding',
    {
      schema: {
        tags: ['Settings'],
        summary: 'Get portal branding settings',
        operationId: 'getPortalBranding',
        security: [],
        response: {
          200: itemResponse(
            z
              .record(z.string())
              .describe(
                'Public branding values. Every company.* and marketing.* setting under its key without the prefix (for example name, logo, favicon), currency, priceDisplay, taxBasis, and qrCodeIcon (the SVG drawn in the center of station QR codes, absent when none is set). Values that are not strings are returned as an empty string',
              ),
          ),
        },
      },
    },
    async () => {
      const rows = await db
        .select()
        .from(settings)
        .where(
          or(
            like(settings.key, 'company.%'),
            like(settings.key, 'marketing.%'),
            eq(settings.key, QR_CODE_ICON_KEY),
          ),
        );
      const result: Record<string, string> = {};
      for (const row of rows) {
        // The QR code icon is printed on every station, so it is public.
        const shortKey =
          row.key === QR_CODE_ICON_KEY
            ? 'qrCodeIcon'
            : row.key.replace(/^(company|marketing)\./, '');
        result[shortKey] = typeof row.value === 'string' ? row.value : '';
      }
      // Normalized like the server reads them: an unset or invalid stored
      // value resolves to the default.
      result['currency'] = await getCompanyCurrency();
      result['priceDisplay'] = await getCompanyPriceDisplay();
      // Whether tariff prices are entered excluding ('net') or including
      // ('gross') tax, so clients show a price in the display the driver chose.
      result['taxBasis'] = await getCompanyTaxBasis();
      return result;
    },
  );

  app.get(
    '/portal/features',
    {
      schema: {
        tags: ['Settings'],
        summary: 'Get public feature flags',
        operationId: 'getPortalFeatures',
        security: [],
        response: {
          200: itemResponse(
            z
              .object({
                reservationEnabled: z
                  .boolean()
                  .describe('Whether reservations are enabled in the portal'),
                supportEnabled: z
                  .boolean()
                  .describe('Whether the support case feature is enabled in the portal'),
                roamingEnabled: z
                  .boolean()
                  .describe('Whether OCPI roaming charger search is enabled in the portal'),
                pncEnabled: z
                  .boolean()
                  .describe('Whether Plug and Charge (ISO 15118 contract certificates) is enabled'),
                fleetEnabled: z.boolean().describe('Whether the fleet feature is enabled'),
                guestChargingEnabled: z
                  .boolean()
                  .describe(
                    'Whether guest charging (pay at the station without an account) is enabled',
                  ),
                chatbotAiEnabled: z
                  .boolean()
                  .describe('Whether the AI assistant is enabled for CSMS users'),
                reservationCancellationFeeCents: z
                  .number()
                  .int()
                  .min(0)
                  .describe(
                    "Current cancellation fee setting in cents, in the company tax basis (company.taxBasis: net excludes the tax of the station's tariff, gross includes it). A reservation is charged the fee in effect when it was made: the portal reservation endpoints return that fee, tax included, as cancellationFee",
                  ),
                reservationCancellationWindowMinutes: z
                  .number()
                  .int()
                  .min(0)
                  .describe(
                    'Minutes before reservation start during which cancellation incurs the fee',
                  ),
                reservationMaxHours: z
                  .number()
                  .int()
                  .min(0)
                  .describe('Maximum reservation duration in hours'),
                currency: z
                  .string()
                  .describe(
                    'Company currency (ISO 4217) used to format any monetary value in this response, including the reservation cancellation fee',
                  ),
              })
              .passthrough(),
          ),
        },
      },
    },
    async () => {
      const reservationEnabled = await isReservationEnabled();
      const supportEnabled = await isSupportEnabled();
      const roamingEnabled = await isRoamingEnabled();
      const pncEnabled = await isPncEnabled();
      const fleetEnabled = await isFleetEnabled();
      const guestChargingEnabled = await isGuestChargingEnabled();
      const chatbotAiEnabled = await isChatbotAiEnabled();
      const reservationConfig = await getReservationSettings();
      const currency = await getCompanyCurrency();
      return {
        reservationEnabled,
        supportEnabled,
        roamingEnabled,
        pncEnabled,
        fleetEnabled,
        guestChargingEnabled,
        chatbotAiEnabled,
        reservationCancellationFeeCents: reservationConfig.cancellationFeeCents,
        reservationCancellationWindowMinutes: reservationConfig.cancellationWindowMinutes,
        reservationMaxHours: reservationConfig.maxHours,
        currency,
      };
    },
  );

  const contentParams = z.object({
    type: z.enum(['privacy-policy', 'terms-of-service']).describe('Content type'),
  });
  const contentQuery = z.object({
    lang: z.enum(UI_LANGUAGES).default('en').describe('Language code'),
  });
  const contentItem = z
    .object({ html: z.string().describe('Rendered HTML content for the requested legal document') })
    .passthrough();

  app.get(
    '/portal/content/:type',
    {
      schema: {
        tags: ['Settings'],
        summary: 'Get public legal content',
        operationId: 'getPortalContent',
        security: [],
        params: zodSchema(contentParams),
        querystring: zodSchema(contentQuery),
        response: { 200: itemResponse(contentItem) },
      },
    },
    async (request) => {
      const { type } = request.params as z.infer<typeof contentParams>;
      const { lang } = request.query as z.infer<typeof contentQuery>;
      const settingKey =
        type === 'privacy-policy'
          ? `content.privacyPolicy.${lang}`
          : `content.termsOfService.${lang}`;
      const row = await db.select().from(settings).where(eq(settings.key, settingKey)).limit(1);
      const html = (row[0]?.value as string | undefined) ?? DEFAULT_CONTENT[lang][type];
      return { html };
    },
  );

  app.get(
    '/settings',
    {
      onRequest: [authorize('settings.system:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Get all settings',
        operationId: 'listSettings',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(z.record(z.unknown())) },
      },
    },
    async (request) => {
      const { userId } = request.user as { userId: string };
      const allSites = await isAllSiteUser(userId);
      const rows = await db.select().from(settings);
      const result: Record<string, unknown> = {};
      for (const row of rows) {
        if (isServerManagedSetting(row.key) || isDedicatedRouteSetting(row.key)) continue;
        if (!allSites && !SITE_RESTRICTED_SETTING_KEYS.has(row.key)) continue;
        result[row.key] = decryptForRead(row.key, row.value);
      }
      return result;
    },
  );

  app.get(
    '/settings/:key',
    {
      onRequest: [authorize('settings.system:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Get a setting by key',
        operationId: 'getSetting',
        security: [{ bearerAuth: [] }],
        params: zodSchema(settingParams),
        response: {
          200: itemResponse(settingItem),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { key } = request.params as z.infer<typeof settingParams>;
      const hidden =
        isServerManagedSetting(key) ||
        isDedicatedRouteSetting(key) ||
        !(await mayReadSettingKey(request, key));
      const [row] = hidden ? [] : await db.select().from(settings).where(eq(settings.key, key));
      if (row == null) {
        await reply.status(404).send({ error: 'Setting not found', code: 'SETTING_NOT_FOUND' });
        return;
      }
      return {
        key: row.key,
        value: decryptForRead(row.key, row.value),
      };
    },
  );

  app.patch(
    '/settings/:key',
    {
      onRequest: [authorize('settings.system:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Update a setting by key',
        operationId: 'updateSetting',
        security: [{ bearerAuth: [] }],
        params: zodSchema(settingParams),
        body: zodSchema(updateSettingBody),
        response: {
          200: itemResponse(settingItem),
          400: errorWith('Invalid setting value', [
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.AI_BASE_URL_INVALID,
          ]),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
          409: errorWith('Processes older than v0.1.38 are still connected', [
            ERROR_CODES.PAYMENT_PROVIDER_UPGRADE_PENDING,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { key } = request.params as z.infer<typeof settingParams>;
      if (!(await requireAllSiteAccess(request, reply, settingNotFound))) return;
      const normalized = normalizeSettingValue(
        key,
        (request.body as z.infer<typeof updateSettingBody>).value,
      );
      if (normalized == null) {
        await reply.status(400).send(invalidSettingError(key));
        return;
      }
      try {
        await assertPaymentProviderWritable(key, normalized.value);
      } catch (err) {
        if (await replyIfProviderUpgradePending(reply, err)) return;
        throw err;
      }
      const storedValue = encryptForWrite(key, normalized.value);
      const [before] = await db.select().from(settings).where(eq(settings.key, key));
      const [row] = await db
        .update(settings)
        .set({ value: storedValue, updatedAt: new Date() })
        .where(eq(settings.key, key))
        .returning();
      if (row == null) {
        await reply.status(404).send({ error: 'Setting not found', code: 'SETTING_NOT_FOUND' });
        return;
      }
      const actor = getAuditActor(request);
      await writeAudit(
        { table: settingAuditLog, idColumn: 'setting_key' },
        {
          entityId: row.key,
          entityIdSnapshot: row.key,
          action: 'updated',
          ...actor,
          before,
          after: row,
        },
        db,
        request.log,
      );
      clearCachesForKey(row.key);
      if (affectsNotificationSettings(row.key)) await invalidateNotificationSettings();
      await repushStationMessagesIfChanged(row.key, before?.value, row.value, request.log);
      return { key: row.key, value: decryptForRead(row.key, row.value) };
    },
  );

  app.put(
    '/settings/:key',
    {
      onRequest: [authorize('settings.system:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Create or update a setting by key',
        operationId: 'upsertSetting',
        security: [{ bearerAuth: [] }],
        params: zodSchema(settingParams),
        body: zodSchema(updateSettingBody),
        response: {
          200: itemResponse(settingItem),
          400: errorWith('Invalid setting value', [
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.AI_BASE_URL_INVALID,
          ]),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
          409: errorWith('Processes older than v0.1.38 are still connected', [
            ERROR_CODES.PAYMENT_PROVIDER_UPGRADE_PENDING,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { key } = request.params as z.infer<typeof settingParams>;
      if (!(await requireAllSiteAccess(request, reply, settingNotFound))) return;
      const normalized = normalizeSettingValue(
        key,
        (request.body as z.infer<typeof updateSettingBody>).value,
      );
      if (normalized == null) {
        await reply.status(400).send(invalidSettingError(key));
        return;
      }
      try {
        await assertPaymentProviderWritable(key, normalized.value);
      } catch (err) {
        if (await replyIfProviderUpgradePending(reply, err)) return;
        throw err;
      }
      const storedValue = encryptForWrite(key, normalized.value);
      const [before] = await db.select().from(settings).where(eq(settings.key, key));
      const rows = await db
        .insert(settings)
        .values({ key, value: storedValue })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: storedValue, updatedAt: new Date() },
        })
        .returning();
      const row = rows[0];
      if (row == null) {
        throw new Error('Insert with onConflictDoUpdate returned no rows');
      }
      const actor = getAuditActor(request);
      await writeAudit(
        { table: settingAuditLog, idColumn: 'setting_key' },
        {
          entityId: row.key,
          entityIdSnapshot: row.key,
          action: 'updated',
          ...actor,
          before,
          after: row,
        },
        db,
        request.log,
      );
      clearCachesForKey(row.key);
      if (affectsNotificationSettings(row.key)) await invalidateNotificationSettings();
      await repushStationMessagesIfChanged(row.key, before?.value, row.value, request.log);
      return { key: row.key, value: decryptForRead(row.key, row.value) };
    },
  );

  app.delete(
    '/settings/:key',
    {
      onRequest: [authorize('settings.system:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Delete a setting by key',
        operationId: 'deleteSetting',
        security: [{ bearerAuth: [] }],
        params: zodSchema(settingParams),
        response: {
          200: itemResponse(settingItem),
          400: errorWith('Setting managed by the CSMS', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { key } = request.params as z.infer<typeof settingParams>;
      if (!(await requireAllSiteAccess(request, reply, settingNotFound))) return;
      if (isServerManagedSetting(key) || isDedicatedRouteSetting(key)) {
        const { error } = invalidSettingError(key);
        await reply.status(400).send({ error, code: 'VALIDATION_ERROR' });
        return;
      }
      const [row] = await db.delete(settings).where(eq(settings.key, key)).returning();
      if (row == null) {
        await reply.status(404).send({ error: 'Setting not found', code: 'SETTING_NOT_FOUND' });
        return;
      }
      const actor = getAuditActor(request);
      await writeAudit(
        { table: settingAuditLog, idColumn: 'setting_key' },
        {
          entityId: null,
          entityIdSnapshot: row.key,
          action: 'deleted',
          ...actor,
          before: row,
          after: null,
        },
        db,
        request.log,
      );
      clearCachesForKey(row.key);
      if (affectsNotificationSettings(row.key)) await invalidateNotificationSettings();
      await repushStationMessagesIfChanged(row.key, row.value, undefined, request.log);
      return { key: row.key, value: decryptForRead(row.key, row.value) };
    },
  );

  // S3 storage status (is it configured?)
  app.get(
    '/settings/s3/status',
    {
      onRequest: [authorize('settings.system:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Get S3 storage configuration status',
        operationId: 'getS3Status',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(s3StatusResponse),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, settingNotFound))) return;
      const rows = await db.select().from(settings).where(like(settings.key, 's3.%'));
      const map = new Map<string, unknown>();
      for (const row of rows) map.set(row.key, row.value);
      const bucket = map.get('s3.bucket') as string | undefined;
      const region = map.get('s3.region') as string | undefined;
      const accessKeyIdEnc = map.get('s3.accessKeyIdEnc') as string | undefined;
      const secretAccessKeyEnc = map.get('s3.secretAccessKeyEnc') as string | undefined;
      const configured =
        bucket != null &&
        bucket !== '' &&
        region != null &&
        region !== '' &&
        accessKeyIdEnc != null &&
        accessKeyIdEnc !== '' &&
        secretAccessKeyEnc != null &&
        secretAccessKeyEnc !== '';
      return { configured };
    },
  );

  const s3SettingsBody = z.object({
    bucket: z.string().min(1),
    region: z.string().min(1),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
  });

  // Save S3 storage settings (encrypts credentials)
  app.put(
    '/settings/s3',
    {
      onRequest: [authorize('settings.system:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Save S3 storage settings',
        operationId: 'updateS3Settings',
        security: [{ bearerAuth: [] }],
        body: zodSchema(s3SettingsBody),
        response: {
          200: successResponse,
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
          500: errorWith('Encryption key missing', [ERROR_CODES.ENCRYPTION_KEY_MISSING]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, settingNotFound))) return;
      const body = request.body as z.infer<typeof s3SettingsBody>;
      const encryptionKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
      if (encryptionKey === '') {
        await reply.status(500).send({
          error: 'SETTINGS_ENCRYPTION_KEY not configured on server',
          code: 'ENCRYPTION_KEY_MISSING',
        });
        return;
      }

      const upsert = (key: string, value: unknown) =>
        db
          .insert(settings)
          .values({ key, value })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value, updatedAt: new Date() },
          });

      const written: Array<{ key: string; value: unknown }> = [
        { key: 's3.bucket', value: body.bucket },
        { key: 's3.region', value: body.region },
        { key: 's3.accessKeyIdEnc', value: encryptString(body.accessKeyId, encryptionKey) },
        { key: 's3.secretAccessKeyEnc', value: encryptString(body.secretAccessKey, encryptionKey) },
      ];

      const keysToWrite = written.map((w) => w.key);
      const beforeRows = await db.select().from(settings).where(inArray(settings.key, keysToWrite));
      const beforeMap = new Map<string, unknown>();
      for (const row of beforeRows) beforeMap.set(row.key, row.value);

      await Promise.all(written.map((w) => upsert(w.key, w.value)));
      clearS3ConfigCache();

      const actor = getAuditActor(request);
      await Promise.allSettled(
        written
          .filter(({ key, value }) => beforeMap.get(key) !== value)
          .map(({ key, value }) =>
            writeAudit(
              { table: settingAuditLog, idColumn: 'setting_key' },
              {
                entityId: key,
                entityIdSnapshot: key,
                action: 'updated',
                ...actor,
                before: { key, value: beforeMap.get(key) },
                after: { key, value },
              },
              db,
              request.log,
            ),
          ),
      );

      return { success: true };
    },
  );

  // Test S3 connection by listing objects (max 1)
  app.post(
    '/settings/s3/test',
    {
      onRequest: [authorize('settings.system:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Test S3 connection',
        operationId: 'testS3Connection',
        security: [{ bearerAuth: [] }],
        response: {
          200: successResponse,
          400: errorWith('Bad request', [
            ERROR_CODES.STORAGE_CONNECTION_FAILED,
            ERROR_CODES.STORAGE_NOT_CONFIGURED,
          ]),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, settingNotFound))) return;
      const { getS3Config: getConfig } = await import('../services/s3.service.js');
      const s3 = await getConfig();
      if (s3 == null) {
        await reply
          .status(400)
          .send({ error: 'S3 not configured', code: 'STORAGE_NOT_CONFIGURED' });
        return;
      }

      try {
        const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
        await s3.client.send(new ListObjectsV2Command({ Bucket: s3.bucket, MaxKeys: 1 }));
        return { success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        await reply.status(400).send({ error: message, code: 'STORAGE_CONNECTION_FAILED' });
        return;
      }
    },
  );
}
