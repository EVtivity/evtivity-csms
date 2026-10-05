// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, or, asc, sql } from 'drizzle-orm';
import {
  db,
  client,
  getCompanyCountry,
  getCompanyCurrency,
  getCompanyTaxBasis,
  isStationLevelUnavailable,
  isStationChargingFree,
  resolveStationTariff,
} from '@evtivity/database';
import { isTariffFree, publishOcppCommand, TAX_BASES } from '@evtivity/lib';
import {
  chargingStations,
  connectors,
  evses,
  guestSessions,
  chargingSessions,
  meterValues,
  paymentRecords,
  reservations,
  sites,
} from '@evtivity/database';
import { checkStationOnboarded } from '../../lib/onboarding-gate.js';
import { zodSchema } from '../../lib/zod-schema.js';
import { sessionCurrencySql } from '@evtivity/services/company-currency';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { scheduleGuestStartTimeout } from '../../lib/remote-start-timeout.js';
import { successResponse, itemResponse, errorWith } from '../../lib/response-schemas.js';
import { ERROR_CODES } from '../../lib/error-codes.generated.js';
import { sendOcppCommandAndWait } from '@evtivity/services/ocpp-command';
import { sendStatusCheckError, triggerAndWaitForStatus } from '../../lib/station-status-check.js';
import {
  isStationCheckRateLimited,
  isGuestSessionRateLimited,
  getCachedConnectorStatus,
  setCachedConnectorStatus,
} from '../../lib/rate-limiters.js';
import {
  authorizeGuestHold,
  claimGuestStart,
  continueGuestHold,
  guestHoldTerms,
  rollbackGuestStart,
} from '@evtivity/payments';
import { activePaymentProvider, paymentContext } from '../../lib/payments.js';
import { sessionLimitReached } from '../../lib/session-limit.js';
import { config as apiConfig } from '../../lib/config.js';
import {
  originMismatchError,
  shopperBrowserBody,
  shopperBrowserContext,
} from '../../lib/shopper-browser.js';
import { isEvseInReservationBuffer } from '../../lib/reservation-buffer.js';
import { getActiveMaintenanceForStation } from '@evtivity/services/maintenance.service';
import { validateQrCodeUrl } from '../../services/web-payment.service.js';

const guestPricingInfo = z
  .object({
    currency: z.string().length(3).describe('Company currency (ISO 4217) of every price'),
    pricePerKwh: z.string().nullable().describe('Energy price per kWh in major currency units'),
    pricePerMinute: z
      .string()
      .nullable()
      .describe('Time price per minute while charging in major currency units'),
    pricePerSession: z.string().nullable().describe('Flat session fee in major currency units'),
    idleFeePricePerMinute: z
      .string()
      .nullable()
      .describe('Idle fee per minute (after grace period) in major currency units'),
    taxRate: z.string().nullable().describe('Sales tax rate as a decimal (e.g. 0.0875 = 8.75%)'),
    taxBasis: z
      .enum(TAX_BASES)
      .describe(
        'How the prices above are entered (company setting company.taxBasis): net prices exclude the tax rate, gross prices include it. Convert with the tax rate to show a price the other way.',
      ),
    isFreeVend: z
      .boolean()
      .optional()
      .describe('True when the station&#39;s site has free vend enabled'),
  })
  .passthrough();

const chargerConfigResponse = z
  .object({
    paymentEnabled: z
      .boolean()
      .describe('Whether a payment provider is configured and payment is required'),
    isFree: z.boolean().describe('Whether the station is free to use (no payment required)'),
    publishableKey: z
      .string()
      .max(255)
      .optional()
      .describe('Stripe publishable key for the configured Stripe account'),
    paymentProvider: z
      .object({
        provider: z.string().describe('Provider id the guest checkout loads its payment UI for'),
      })
      .passthrough()
      .nullable()
      .describe(
        'Browser-safe client config of the active payment provider. Null when payments are off.',
      ),
    currency: z.string().length(3).optional().describe('ISO 4217 currency code'),
    countryCode: z
      .string()
      .max(2)
      .nullable()
      .optional()
      .describe(
        'ISO 3166-1 alpha-2 country of the company (company.country), null when unset. Card UIs that need the shopper country (Adyen Web) read it',
      ),
    preAuthAmountCents: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Pre-authorization hold amount in cents'),
    pricing: guestPricingInfo
      .optional()
      .describe('Resolved pricing for this station (null when no tariff is assigned)'),
  })
  .passthrough();

const guestActionSchema = z
  .object({
    provider: z.string().describe('Provider whose client UI handles the action'),
    data: z.unknown().describe('Provider action data (Adyen: the 3D Secure action)'),
  })
  .passthrough()
  .describe(
    'Action for the card UI; post its result to POST /v1/portal/guest/payment-details/{sessionToken}',
  );

const guestStartResponse = z
  .object({
    status: z
      .enum(['started', 'action_required'])
      .describe(
        'started: the hold is authorized and the station accepted the start. action_required: the card needs 3D Secure first',
      ),
    sessionToken: z
      .string()
      .length(20)
      .describe('Opaque session token used to track the guest session lifecycle'),
    action: guestActionSchema.optional().describe('Present when status is action_required'),
  })
  .passthrough();

const guestDetailsBody = z.object({
  details: z
    .unknown()
    .describe(
      'Result of the 3D Secure action. Adyen: the onAdditionalDetails state.data, or { details: { redirectResult } } from the return page',
    ),
});

const limitReachedField = z
  .enum(['cost', 'energy', 'time'])
  .nullable()
  .optional()
  .describe(
    'Transaction limit the station reported reaching (cost: the hold amount, energy, time); it then suspends charging. Null when none',
  );

