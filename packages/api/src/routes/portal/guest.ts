// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, asc, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import { db } from '@evtivity/database';
import {
  chargingStations,
  connectors,
  evses,
  guestSessions,
  chargingSessions,
  meterValues,
  paymentRecords,
} from '@evtivity/database';
import { zodSchema } from '../../lib/zod-schema.js';
import { getPubSub } from '../../lib/pubsub.js';
import { errorResponse, successResponse, itemResponse } from '../../lib/response-schemas.js';
import { triggerAndWaitForStatus } from '../../lib/ocpp-command.js';
import { isStationCheckRateLimited, isGuestSessionRateLimited } from '../../lib/rate-limiters.js';
import { getStripeConfig } from '../../services/stripe.service.js';
import { resolveTariff, isTariffFree } from '../../services/tariff.service.js';
import { isEvseInReservationBuffer } from '../../lib/reservation-buffer.js';

const guestPricingInfo = z
  .object({
    currency: z.string(),
    pricePerKwh: z.string().nullable(),
    pricePerMinute: z.string().nullable(),
    pricePerSession: z.string().nullable(),
    idleFeePricePerMinute: z.string().nullable(),
    taxRate: z.string().nullable(),
  })
  .passthrough();

const chargerConfigResponse = z
  .object({
    paymentEnabled: z.boolean(),
    isFree: z.boolean(),
    publishableKey: z.string().optional(),
    currency: z.string().optional(),
    preAuthAmountCents: z.number().optional(),
    pricing: guestPricingInfo.optional(),
  })
  .passthrough();

const guestStartResponse = z.object({ sessionToken: z.string() }).passthrough();

const guestStatusResponse = z
  .object({
    status: z.string(),
    stationOcppId: z.string(),
    evseId: z.number(),
    energyDeliveredWh: z.coerce.number().nullable().optional(),
    currentCostCents: z.number().nullable().optional(),
    finalCostCents: z.number().nullable().optional(),
    currency: z.string().nullable().optional(),
    failureReason: z.string().nullable().optional(),
    startedAt: z.coerce.date().nullable().optional(),
    endedAt: z.coerce.date().nullable().optional(),
    idleStartedAt: z.coerce.date().nullable().optional(),
  })
  .passthrough();

const guestPowerHistoryItem = z
  .object({ timestamp: z.coerce.date(), powerW: z.number() })
  .passthrough();

const guestEnergyHistoryItem = z
  .object({ timestamp: z.coerce.date(), energyWh: z.number() })
  .passthrough();

const chargerConfigParams = z.object({
  stationId: z.string().describe('OCPP station identifier'),
  evseId: z.coerce.number().int().describe('EVSE ID on the station'),
});

const guestStartBody = z.object({
  paymentMethodId: z.string().min(1).optional(),
  guestEmail: z.string().email().optional(),
});

const sessionTokenParams = z.object({
  sessionToken: z.string().min(1).describe('Guest session token returned from the start endpoint'),
});