const guestStatusResponse = z
  .object({
    limitReached: limitReachedField,
    status: z
      .enum(['pending_payment', 'payment_authorized', 'charging', 'completed', 'failed', 'expired'])
      .describe('Guest session lifecycle state'),
    stationOcppId: z.string().max(255).describe('OCPP station identity'),
    evseId: z.number().int().min(1).describe('EVSE ID on the station'),
    isSimulator: z
      .boolean()
      .optional()
      .describe('Whether the station is a simulator (drives portal hints)'),
    energyDeliveredWh: z.coerce
      .number()
      .min(0)
      .nullable()
      .optional()
      .describe('Energy delivered so far in Watt-hours'),
    currentCostCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe('Running cost in cents'),
    finalCostCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe('Final captured cost in cents (set when the session completes)'),
    taxCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe(
        'Tax contained in the cost (finalCostCents, else currentCostCents) in cents, as stored with it. Above 0 when the cost includes tax',
      ),
    currency: z
      .string()
      .length(3)
      .optional()
      .describe('ISO 4217 currency the charging session is billed in, once one is linked'),
    failureReason: z
      .string()
      .max(500)
      .nullable()
      .optional()
      .describe('Failure reason from Stripe or the OCPP layer when status is failed'),
    startedAt: z.coerce.date().nullable().optional().describe('Charging start timestamp'),
    endedAt: z.coerce.date().nullable().optional().describe('Charging end timestamp'),
    idleStartedAt: z.coerce
      .date()
      .nullable()
      .optional()
      .describe('Timestamp the EV stopped drawing power, used to bill idle fees'),
  })
  .passthrough();

const guestPowerHistoryItem = z
  .object({
    timestamp: z.coerce.date().describe('Meter sample timestamp'),
    powerW: z.number().min(0).describe('Active power in Watts'),
  })
  .passthrough();

const guestEnergyHistoryItem = z
  .object({
    timestamp: z.coerce.date().describe('Meter sample timestamp'),
    energyWh: z
      .number()
      .min(0)
      .describe('Cumulative energy delivered in Watt-hours since session start'),
  })
  .passthrough();

const chargerConfigParams = z.object({
  stationId: z.string().min(1).max(255).describe('OCPP station identifier'),
  evseId: z.coerce.number().int().min(1).describe('EVSE ID on the station'),
});

// The optional limits come from the QR code URL parameters maxenergy, maxtime,
// and maxcost (OCPP 2.1 C25.FR.04-06) and are returned to the station as
// transactionLimit when the transaction starts (C25.FR.24).
const guestStartBody = z.object({
  paymentMethodId: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe(
      'Stripe PaymentMethod id of the one-time card (the Stripe form of paymentMethod). Send one of paymentMethodId and paymentMethod, not both',
    ),
  paymentMethod: z
    .object({
      provider: z
        .string()
        .min(1)
        .describe('Provider whose card UI collected the card (charger-config paymentProvider)'),
      payload: z
        .unknown()
        .describe(
          'The one-time card. Stripe: the PaymentMethod id string. Test provider: { testCard }. Adyen: the Card component state.data',
        ),
      browser: shopperBrowserBody
        .optional()
        .describe(
          'The browser the card UI runs in, for a 3D Secure step (required by Adyen). The issuer returns the guest to PORTAL_URL/payments/return?flow=guest&token=<sessionToken>, built by the server',
        ),
    })
    .optional()
    .describe('The one-time card, tagged with the provider that collected it'),
  guestEmail: z.string().email().max(255).optional(),
  maxEnergyWh: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Energy limit in Wh requested by the EV driver (QR code maxenergy)'),
  maxTimeSeconds: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Duration limit in seconds requested by the EV driver (QR code maxtime)'),
  maxCostCents: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Cost limit in cents requested by the EV driver (QR code maxcost). A paid session never exceeds the pre-authorized amount',
    ),
});

const sessionTokenParams = z.object({
  // Generated tokens are 20-char hex (10 random bytes) per the OCPP 1.6
  // idTag maxLength constraint. Pin the validator to that exact format
  // so a malformed token (typo, SQLi attempt, brute-force enumeration)
  // fails fast at parse time without burning a DB lookup.
  sessionToken: z
    .string()
    .regex(/^[0-9a-f]{20}$/, 'sessionToken must be 20 hex characters')
    .describe('Guest session token returned from the start endpoint (20-char hex)'),
});

const qrValidateBody = z.object({
  url: z.string().min(1).max(2048).describe('Full URL the EV driver opened from the QR code'),
});

const qrValidateResponse = z
  .object({
    valid: z
      .boolean()
      .describe('Whether the QR code URL decodes and its one-time password is valid'),
    stationId: z.string().optional().describe('OCPP station identity decoded from the URL'),
    evseId: z.number().int().optional().describe('EVSE decoded from the URL'),
    reason: z
      .enum([
        'malformed_url',
        'missing_parameter',
        'unknown_station',
        'unsupported_version',
        'invalid_totp',
        'unknown_evse',
      ])
      .optional()
      .describe('Why the URL is not valid'),
  })
  .passthrough();

interface GuestStartFailure {
  statusCode: 502 | 504;
  body: { error: string; code: string };
}

/**
 * Sends RequestStartTransaction for a guest session and waits for the
 * station's answer, so an offline station or a dropped command is reported
 * before the guest is sent to the session page. On a timeout or rejection
 * the guest session is deleted and its hold cancelled (the card is not held
 * for a session that never started); the failure reply is returned. An
 * accepted start schedules its close-out (`scheduleGuestStartTimeout`).
 */