export function portalGuestRoutes(app: FastifyInstance): void {
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
        operationId: 'guestCheckConnectorStatus',
        security: [],
        params: zodSchema(guestCheckStatusParams),
        response: {
          200: itemResponse(
            z
              .object({
                connectorStatus: z.string().nullable(),
                error: z.string().optional(),
              })
              .passthrough(),
          ),
          404: errorResponse,
          429: errorResponse,
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
        return { connectorStatus: null, error: 'Station is offline' };
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

      return { connectorStatus: result.status, error: result.error };
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
        response: { 200: itemResponse(chargerConfigResponse), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const params = request.params as z.infer<typeof chargerConfigParams>;

      const [station] = await db
        .select({
          id: chargingStations.id,
          siteId: chargingStations.siteId,
          isSimulator: chargingStations.isSimulator,
        })
        .from(chargingStations)
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

      // Resolve tariff to check if charging is free (null driverUuid for guest)
      const tariff = await resolveTariff(station.id, null);
      const isFree = isTariffFree(tariff);

      const pricing =
        tariff != null
          ? {
              currency: tariff.currency,
              pricePerKwh: tariff.pricePerKwh,
              pricePerMinute: tariff.pricePerMinute,
              pricePerSession: tariff.pricePerSession,
              idleFeePricePerMinute: tariff.idleFeePricePerMinute,
              taxRate: tariff.taxRate,
            }
          : undefined;

      const config = await getStripeConfig(station.siteId ?? null);
      if (config == null) {
        return { paymentEnabled: false, isFree, isSimulator: station.isSimulator, pricing };
      }

      return {
        paymentEnabled: true,
        isFree,
        isSimulator: station.isSimulator,
        publishableKey: config.publishableKey,
        currency: config.currency,
        preAuthAmountCents: config.preAuthAmountCents,
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
        operationId: 'portalGuestStartCharging',
        security: [],
        params: zodSchema(chargerConfigParams),
        body: zodSchema(guestStartBody),
        response: {
          200: itemResponse(guestStartResponse),
          400: errorResponse,
          403: errorResponse,
          404: errorResponse,
          409: errorResponse,
        },
      },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const params = request.params as z.infer<typeof chargerConfigParams>;
      const body = request.body as z.infer<typeof guestStartBody>;

      // Find station
      const [station] = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          isOnline: chargingStations.isOnline,
          ocppProtocol: chargingStations.ocppProtocol,
          availability: chargingStations.availability,
          onboardingStatus: chargingStations.onboardingStatus,
        })
        .from(chargingStations)
        .where(eq(chargingStations.stationId, params.stationId));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (station.onboardingStatus !== 'accepted') {
        const code = station.onboardingStatus === 'pending' ? 'STATION_PENDING' : 'STATION_BLOCKED';
        const msg =
          station.onboardingStatus === 'pending'
            ? 'Station is pending approval'
            : 'Station is blocked';
        await reply.status(403).send({ error: msg, code });
        return;
      }

      if (!station.isOnline) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
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

      const startableStatuses = ['available', 'occupied', 'preparing', 'ev_connected'];
      if (connector != null && !startableStatuses.includes(connector.status)) {
        await reply.status(400).send({
          error: 'Connector is not available for charging',
          code: 'CONNECTOR_NOT_AVAILABLE',
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

      // Check if charging is free (null driverUuid for guest)
      const tariff = await resolveTariff(station.id, null);
      const chargingIsFree = isTariffFree(tariff);

      // Generate session token
      const sessionToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

      if (chargingIsFree) {
        // Free charging: skip payment, insert guest session directly
        await db.insert(guestSessions).values({
          stationOcppId: station.stationId,
          evseId: params.evseId,
          guestEmail: body.guestEmail ?? '',
          status: 'payment_authorized',
          sessionToken,
          expiresAt,
        });
      } else {
        // Paid charging: require payment method and email
        if (body.paymentMethodId == null) {
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

        // Get Stripe config
        const config = await getStripeConfig(station.siteId ?? null);
        if (config == null) {
          await reply.status(400).send({
            error: 'Payment not configured for this station',
            code: 'PAYMENT_NOT_CONFIGURED',
          });
          return;
        }

        // Create PaymentIntent with manual capture (guest pays with provided payment method)
        let paymentIntent;
        try {
          const piParams: Stripe.PaymentIntentCreateParams = {
            amount: config.preAuthAmountCents,
            currency: config.currency.toLowerCase(),
            payment_method: body.paymentMethodId,
            capture_method: 'manual',
            confirm: true,
            automatic_payment_methods: {
              enabled: true,
              allow_redirects: 'never',
            },
            receipt_email: body.guestEmail,
          };

          if (config.connectedAccountId != null) {
            piParams.on_behalf_of = config.connectedAccountId;
            piParams.transfer_data = { destination: config.connectedAccountId };
            if (config.platformFeePercent > 0) {
              piParams.application_fee_amount = Math.round(
                (config.preAuthAmountCents * config.platformFeePercent) / 100,
              );
            }
          }

          paymentIntent = await config.stripe.paymentIntents.create(piParams);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Payment failed';
          await reply.status(400).send({ error: message, code: 'PAYMENT_FAILED' });
          return;
        }

        // Insert guest session with payment
        await db.insert(guestSessions).values({
          stationOcppId: station.stationId,
          evseId: params.evseId,
          stripePaymentIntentId: paymentIntent.id,
          guestEmail: body.guestEmail,
          preAuthAmountCents: config.preAuthAmountCents,
          status: 'payment_authorized',
          sessionToken,
          expiresAt,
        });
      }

      // Send RequestStartTransaction via pg_notify
      const commandId = crypto.randomUUID();
      const notification = JSON.stringify({
        commandId,
        stationId: station.stationId,
        action: 'RequestStartTransaction',
        payload: {
          evseId: params.evseId,
          remoteStartId: Math.floor(Math.random() * 2_147_483_647),
          idToken: { idToken: sessionToken, type: 'Central' },
        },
      });

      await getPubSub().publish('ocpp_commands', notification);

      return { sessionToken };
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
          404: errorResponse,
          429: errorResponse,
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

      const result: Record<string, unknown> = {
        status: guest.status,
        stationOcppId: guest.stationOcppId,
        evseId: guest.evseId,
      };

      // If we have a linked charging session, include live data
      if (guest.chargingSessionId != null) {
        const [session] = await db
          .select({
            energyDeliveredWh: chargingSessions.energyDeliveredWh,
            currentCostCents: chargingSessions.currentCostCents,
            finalCostCents: chargingSessions.finalCostCents,
            currency: chargingSessions.currency,
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
          result['currency'] = session.currency;
          result['startedAt'] = session.startedAt;
          result['endedAt'] = session.endedAt;
          result['idleStartedAt'] = session.idleStartedAt;
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
        operationId: 'portalGuestStopCharging',
        security: [],
        params: zodSchema(sessionTokenParams),
        response: { 200: successResponse, 400: errorResponse, 404: errorResponse },
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

      // Send RequestStopTransaction via pg_notify
      const commandId = crypto.randomUUID();
      const notification = JSON.stringify({
        commandId,
        stationId: guest.stationOcppId,
        action: 'RequestStopTransaction',
        payload: {
          transactionId: session.transactionId,
        },
      });

      await getPubSub().publish('ocpp_commands', notification);

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
          200: itemResponse(z.object({ data: z.array(guestPowerHistoryItem) }).passthrough()),
          404: errorResponse,
          429: errorResponse,
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
          200: itemResponse(z.object({ data: z.array(guestEnergyHistoryItem) }).passthrough()),
          404: errorResponse,
          429: errorResponse,
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
          energyWh: sql<number>`(${meterValues.value}::double precision - ${meterStart})`,
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