async function dispatchGuestStart(
  input: { sessionToken: string; stationOcppId: string; evseId: number; paymentId: string | null },
  log: FastifyBaseLogger,
): Promise<GuestStartFailure | null> {
  const cmdResult = await sendOcppCommandAndWait(input.stationOcppId, 'RequestStartTransaction', {
    evseId: input.evseId,
    remoteStartId: Math.floor(Math.random() * 2_147_483_647),
    // A paid session is an ad hoc payment (OCPP 2.1 C25.FR.23): DirectPayment.
    idToken: {
      idToken: input.sessionToken,
      type: input.paymentId != null ? 'DirectPayment' : 'Central',
    },
  });
  const cmdStatus = cmdResult.response?.['status'] as string | undefined;
  if (cmdResult.error == null && cmdStatus === 'Accepted') {
    // Closes the start if the guest never plugs in (no transaction by the
    // station's connection timeout): the guest session fails, the hold is cancelled.
    await scheduleGuestStartTimeout(input.sessionToken, log);
    return null;
  }

  await rollbackGuestStart(
    { sessionToken: input.sessionToken, paymentId: input.paymentId },
    paymentContext(log),
  );
  if (cmdResult.error != null) {
    return { statusCode: 504, body: { error: 'Station did not respond', code: 'STATION_TIMEOUT' } };
  }
  return {
    statusCode: 502,
    body: { error: `Station rejected start: ${cmdStatus ?? 'Unknown'}`, code: 'STATION_REJECTED' },
  };
}

export function portalGuestRoutes(app: FastifyInstance): void {
  app.post(
    '/portal/guest/qr/validate',
    {
      schema: {
        tags: ['Portal Guest'],
        summary: 'Validate a dynamic QR code URL',
        description:
          'Decodes a scanned dynamic QR code URL (qr/{chargingstationid}/{evse}/{totp}/{version}) and checks its time-based one-time password against the shared secret the CSMS set in the station WebPaymentsCtrlr, accepting the current, previous, and next interval (OCPP 2.1 C25.FR.07-09). The portal continues to payment only for a valid URL (C25.FR.08, C25.FR.20). Rate limited 10/min per IP.',
        operationId: 'portalGuestValidateQrCode',
        security: [],
        body: zodSchema(qrValidateBody),
        response: { 200: itemResponse(qrValidateResponse) },
      },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request) => {
      const { url } = request.body as z.infer<typeof qrValidateBody>;
      const result = await validateQrCodeUrl(url);
      if (!result.valid) {
        request.log.info({ reason: result.reason }, 'QR code URL refused');
      }
      return result;
    },
  );

  const guestCheckStatusParams = z.object({
    stationId: z.string().describe('Station OCPP ID'),
    evseId: z.coerce.number().describe('EVSE ID'),
  });

  app.post(
    '/portal/guest/check-status/:stationId/:evseId',
    {
      schema: {
        tags: ['Portal Guest'],
        summary: 'Check connector status via TriggerMessage (guest)',
        description:
          'Public version of the check-status flow used by the guest charging UI. Dispatches OCPP TriggerMessage(StatusNotification) and waits up to 10s for a fresh status report. Per-station rate limited (5/min) to prevent unauthenticated abuse.',
        operationId: 'guestCheckConnectorStatus',
        security: [],
        params: zodSchema(guestCheckStatusParams),
        response: {
          200: itemResponse(
            z
              .object({
                connectorStatus: z.string().describe('Refreshed connector status'),
              })
              .passthrough(),
          ),
          400: errorWith('Station is offline', [ERROR_CODES.STATION_OFFLINE]),
          404: errorWith('Resource not found', [
            ERROR_CODES.CONNECTOR_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
          429: errorWith('Rate limit exceeded', [ERROR_CODES.RATE_LIMITED]),
          502: errorWith('Station rejected the status check', [ERROR_CODES.STATUS_CHECK_REJECTED]),
          504: errorWith('Station did not report a fresh status in time', [
            ERROR_CODES.STATION_TIMEOUT,
            ERROR_CODES.STATUS_CHECK_TIMEOUT,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { stationId, evseId } = request.params as z.infer<typeof guestCheckStatusParams>;

      const [station] = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          isOnline: chargingStations.isOnline,
          ocppProtocol: chargingStations.ocppProtocol,
        })
        .from(chargingStations)
        .where(eq(chargingStations.stationId, stationId));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      if (!station.isOnline) {
        await sendStatusCheckError(reply, 'STATION_OFFLINE');
        return;
      }

      // Cache lookup before rate-limit charge so concurrent drivers at a busy
      // station share one TriggerMessage round-trip instead of locking each
      // other out at the 5-per-minute station ceiling.
      const cached = getCachedConnectorStatus(stationId, evseId);
      if (cached != null) {
        if (cached.errorCode != null) {
          await sendStatusCheckError(reply, cached.errorCode);
          return;
        }
        return { connectorStatus: cached.status };
      }

      if (isStationCheckRateLimited(stationId)) {
        await reply
          .status(429)
          .send({ error: 'Too many status checks for this station', code: 'RATE_LIMITED' });
        return;
      }

      const connectorRows = await db.execute<{ connector_id: number }>(
        sql`SELECT c.connector_id FROM connectors c
            JOIN evses e ON c.evse_id = e.id
            WHERE e.station_id = ${station.id} AND e.evse_id = ${evseId}
            ORDER BY c.connector_id ASC LIMIT 1`,
      );
      const connectorRow = connectorRows[0];
      if (connectorRow == null) {
        await reply.status(404).send({ error: 'Connector not found', code: 'CONNECTOR_NOT_FOUND' });
        return;
      }
      const connectorId = connectorRow.connector_id;

      const result = await triggerAndWaitForStatus(
        stationId,
        evseId,
        connectorId,
        station.id,
        station.ocppProtocol ?? undefined,
      );

      setCachedConnectorStatus(stationId, evseId, result);
      if (result.errorCode != null) {
        await sendStatusCheckError(reply, result.errorCode);
        return;
      }
      return { connectorStatus: result.status };
    },
  );

  app.get(
    '/portal/guest/charger-config/:stationId/:evseId',
    {
      schema: {
        tags: ['Portal Guest'],
        summary: 'Get charger payment configuration for guest charging',
        operationId: 'portalGuestGetChargerConfig',
        security: [],
        params: zodSchema(chargerConfigParams),
        response: {
          200: itemResponse(chargerConfigResponse),
          404: errorWith('Resource not found', [
            ERROR_CODES.EVSE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const params = request.params as z.infer<typeof chargerConfigParams>;

      const [station] = await db
        .select({
          id: chargingStations.id,
          siteId: chargingStations.siteId,
          isSimulator: chargingStations.isSimulator,
          freeVendEnabled: sites.freeVendEnabled,
        })
        .from(chargingStations)
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(eq(chargingStations.stationId, params.stationId));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Verify EVSE exists
      const [evse] = await db
        .select({ id: evses.id })
        .from(evses)
        .where(and(eq(evses.stationId, station.id), eq(evses.evseId, params.evseId)));

      if (evse == null) {
        await reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
        return;
      }

      // Free-vend overrides any tariff: event-projections skips the payment
      // gate and bills $0 regardless of what tariff is configured. The guest
      // checkout must treat it as free so the UI doesn't ask for a card and
      // the start endpoint doesn't try to pre-auth.
      const tariff = await resolveStationTariff(
        { stationUuid: station.id, driverUuid: null },
        client,
      );
      const isFree = station.freeVendEnabled === true || isTariffFree(tariff);

      // Free-vend overrides whatever tariff is assigned. Return a pricing
      // object with isFreeVend: true so the portal PricingDisplay renders
      // the Free Vend badge instead of the (irrelevant) paid breakdown.
      // When no tariff is assigned at a free-vend site, synthesize a zeroed
      // pricing object so the badge still surfaces.
      const currency = await getCompanyCurrency();
      const taxBasis = await getCompanyTaxBasis();
      const pricing =
        station.freeVendEnabled === true
          ? {
              currency,
              pricePerKwh: null,
              pricePerMinute: null,
              pricePerSession: null,
              idleFeePricePerMinute: null,
              taxRate: null,
              taxBasis,
              isFreeVend: true,
            }
          : tariff != null
            ? {
                currency,
                pricePerKwh: tariff.pricePerKwh,
                pricePerMinute: tariff.pricePerMinute,
                pricePerSession: tariff.pricePerSession,
                idleFeePricePerMinute: tariff.idleFeePricePerMinute,
                taxRate: tariff.taxRate,
                taxBasis,
              }
            : undefined;

      const provider = await activePaymentProvider(request.log);
      if (provider == null) {
        return {
          paymentEnabled: false,
          isFree,
          isSimulator: station.isSimulator,
          paymentProvider: null,
          pricing,
        };
      }
      const [terms, countryCode] = await Promise.all([
        guestHoldTerms(paymentContext(request.log), station.siteId ?? null, params.stationId),
        getCompanyCountry(),
      ]);
      const clientConfig = provider.clientConfig();

      return {
        paymentEnabled: true,
        isFree,
        isSimulator: station.isSimulator,
        // The guest checkout loads the payment UI of paymentProvider.provider.
        // publishableKey stays for portal bundles cached before the descriptor.
        paymentProvider: clientConfig,
        ...(clientConfig.provider === 'stripe' && typeof clientConfig.publishableKey === 'string'
          ? { publishableKey: clientConfig.publishableKey }
          : {}),
        currency,
        countryCode,
        preAuthAmountCents: terms.preAuthAmountCents,
        pricing,
      };
    },
  );

  app.post(
    '/portal/guest/start/:stationId/:evseId',
    {
      schema: {
        tags: ['Portal Guest'],
        summary: 'Start a guest charging session with payment',
        description:
          'Creates a guest_sessions row with a 20-character session token (unique per guest), creates a Stripe PaymentIntent with capture_method=manual for paid sessions (free sessions skip Stripe), and dispatches RequestStartTransaction with the token as the OCPP idToken (type DirectPayment for paid sessions, Central for free ones). An OCPP 2.1 station receives the limits as transactionLimit when the transaction starts: maxCost is the pre-authorized amount (or the lower maxCostCents), maxEnergy and maxTime come from maxEnergyWh and maxTimeSeconds. Rate limited 5/min per IP. Returns 504 if the station does not ack within 35s (cancels the pre-auth and rolls back the row). The one-time card is paymentMethod { provider, payload, browser? } (400 PAYMENT_PROVIDER_NOT_CONFIGURED when provider is not the active one) or, for Stripe, paymentMethodId; both give 400 VALIDATION_ERROR. Answers status started, or status action_required with the 3D Secure action when the card needs it and browser was sent (browser.origin must be the PORTAL_URL origin, else 400 VALIDATION_ERROR): the session then waits in pending_payment and POST /v1/portal/guest/payment-details/{sessionToken} continues it.',
        operationId: 'portalGuestStartCharging',
        security: [],
        params: zodSchema(chargerConfigParams),
        body: zodSchema(guestStartBody),
        response: {
          200: itemResponse(guestStartResponse),
          400: errorWith('Bad request', [
            ERROR_CODES.CONNECTOR_NOT_AVAILABLE,
            ERROR_CODES.EMAIL_REQUIRED,
            ERROR_CODES.PAYMENT_FAILED,
            ERROR_CODES.PAYMENT_METHOD_REQUIRED,
            ERROR_CODES.PAYMENT_NOT_CONFIGURED,
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
            ERROR_CODES.STATION_OFFLINE,
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          403: errorWith('Forbidden', [
            ERROR_CODES.CONNECTOR_RESERVED,
            ERROR_CODES.STATION_OFFLINE,
          ]),
          404: errorWith('Resource not found', [
            ERROR_CODES.EVSE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
          409: errorWith('Conflict', [
            ERROR_CODES.EVSE_IN_USE,
            ERROR_CODES.RESERVATION_BUFFER_ACTIVE,
            ERROR_CODES.MAINTENANCE_ACTIVE,
            ERROR_CODES.STATION_UNAVAILABLE,
          ]),
          502: errorWith('Station rejected', [ERROR_CODES.STATION_REJECTED]),
          504: errorWith('Station did not respond within timeout', [ERROR_CODES.STATION_TIMEOUT]),
        },
      },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const params = request.params as z.infer<typeof chargerConfigParams>;
      const body = request.body as z.infer<typeof guestStartBody>;

      if (body.paymentMethodId != null && body.paymentMethod != null) {
        await reply.status(400).send({
          error: 'Send either paymentMethodId or paymentMethod, not both',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      // Find station
      const [station] = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          isOnline: chargingStations.isOnline,
          ocppProtocol: chargingStations.ocppProtocol,
          disabledReason: chargingStations.disabledReason,
          firmwareState: chargingStations.firmwareState,
          reportedStatus: chargingStations.reportedStatus,
          onboardingStatus: chargingStations.onboardingStatus,
        })
        .from(chargingStations)
        .where(eq(chargingStations.stationId, params.stationId));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const guestActiveMaintenance = await getActiveMaintenanceForStation(station.id);
      if (guestActiveMaintenance != null) {
        await reply.status(409).send({
          error: 'Site is currently under maintenance',
          code: 'MAINTENANCE_ACTIVE',
          plannedEndAt: guestActiveMaintenance.plannedEndAt.toISOString(),
        });
        return;
      }

      if (!(await checkStationOnboarded(station, reply))) return;

      if (!station.isOnline) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      if (isStationLevelUnavailable(station)) {
        await reply
          .status(409)
          .send({ error: 'Station is unavailable', code: 'STATION_UNAVAILABLE' });
        return;
      }

      // Check EVSE availability
      const [evse] = await db
        .select({ id: evses.id })
        .from(evses)
        .where(and(eq(evses.stationId, station.id), eq(evses.evseId, params.evseId)));

      if (evse == null) {
        await reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
        return;
      }

      const [connector] = await db
        .select({ status: connectors.status })
        .from(connectors)
        .where(eq(connectors.evseId, evse.id))
        .limit(1);

      // Reservation gate: guest checkout is never allowed against an EVSE
      // with an active reservation, regardless of connector status. The
      // connector flips to `preparing` / `occupied` when the holder plugs
      // in -- without this check a guest could race the holder and start
      // a paid session against the holder&#39;s plug.
      const [activeReservation] = await db
        .select({ id: reservations.id })
        .from(reservations)
        .where(
          and(
            eq(reservations.stationId, station.id),
            or(eq(reservations.evseId, evse.id), sql`${reservations.evseId} IS NULL`),
            or(eq(reservations.status, 'active'), eq(reservations.status, 'scheduled')),
            // Window-current only: a scheduled reservation for the future must
            // not block guest checkout today. Captures the worker-activation-lag
            // window where status is still 'scheduled' past startsAt.
            sql`COALESCE(${reservations.startsAt}, ${reservations.createdAt}) <= NOW()`,
            sql`${reservations.expiresAt} > NOW()`,
          ),
        )
        .limit(1);
      if (activeReservation != null) {
        await reply.status(403).send({
          error: 'Connector is reserved',
          code: 'CONNECTOR_RESERVED',
        });
        return;
      }

      // 'finishing' (OCPP 1.6) means cable is still plugged after a previous
      // stop; real stations accept a new RemoteStart from this state. The
      // OCPP 2.1 equivalent is 'occupied' which is already in the set.
      const startableStatuses = ['available', 'occupied', 'preparing', 'ev_connected', 'finishing'];
      if (connector != null && !startableStatuses.includes(connector.status)) {
        await reply.status(400).send({
          error: 'Connector is not available for charging',
          code: 'CONNECTOR_NOT_AVAILABLE',
        });
        return;
      }

      // Defense-in-depth: refuse start if an active session already exists on this EVSE,
      // even when the connector status reads 'occupied' or 'available'. Connector status
      // can be momentarily out of sync with the chargingState (e.g. after a manual
      // StatusNotification refresh during a transaction), and we must never allow two
      // concurrent sessions on the same EVSE.
      const [evseActiveSession] = await db
        .select({ id: chargingSessions.id })
        .from(chargingSessions)
        .where(and(eq(chargingSessions.evseId, evse.id), eq(chargingSessions.status, 'active')))
        .limit(1);
      if (evseActiveSession != null) {
        await reply.status(409).send({
          error: 'Another session is already active on this connector',
          code: 'EVSE_IN_USE',
        });
        return;
      }

      // Block start if the EVSE has an upcoming reservation within the buffer window
      const inBuffer = await isEvseInReservationBuffer(station.id, evse.id);
      if (inBuffer) {
        await reply.status(409).send({
          error: 'This connector has an upcoming reservation and cannot start a new session',
          code: 'RESERVATION_BUFFER_ACTIVE',
        });
        return;
      }

      // Check if charging is free. Free-vend wins over the tariff lookup:
      // event-projections skips the payment gate for free-vend sites, so
      // requiring a payment method here would block guests from starting at
      // a free-vend site that happens to have a paid tariff assigned.
      const [siteFreeVend] = await db
        .select({ freeVendEnabled: sites.freeVendEnabled })
        .from(chargingStations)
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(eq(chargingStations.id, station.id));
      const chargingIsFree = await isStationChargingFree(
        {
          stationUuid: station.id,
          driverUuid: null,
          reserved: false,
          freeVend: siteFreeVend?.freeVendEnabled === true,
        },
        client,
      );

      // Generate session token. Capped at 20 chars to fit OCPP 1.6 idTag
      // maxLength constraint. 10 bytes = 20 hex chars = 80 bits of entropy,
      // plenty for a 15-minute single-use token.
      const sessionToken = crypto.randomBytes(10).toString('hex');
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

      // Hoisted so the rollback block at the end can cancel the pre-auth if
      // the station never acks RequestStartTransaction.
      let paymentIntentId: string | null = null;

      if (chargingIsFree) {
        // Free charging: skip payment, insert guest session directly
        await db.insert(guestSessions).values({
          stationOcppId: station.stationId,
          evseId: params.evseId,
          guestEmail: body.guestEmail ?? '',
          status: 'payment_authorized',
          startRequestedAt: new Date(),
          sessionToken,
          expiresAt,
          maxCostCents: body.maxCostCents ?? null,
          maxEnergyWh: body.maxEnergyWh ?? null,
          maxTimeSeconds: body.maxTimeSeconds ?? null,
        });
      } else {
        // Paid charging: require payment method and email
        const methodPayload: unknown = body.paymentMethod?.payload ?? body.paymentMethodId;
        if (body.paymentMethod == null && body.paymentMethodId == null) {
          await reply.status(400).send({
            error: 'Payment method required',
            code: 'PAYMENT_METHOD_REQUIRED',
          });
          return;
        }
        if (body.guestEmail == null) {
          await reply.status(400).send({
            error: 'Email required for paid charging',
            code: 'EMAIL_REQUIRED',
          });
          return;
        }
        // The 3DS return page continues the hold with the session token.
        const browserInput = body.paymentMethod?.browser;
        const browser =
          browserInput != null
            ? shopperBrowserContext(browserInput, apiConfig.PORTAL_URL, '/payments/return', {
                flow: 'guest',
                token: sessionToken,
              })
            : undefined;
        if (browser === null) {
          await reply.status(400).send(originMismatchError(apiConfig.PORTAL_URL));
          return;
        }
        // A card collected by another provider's UI (the active provider
        // changed after the page loaded) is refused before any hold.
        if (body.paymentMethod != null) {
          const active = await activePaymentProvider(request.log);
          if (active != null && active.id !== body.paymentMethod.provider) {
            await reply.status(400).send({
              error: 'The card was collected for another payment provider; reload the page',
              code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
            });
            return;
          }
        }

        // The hold (shopper present, one-time card) and the guest session
        // row; the service cancels the hold when the row cannot be stored.
        const hold = await authorizeGuestHold(
          {
            sessionToken,
            stationOcppId: station.stationId,
            evseId: params.evseId,
            siteId: station.siteId ?? null,
            methodPayload,
            ...(browser != null ? { browser } : {}),
            guestEmail: body.guestEmail,
            maxCostCents: body.maxCostCents ?? null,
            maxEnergyWh: body.maxEnergyWh ?? null,
            maxTimeSeconds: body.maxTimeSeconds ?? null,
            expiresAt,
          },
          paymentContext(request.log),
        );
        if (hold.outcome === 'not_configured') {
          await reply.status(400).send({
            error: 'Payment not configured for this station',
            code: 'PAYMENT_NOT_CONFIGURED',
          });
          return;
        }
        if (hold.outcome === 'declined') {
          await reply.status(400).send({ error: hold.reason, code: 'PAYMENT_FAILED' });
          return;
        }
        if (hold.outcome === 'action_required') {
          // 3D Secure: the session waits in pending_payment; the details
          // route authorizes the hold and starts charging.
          return { status: 'action_required', sessionToken, action: hold.action };
        }
        paymentIntentId = hold.paymentId;
      }

      const failure = await dispatchGuestStart(
        {
          sessionToken,
          stationOcppId: station.stationId,
          evseId: params.evseId,
          paymentId: paymentIntentId,
        },
        request.log,
      );
      if (failure != null) {
        await reply.status(failure.statusCode).send(failure.body);
        return;
      }
      return { status: 'started', sessionToken };
    },
  );

  app.post(
    '/portal/guest/payment-details/:sessionToken',
    {
      schema: {
        tags: ['Portal Guest'],
        summary: 'Continue a guest payment after 3D Secure and start charging',
        description:
          'Second step of a guest start that answered status action_required: sends the 3D Secure result (the card UI onAdditionalDetails data, or the redirectResult the return page PORTAL_URL/payments/return?flow=guest&token= received) to the provider the guest session is pinned to. An authorized hold moves the session to payment_authorized and dispatches RequestStartTransaction exactly once, also when the provider webhook attached the hold first; a replay after the start answers status started without a second start. A further action answers status action_required. A refused card is 400 PAYMENT_FAILED and the session fails. 404 SESSION_NOT_FOUND when no session under the token waits for its payment (unknown, expired, failed). Station rejection or timeout rolls back the session and cancels the hold (502/504). Rate limited like the auth routes.',
        operationId: 'portalGuestContinuePayment',
        security: [],
        params: zodSchema(sessionTokenParams),
        body: zodSchema(guestDetailsBody),
        response: {
          200: itemResponse(guestStartResponse),
          400: errorWith('Bad request', [
            ERROR_CODES.PAYMENT_FAILED,
            ERROR_CODES.PAYMENT_NOT_CONFIGURED,
          ]),
          404: errorWith('No guest session waits for its payment', [ERROR_CODES.SESSION_NOT_FOUND]),
          502: errorWith('Station rejected', [ERROR_CODES.STATION_REJECTED]),
          504: errorWith('Station did not respond within timeout', [ERROR_CODES.STATION_TIMEOUT]),
        },
      },
      config: {
        rateLimit: {
          max: apiConfig.AUTH_RATE_LIMIT_MAX,
          timeWindow: apiConfig.AUTH_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const { sessionToken } = request.params as z.infer<typeof sessionTokenParams>;
      const body = request.body as z.infer<typeof guestDetailsBody>;

      const continued = await continueGuestHold(
        { sessionToken, details: body.details },
        paymentContext(request.log),
      );
      if (continued.outcome === 'not_configured') {
        await reply.status(400).send({
          error: 'Payment not configured for this station',
          code: 'PAYMENT_NOT_CONFIGURED',
        });
        return;
      }
      if (continued.outcome === 'declined') {
        await reply.status(400).send({ error: continued.reason, code: 'PAYMENT_FAILED' });
        return;
      }
      if (continued.outcome === 'action_required') {
        return { status: 'action_required', sessionToken, action: continued.action };
      }

      // authorized, or not_pending for a session that already moved on (a
      // replayed details post after the start): the claim tells which.
      const claim = await claimGuestStart(sessionToken);
      if (claim.claim === 'already_requested') return { status: 'started', sessionToken };
      if (claim.claim === 'not_startable') {
        await reply.status(404).send({
          error: 'No guest session waits for its payment under this token',
          code: 'SESSION_NOT_FOUND',
        });
        return;
      }
      const failure = await dispatchGuestStart(
        {
          sessionToken,
          stationOcppId: claim.stationOcppId,
          evseId: claim.evseId,
          paymentId: claim.paymentId,
        },
        request.log,
      );
      if (failure != null) {
        await reply.status(failure.statusCode).send(failure.body);
        return;
      }
      return { status: 'started', sessionToken };
    },
  );

  app.get(
    '/portal/guest/status/:sessionToken',
    {
      schema: {
        tags: ['Portal Guest'],
        summary: 'Get the status of a guest charging session',
        operationId: 'portalGuestGetSessionStatus',
        security: [],
        params: zodSchema(sessionTokenParams),
        response: {
          200: itemResponse(guestStatusResponse),
          404: errorWith('Session not found', [ERROR_CODES.SESSION_NOT_FOUND]),
          429: errorWith('Rate limited', [ERROR_CODES.RATE_LIMITED]),
        },
      },
    },
    async (request, reply) => {
      const clientIp = request.ip;
      if (isGuestSessionRateLimited(clientIp)) {
        await reply.status(429).send({ error: 'Too many requests', code: 'RATE_LIMITED' });
        return;
      }

      const { sessionToken } = request.params as z.infer<typeof sessionTokenParams>;

      const [guest] = await db
        .select()
        .from(guestSessions)
        .where(eq(guestSessions.sessionToken, sessionToken));

      if (guest == null) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      // Look up isSimulator on the parent station so the portal can show
      // simulator-specific instructions in confirmation dialogs.
      const [parentStation] = await db
        .select({ isSimulator: chargingStations.isSimulator })
        .from(chargingStations)
        .where(eq(chargingStations.stationId, guest.stationOcppId));

      const result: Record<string, unknown> = {
        status: guest.status,
        stationOcppId: guest.stationOcppId,
        evseId: guest.evseId,
        isSimulator: parentStation?.isSimulator ?? false,
      };

      // If we have a linked charging session, include live data
      if (guest.chargingSessionId != null) {
        const [session] = await db
          .select({
            energyDeliveredWh: chargingSessions.energyDeliveredWh,
            currentCostCents: chargingSessions.currentCostCents,
            finalCostCents: chargingSessions.finalCostCents,
            taxCents: chargingSessions.taxCents,
            currency: sessionCurrencySql(),
            startedAt: chargingSessions.startedAt,
            endedAt: chargingSessions.endedAt,
            idleStartedAt: chargingSessions.idleStartedAt,
          })
          .from(chargingSessions)
          .where(eq(chargingSessions.id, guest.chargingSessionId));

        if (session != null) {
          result['energyDeliveredWh'] = session.energyDeliveredWh;
          result['currentCostCents'] = session.currentCostCents;
          result['finalCostCents'] = session.finalCostCents;
          result['taxCents'] = session.taxCents;
          result['currency'] = session.currency;
          result['startedAt'] = session.startedAt;
          result['endedAt'] = session.endedAt;
          result['idleStartedAt'] = session.idleStartedAt;
          result['limitReached'] = await sessionLimitReached(guest.chargingSessionId);
        }

        // Include failure reason from payment record if present
        if (guest.status === 'failed') {
          const [payment] = await db
            .select({ failureReason: paymentRecords.failureReason })
            .from(paymentRecords)
            .where(eq(paymentRecords.sessionId, guest.chargingSessionId));
          if (payment?.failureReason != null) {
            result['failureReason'] = payment.failureReason;
          }
        }
      }

      return result;
    },
  );

  app.post(
    '/portal/guest/stop/:sessionToken',
    {
      schema: {
        tags: ['Portal Guest'],
        summary: 'Stop a guest charging session',
        description:
          'Fire-and-forget RequestStopTransaction dispatched via pub/sub for the guest session linked to the supplied sessionToken. The portal polls /status to detect the actual stop. Rate limited 10/min. Returns 400 if the session is not in charging state.',
        operationId: 'portalGuestStopCharging',
        security: [],
        params: zodSchema(sessionTokenParams),
        response: {
          200: successResponse,
          400: errorWith('Bad request', [
            ERROR_CODES.NOT_CHARGING,
            ERROR_CODES.NO_CHARGING_SESSION,
            ERROR_CODES.SESSION_NOT_FOUND,
          ]),
          404: errorWith('Session not found', [ERROR_CODES.SESSION_NOT_FOUND]),
        },
      },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { sessionToken } = request.params as z.infer<typeof sessionTokenParams>;

      const [guest] = await db
        .select()
        .from(guestSessions)
        .where(eq(guestSessions.sessionToken, sessionToken));

      if (guest == null) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      if (guest.status !== 'charging') {
        await reply.status(400).send({
          error: 'Session is not currently charging',
          code: 'NOT_CHARGING',
        });
        return;
      }

      if (guest.chargingSessionId == null) {
        await reply.status(400).send({
          error: 'No linked charging session',
          code: 'NO_CHARGING_SESSION',
        });
        return;
      }

      // Get the transaction ID for the stop command
      const [session] = await db
        .select({ transactionId: chargingSessions.transactionId })
        .from(chargingSessions)
        .where(eq(chargingSessions.id, guest.chargingSessionId));

      if (session == null) {
        await reply.status(400).send({
          error: 'Charging session not found',
          code: 'SESSION_NOT_FOUND',
        });
        return;
      }

      await publishOcppCommand(getPubSub(), {
        stationId: guest.stationOcppId,
        action: 'RequestStopTransaction',
        payload: {
          transactionId: session.transactionId,
        },
      });

      return { success: true };
    },
  );

  app.get(
    '/portal/guest/power-history/:sessionToken',
    {
      schema: {
        tags: ['Portal Guest'],
        summary: 'Get power history for a guest charging session',
        operationId: 'portalGuestGetPowerHistory',
        security: [],
        params: zodSchema(sessionTokenParams),
        response: {
          200: itemResponse(
            z
              .object({
                data: z
                  .array(guestPowerHistoryItem)
                  .describe('Time-ordered power samples for the guest session'),
              })
              .passthrough(),
          ),
          404: errorWith('Session not found', [ERROR_CODES.SESSION_NOT_FOUND]),
          429: errorWith('Rate limited', [ERROR_CODES.RATE_LIMITED]),
        },
      },
    },
    async (request, reply) => {
      const clientIp = request.ip;
      if (isGuestSessionRateLimited(clientIp)) {
        await reply.status(429).send({ error: 'Too many requests', code: 'RATE_LIMITED' });
        return;
      }

      const { sessionToken } = request.params as z.infer<typeof sessionTokenParams>;

      const [guest] = await db
        .select({ chargingSessionId: guestSessions.chargingSessionId })
        .from(guestSessions)
        .where(eq(guestSessions.sessionToken, sessionToken));

      if (guest == null) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      if (guest.chargingSessionId == null) {
        return { data: [] };
      }

      const rows = await db
        .select({
          timestamp: meterValues.timestamp,
          powerW: sql<number>`${meterValues.value}::double precision`,
        })
        .from(meterValues)
        .where(
          and(
            eq(meterValues.sessionId, guest.chargingSessionId),
            eq(meterValues.measurand, 'Power.Active.Import'),
          ),
        )
        .orderBy(asc(meterValues.timestamp));

      return { data: rows };
    },
  );

  app.get(
    '/portal/guest/energy-history/:sessionToken',
    {
      schema: {
        tags: ['Portal Guest'],
        summary: 'Get energy history for a guest charging session',
        operationId: 'portalGuestGetEnergyHistory',
        security: [],
        params: zodSchema(sessionTokenParams),
        response: {
          200: itemResponse(
            z
              .object({
                data: z
                  .array(guestEnergyHistoryItem)
                  .describe('Time-ordered cumulative energy samples for the guest session'),
              })
              .passthrough(),
          ),
          404: errorWith('Session not found', [ERROR_CODES.SESSION_NOT_FOUND]),
          429: errorWith('Rate limited', [ERROR_CODES.RATE_LIMITED]),
        },
      },
    },
    async (request, reply) => {
      const clientIp = request.ip;
      if (isGuestSessionRateLimited(clientIp)) {
        await reply.status(429).send({ error: 'Too many requests', code: 'RATE_LIMITED' });
        return;
      }

      const { sessionToken } = request.params as z.infer<typeof sessionTokenParams>;

      const [guest] = await db
        .select({ chargingSessionId: guestSessions.chargingSessionId })
        .from(guestSessions)
        .where(eq(guestSessions.sessionToken, sessionToken));

      if (guest == null) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      if (guest.chargingSessionId == null) {
        return { data: [] };
      }

      const [session] = await db
        .select({ meterStart: chargingSessions.meterStart })
        .from(chargingSessions)
        .where(eq(chargingSessions.id, guest.chargingSessionId));

      const meterStart = session?.meterStart ?? 0;

      const rows = await db
        .select({
          timestamp: meterValues.timestamp,
          // Energy registers are stored in the station's unit (Wh or kWh); meterStart is Wh.
          energyWh: sql<number>`(CASE WHEN ${meterValues.unit} = 'kWh' THEN ${meterValues.value}::double precision * 1000 ELSE ${meterValues.value}::double precision END - ${meterStart})`,
        })
        .from(meterValues)
        .where(
          and(
            eq(meterValues.sessionId, guest.chargingSessionId),
            eq(meterValues.measurand, 'Energy.Active.Import.Register'),
          ),
        )
        .orderBy(asc(meterValues.timestamp));

      return { data: rows };
    },
  );
}
