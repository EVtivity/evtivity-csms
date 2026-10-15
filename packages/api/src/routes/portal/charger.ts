// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, or, ilike, desc, asc, sql, gte, isNull, count, inArray } from 'drizzle-orm';
import {
  db,
  client,
  availableEvseCountSql,
  evseAvailableSql,
  evseOpenToDriversSql,
  STARTABLE_CONNECTOR_STATUSES,
  getCompanyCurrency,
  getCompanyTaxBasis,
  isStationLevelUnavailable,
  isStationChargingFree,
  resolveAccountBilling,
  sessionBillingColumns,
  checkFleetCreditLimit,
  resolveStationPricing,
  isSplitBillingEnabled,
  hasPaidTariff,
  writeCsmsSessionAudit,
} from '@evtivity/database';
import { decryptString, notificationMoney, publishOcppCommand, TAX_BASES } from '@evtivity/lib';
import { config as apiConfig } from '../../lib/config.js';
import {
  chargingStations,
  evses,
  connectors,
  sites,
  chargingSessions,
  driverPaymentMethods,
  reservations,
  stationImages,
  settings,
  sessionSiteIdSql,
  failUnstartedRemoteSession,
  REMOTE_START_TIMEOUT_REASON,
  REMOTE_START_REJECTED_REASON,
  isOperatorStation,
} from '@evtivity/database';
import { checkStationOnboarded } from '../../lib/onboarding-gate.js';
import { publicSiteListed, publicStationListed } from '../../lib/public-station.js';
import { zodSchema } from '../../lib/zod-schema.js';
import { optionalDriverId } from '../../lib/optional-driver.js';
import { requestSessionEnd } from '../../lib/session-end.js';
import { sessionCurrencySql } from '@evtivity/services/company-currency';
import { ID_PARAMS } from '../../lib/id-validation.js';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import {
  reservationCancellationFeeSchema,
  reservationFeesView,
  reservationNoShowFeeSchema,
} from '../../lib/reservation-fee-view.js';
import { scheduleRemoteStartTimeout } from '../../lib/remote-start-timeout.js';
import { itemResponse, arrayResponse, errorWith } from '../../lib/response-schemas.js';
import { ERROR_CODES } from '../../lib/error-codes.generated.js';
import { getS3Config, generateDownloadUrl } from '../../services/s3.service.js';
import { sendOcppCommandAndWait } from '@evtivity/services/ocpp-command';
import { sendStatusCheckError, triggerAndWaitForStatus } from '../../lib/station-status-check.js';
import {
  cancelReservationWithStation,
  createReservation,
  dispatchReservation,
  reserveNowToken,
} from '@evtivity/services/reservation.service';
import { notifyReservationDriver } from '@evtivity/services/reservation-notify';
import { MaintenanceConflictError } from '@evtivity/services/maintenance-check';
import { getActiveMaintenanceForStation } from '@evtivity/services/maintenance.service';
import { renderMaintenanceMessage } from '@evtivity/lib';
import type { ServiceLogger } from '@evtivity/lib';
import {
  isStationCheckRateLimited,
  getCachedConnectorStatus,
  setCachedConnectorStatus,
} from '../../lib/rate-limiters.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';
import {
  authorizeSessionHold,
  cancelOpenSessionHold,
  dispatchFleetCreditLimitNotices,
} from '@evtivity/payments';
import { activePaymentProvider, paymentContext } from '../../lib/payments.js';
import { dispatchDriverNotification } from '@evtivity/lib';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import { isEvseInReservationBuffer } from '../../lib/reservation-buffer.js';
import { driverBillingSchema, toDriverBilling } from '../../lib/portal-billing.js';
import { getAuditActor } from '../../lib/audit-actor.js';
import { commandOutcome, recordStationCommandAudit } from '../../lib/station-command-audit.js';

// The seeded default map view (`googleMaps.default*` in seed.ts and migration
// 0001): the center of the contiguous United States. Used when a row is missing
// or does not hold a number.
const DEFAULT_MAP_VIEW = { lat: 39.8283, lng: -98.5795, zoom: 4 } as const;

function mapViewNumber(stored: unknown, fallback: number): number {
  if (typeof stored !== 'string' && typeof stored !== 'number') return fallback;
  if (typeof stored === 'string' && stored.trim() === '') return fallback;
  const value = Number(stored);
  return Number.isFinite(value) ? value : fallback;
}

const portalConnectorItem = z
  .object({
    connectorId: z.number().int().min(1).describe('Connector index within the EVSE'),
    connectorType: z
      .string()
      .max(50)
      .nullable()
      .describe('Physical connector type (CCS2, CHAdeMO, Type1, Type2, NACS, etc.)'),
    maxPowerKw: z.number().min(0).nullable().describe('Maximum charging power in kilowatts'),
    maxCurrentAmps: z.number().min(0).nullable().describe('Maximum current in Amps'),
    status: z
      .string()
      .max(50)
      .describe(
        'Live connector status (available, occupied, charging, preparing, ev_connected, suspended_ev, suspended_evse, idle, finishing, reserved, faulted, unavailable)',
      ),
  })
  .passthrough();

const portalChargerDetail = z
  .object({
    stationId: z.string().max(255).describe('OCPP station identity'),
    siteId: z.string().nullable().describe('Owning site ID'),
    model: z.string().max(100).nullable().describe('Station hardware model'),
    isOnline: z.boolean().describe('Whether the station is currently online'),
    siteName: z.string().max(255).nullable().describe('Site name'),
    siteAddress: z.string().max(500).nullable().describe('Street address'),
    siteCity: z.string().max(100).nullable().describe('City'),
    siteState: z.string().max(100).nullable().describe('State or region'),
    paymentEnabled: z
      .boolean()
      .describe('Whether Stripe is configured for this site and payment is required'),
    evse: z
      .object({
        evseId: z.number().int().min(1).describe('EVSE ID on the station'),
        connectors: z.array(portalConnectorItem).describe('Connectors on this EVSE'),
        reservationExpiresAt: z
          .string()
          .nullable()
          .describe('ISO 8601 timestamp the active reservation expires, null when not reserved'),
        reserved: z.boolean().describe('True when an active reservation holds this EVSE'),
        reservedByMe: z
          .boolean()
          .describe(
            'True when the active reservation belongs to the signed-in driver (false for anonymous callers)',
          ),
      })
      .describe('Selected EVSE detail with reservation context'),
    maintenance: z
      .object({
        active: z.boolean(),
        plannedEndAt: z.coerce.date().nullable(),
        message: z.string().nullable(),
      })
      .passthrough()
      .nullable()
      .describe('Active maintenance window for the site; null when none'),
    stationUnavailable: z
      .boolean()
      .describe(
        'True when the whole station cannot charge right now (disabled, firmware install, or a station-level fault)',
      ),
  })
  .passthrough();

const portalEvseItem = z
  .object({
    evseId: z.number().int().min(1).describe('EVSE ID on the station'),
    connectors: z.array(portalConnectorItem).describe('Connectors on this EVSE'),
    reservationExpiresAt: z
      .string()
      .nullable()
      .describe('ISO 8601 timestamp the active reservation expires, null when not reserved'),
    reserved: z.boolean().describe('True when an active reservation holds this EVSE'),
    reservedByMe: z
      .boolean()
      .describe(
        'True when the active reservation belongs to the signed-in driver (false for anonymous callers)',
      ),
  })
  .passthrough();

const portalStationDetail = z
  .object({
    stationId: z.string().max(255).describe('OCPP station identity'),
    siteId: z.string().nullable().describe('Owning site ID'),
    model: z.string().max(100).nullable().describe('Station hardware model'),
    isOnline: z.boolean().describe('Whether the station is currently online'),
    siteName: z.string().max(255).nullable().describe('Site name'),
    siteAddress: z.string().max(500).nullable().describe('Street address'),
    siteCity: z.string().max(100).nullable().describe('City'),
    siteState: z.string().max(100).nullable().describe('State or region'),
    siteContactName: z
      .string()
      .max(255)
      .nullable()
      .describe('Public site contact name (null when contact is private)'),
    siteContactEmail: z
      .string()
      .max(255)
      .nullable()
      .describe('Public site contact email (null when contact is private)'),
    siteContactPhone: z
      .string()
      .max(50)
      .nullable()
      .describe('Public site contact phone (null when contact is private)'),
    paymentEnabled: z
      .boolean()
      .describe('Whether Stripe is configured for this site and payment is required'),
    evses: z.array(portalEvseItem).describe('All EVSEs on the station'),
    maintenance: z
      .object({
        active: z.boolean().describe('True when the site has an active maintenance window'),
        plannedEndAt: z.coerce
          .date()
          .nullable()
          .describe('When the active maintenance window is expected to end'),
        message: z
          .string()
          .nullable()
          .describe('Rendered driver-facing message for the active window'),
      })
      .passthrough()
      .nullable()
      .describe('Active maintenance window for the site; null when none'),
    stationUnavailable: z
      .boolean()
      .describe(
        'True when the whole station cannot charge right now (disabled, firmware install, or a station-level fault)',
      ),
  })
  .passthrough();

const portalConnectorSummary = z
  .object({
    connectorType: z
      .string()
      .max(50)
      .nullable()
      .describe('Physical connector type (CCS2, CHAdeMO, Type1, Type2, NACS, etc.)'),
    maxPowerKw: z.number().min(0).nullable().describe('Maximum charging power in kilowatts'),
    maxCurrentAmps: z.number().min(0).nullable().describe('Maximum current in Amps'),
    status: z.string().max(50).describe('Live connector status'),
  })
  .passthrough();

const portalChargerSearch = z
  .object({
    stationId: z.string().max(255).describe('OCPP station identity'),
    model: z.string().max(100).nullable().describe('Station hardware model'),
    isOnline: z.boolean().describe('Whether the station is currently online'),
    siteName: z.string().max(255).nullable().describe('Site name'),
    siteAddress: z.string().max(500).nullable().describe('Site street address'),
    siteCity: z.string().max(255).nullable().describe('Site city'),
    evseCount: z.number().int().min(0).describe('Total EVSEs at this station'),
    availableCount: z
      .number()
      .int()
      .min(0)
      .describe(
        'Number of EVSEs a driver can use now: 0 when the station is offline, disabled, installing firmware, faulted at station level, or under maintenance; a reserved EVSE is not counted',
      ),
    connectors: z
      .array(portalConnectorSummary)
      .describe('Summary of all connectors on the station for filtering and display'),
  })
  .passthrough();

const startChargingResponse = z
  .object({
    chargingSessionId: z
      .string()
      .describe('Newly created charging session ID, used to poll session state'),
  })
  .passthrough();

const activeSessionItem = z
  .object({
    id: z.string().describe('Charging session ID'),
    stationId: z.string().nullable().describe('OCPP station identity'),
    stationName: z.string().nullable().describe('Human-readable station name (model or vendor)'),
    transactionId: z.string().nullable().describe('OCPP transaction ID assigned by the station'),
    startedAt: z.coerce.date().describe('Session start timestamp'),
    energyDeliveredWh: z.coerce
      .number()
      .min(0)
      .nullable()
      .describe('Energy delivered so far in Watt-hours'),
    currentCostCents: z.number().int().min(0).nullable().describe('Running cost in cents'),
    currency: z.string().length(3).describe('ISO 4217 currency the session is billed in'),
  })
  .passthrough();

const stopSessionResponse = z
  .object({
    status: z
      .enum(['stopping', 'stopped', 'ghostRecovered'])
      .describe(
        'Stop request lifecycle state. "stopping" = station accepted, "ghostRecovered" = station had no record and the DB was force-cleaned',
      ),
    chargingSessionId: z.string().describe('Charging session ID'),
  })
  .passthrough();

const reservationItem = z
  .object({
    id: z.string().describe('Reservation ID (nanoid prefixed with rsv_)'),
    reservationId: z.number().int().min(1).describe('OCPP reservation ID echoed to the station'),
    stationOcppId: z.string().max(255).describe('OCPP station identity'),
    status: z
      .string()
      .max(50)
      .describe(
        'Reservation status (scheduled, active, used, cancelled, expired, system_cancelled)',
      ),
    startsAt: z.coerce
      .date()
      .nullable()
      .describe('Reservation window start, null for immediately-active reservations'),
    expiresAt: z.coerce.date().describe('Reservation window end'),
    createdAt: z.coerce.date().describe('Timestamp the reservation was created'),
    cancellationFee: reservationCancellationFeeSchema,
    noShowFee: reservationNoShowFeeSchema,
  })
  .passthrough();

const reservationDetail = z
  .object({
    id: z.string().describe('Reservation ID (nanoid prefixed with rsv_)'),
    reservationId: z.number().int().min(1).describe('OCPP reservation ID echoed to the station'),
    stationOcppId: z.string().max(255).describe('OCPP station identity'),
    siteName: z.string().max(255).nullable().describe('Site name'),
    siteAddress: z.string().max(500).nullable().describe('Street address'),
    siteCity: z.string().max(100).nullable().describe('City'),
    siteState: z.string().max(100).nullable().describe('State or region'),
    evseId: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('EVSE ID on the station, null for station-wide reservations'),
    status: z
      .string()
      .max(50)
      .describe(
        'Reservation status (scheduled, active, used, cancelled, expired, system_cancelled)',
      ),
    startsAt: z.coerce
      .date()
      .nullable()
      .describe('Reservation window start, null for immediately-active reservations'),
    expiresAt: z.coerce.date().describe('Reservation window end'),
    createdAt: z.coerce.date().describe('Timestamp the reservation was created'),
    updatedAt: z.coerce.date().describe('Timestamp the reservation was last updated'),
    sessionId: z
      .string()
      .nullable()
      .describe('Charging session ID created from this reservation, set only for used status'),
    cancellationFee: reservationCancellationFeeSchema,
    noShowFee: reservationNoShowFeeSchema,
  })
  .passthrough();

const reservationCreated = z
  .object({
    id: z.string().describe('Reservation ID (nanoid prefixed with rsv_)'),
    reservationId: z.number().int().min(1).describe('OCPP reservation ID echoed to the station'),
    stationId: z.string().describe('Internal station UUID'),
    driverId: z.string().nullable().describe('Driver ID that owns the reservation'),
    status: z.string().max(50).describe('Initial reservation status (scheduled or active)'),
    expiresAt: z.coerce.date().describe('Reservation window end'),
    createdAt: z.coerce.date().describe('Timestamp the reservation was created'),
  })
  .passthrough();

const cancelReservationResponse = z
  .object({
    status: z.literal('cancelled'),
    cancellationFeeChargedCents: z
      .number()
      .int()
      .min(0)
      .describe('Actual fee charged in cents, tax included (0 when waived or no payment method)'),
    feeChargeFailed: z
      .boolean()
      .optional()
      .describe(
        'True when a fee was attempted but the Stripe charge threw. Audit row shows 0; reconcile via Stripe.',
      ),
    warning: z
      .literal('station_cancel_failed')
      .optional()
      .describe(
        'Set when the station refused the CancelReservation or did not answer. The reservation is cancelled.',
      ),
  })
  .passthrough();

const sessionIdParams = z.object({
  sessionId: ID_PARAMS.sessionId.describe('Charging session ID'),
});

const reservationIdParams = z.object({
  id: ID_PARAMS.reservationId.describe('Reservation ID'),
});

const createDriverReservationBody = z.object({
  stationId: z.string().describe('OCPP station identifier'),
  evseId: z.coerce
    .number()
    .int()
    .min(0)
    .max(2147483647)
    .optional()
    .describe('EVSE ID on the station'),
  expiresAt: z.string().datetime().describe('ISO 8601 reservation expiration time'),
  startsAt: z
    .string()
    .datetime()
    .optional()
    .describe('ISO 8601 start date-time for delayed scheduling'),
});

const chargerParams = z.object({
  stationId: z.string().describe('OCPP station identifier'),
  evseId: z.coerce.number().int().min(0).max(2147483647).describe('EVSE ID on the station'),
});

const stationIdParams = z.object({
  stationId: z.string().describe('OCPP station identifier'),
});

const portalPricingInfo = z
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
    reservationFeePerMinute: z
      .string()
      .nullable()
      .describe(
        'Reservation holding fee per minute in major currency units: a reservation made now is charged it for the minutes it holds the connector when it expires unused (the no-show fee). Null for none',
      ),
    taxRate: z.string().nullable().describe('Sales tax rate as a decimal (e.g. 0.0875 = 8.75%)'),
    taxBasis: z
      .enum(TAX_BASES)
      .describe(
        'How the prices above are entered (company setting company.taxBasis): net prices exclude the tax rate, gross prices include it. Convert with the tax rate to show a price the other way.',
      ),
    isFreeVend: z
      .boolean()
      .describe(
        'True when the station&#39;s site has free vend mode enabled, meaning no charges apply regardless of the resolved tariff. The portal should surface this as a badge so drivers understand why pricing reads as free.',
      ),
    restrictions: z
      .unknown()
      .nullable()
      .describe(
        'When present, identifies the conditions under which the resolved tariff applies (time-of-day, days-of-week, seasonal date range, holiday-only, or energy threshold). Drivers should see this so they understand why a non-default rate is showing -- otherwise a "Peak rate $0.50/kWh" reads like the always-on price when it actually only applies 09:00-17:00.',
      ),
    billing: driverBillingSchema
      .nullable()
      .describe(
        'How the driver pays a session started at this charger: account (billed to a fleet, no payment method needed, no hold) or card. Null at a free vend site, where nothing is billed',
      ),
    timezone: z
      .string()
      .nullable()
      .describe(
        'IANA timezone of the station site that time-of-day restrictions are evaluated in. Null when the site has none (the system timezone applies)',
      ),
    priceChangesDuringSession: z
      .boolean()
      .describe(
        'True when split billing is on and the pricing group has tariffs with restrictions: the price can change while the session charges (time of day, day, season, holiday or energy reached)',
      ),
    paidTariffAhead: z
      .boolean()
      .describe(
        'True when split billing is on and the pricing group has a paid tariff: a session that starts on a free tariff can become paid, so the start needs a payment method like a paid tariff',
      ),
  })
  .passthrough();

const searchQuery = z.object({
  q: z.string().min(1),
});

const nearbyQuery = z.object({
  lat: z.coerce.number().min(-90).max(90).describe('Latitude'),
  lng: z.coerce.number().min(-180).max(180).describe('Longitude'),
  radius: z.coerce.number().min(1).max(200).default(50).describe('Radius in km (default 50)'),
  limit: z.coerce.number().int().min(1).max(100).default(20).describe('Max results (default 20)'),
});

const portalNearbyStation = z
  .object({
    stationId: z.string().max(255).describe('OCPP station identity'),
    model: z.string().max(100).nullable().describe('Station hardware model'),
    isOnline: z.boolean().describe('Whether the station is currently online'),
    siteName: z.string().max(255).nullable().describe('Site name'),
    siteAddress: z.string().max(500).nullable().describe('Street address'),
    siteCity: z.string().max(100).nullable().describe('City'),
    distanceKm: z.number().min(0).describe('Great-circle distance from the search point in km'),
    evseCount: z.number().int().min(0).describe('Total EVSEs at this station'),
    availableCount: z
      .number()
      .int()
      .min(0)
      .describe(
        'Number of EVSEs a driver can use now: 0 when the station is offline, disabled, installing firmware, faulted at station level, or under maintenance; a reserved EVSE is not counted',
      ),
    connectors: z
      .array(portalConnectorSummary)
      .describe('Summary of all connectors on the station for filtering and display'),
  })
  .passthrough();

const startChargingBody = z.object({
  paymentMethodId: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Driver payment method ID, required when payment is enabled'),
});

async function getMaintenancePayloadForStation(
  stationDbId: string,
  log: ServiceLogger,
): Promise<{ active: boolean; plannedEndAt: Date | null; message: string | null } | null> {
  const event = await getActiveMaintenanceForStation(stationDbId);
  if (event == null) return null;
  let message: string | null = null;
  try {
    const [siteRow] = await db
      .select({ name: sites.name })
      .from(sites)
      .where(eq(sites.id, event.siteId));
    message = await renderMaintenanceMessage(client, event, siteRow?.name ?? '');
  } catch (err) {
    log.warn(
      { err, stationDbId, maintenanceId: event.id },
      'Rendering the maintenance message failed, sending none',
    );
    message = null;
  }
  return { active: true, plannedEndAt: event.plannedEndAt, message };
}

/**
 * An OCPP 2.1 session the station started at plug-in (cable first,
 * TxStartPoint EVConnected) that still waits for its authorization: active,
 * started by the station (a Started event, no remote start), with no driver,
 * token, guest, roaming flag, free vend, billing stamp or stop claim, and no
 * event that carried an idToken. The payment gate waits for it
 * (`linkFirstPresentedToken` in the OCPP projection), so a portal start may
 * take it over.
 */
function awaitingAuthorization() {
  return and(
    eq(chargingSessions.status, 'active'),
    isNull(chargingSessions.stoppedReason),
    isNull(chargingSessions.driverId),
    isNull(chargingSessions.tokenId),
    isNull(chargingSessions.remoteStartId),
    isNull(chargingSessions.billingMode),
    eq(chargingSessions.isRoaming, false),
    eq(chargingSessions.freeVend, false),
    sql`EXISTS (
      SELECT 1 FROM transaction_events te
      WHERE te.session_id = ${chargingSessions.id} AND te.event_type = 'started'
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM transaction_events te
      WHERE te.session_id = ${chargingSessions.id} AND te.payload->>'idToken' IS NOT NULL
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM guest_sessions g WHERE g.charging_session_id = ${chargingSessions.id}
    )`,
  );
}
export function portalChargerRoutes(app: FastifyInstance): void {
  app.get(
    '/portal/chargers/:stationId/evse/:evseId',
    {
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Get charger and EVSE details',
        operationId: 'portalGetChargerEvse',
        security: [],
        params: zodSchema(chargerParams),
        response: {
          200: itemResponse(portalChargerDetail),
          404: errorWith('Resource not found', [
            ERROR_CODES.EVSE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
        },
      },
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const params = request.params as z.infer<typeof chargerParams>;

      const [station] = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          model: chargingStations.model,
          isOnline: chargingStations.isOnline,
          disabledReason: chargingStations.disabledReason,
          firmwareState: chargingStations.firmwareState,
          reportedStatus: chargingStations.reportedStatus,
          isSimulator: chargingStations.isSimulator,
          siteName: sites.name,
          siteAddress: sites.address,
          siteCity: sites.city,
          siteState: sites.state,
        })
        .from(chargingStations)
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(and(eq(chargingStations.stationId, params.stationId), publicStationListed()));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const [evse] = await db
        .select({
          id: evses.id,
          evseId: evses.evseId,
        })
        .from(evses)
        .where(
          and(
            eq(evses.stationId, station.id),
            eq(evses.evseId, params.evseId),
            isNull(evses.retiredAt),
          ),
        );

      if (evse == null) {
        await reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
        return;
      }

      const evseConnectors = await db
        .select({
          connectorId: connectors.connectorId,
          connectorType: connectors.connectorType,
          maxPowerKw: connectors.maxPowerKw,
          maxCurrentAmps: connectors.maxCurrentAmps,
          status: connectors.status,
        })
        .from(connectors)
        .where(and(eq(connectors.evseId, evse.id), isNull(connectors.retiredAt)));

      // Look up active reservation regardless of connector status. Status
      // flips from `reserved` to `preparing`/`occupied` the moment the
      // holder plugs in, but the reservation is still active and the gate
      // must keep applying. Gating on connector status here would let the
      // UI flash a Start button for everyone post-plug-in.
      let reservationExpiresAt: string | null = null;
      let reservedByMe = false;
      {
        const [reservation] = await db
          .select({ expiresAt: reservations.expiresAt, driverId: reservations.driverId })
          .from(reservations)
          .where(
            and(
              eq(reservations.stationId, station.id),
              or(eq(reservations.evseId, evse.id), sql`${reservations.evseId} IS NULL`),
              or(eq(reservations.status, 'active'), eq(reservations.status, 'scheduled')),
              // Window-current only: scheduled reservations whose start is in the
              // future should not surface as "reserved" yet. This also handles
              // the worker-activation-lag case where status is still 'scheduled'
              // past startsAt -- those should be treated as live.
              sql`COALESCE(${reservations.startsAt}, ${reservations.createdAt}) <= NOW()`,
              sql`${reservations.expiresAt} > NOW()`,
            ),
          )
          .orderBy(asc(reservations.expiresAt))
          .limit(1);
        if (reservation != null) {
          reservationExpiresAt = reservation.expiresAt.toISOString();
          // The holder's id is never returned: the route is public.
          const callerDriverId = await optionalDriverId(request);
          reservedByMe = callerDriverId != null && reservation.driverId === callerDriverId;
        }
      }

      const paymentProvider = await activePaymentProvider(request.log);
      const maintenance = await getMaintenancePayloadForStation(station.id, request.log);

      return {
        stationId: station.stationId,
        siteId: station.siteId ?? null,
        model: station.model,
        isOnline: station.isOnline,
        isSimulator: station.isSimulator,
        siteName: station.siteName,
        siteAddress: station.siteAddress,
        siteCity: station.siteCity,
        siteState: station.siteState,
        paymentEnabled: paymentProvider != null,
        evse: {
          evseId: evse.evseId,
          connectors: evseConnectors,
          reservationExpiresAt,
          reserved: reservationExpiresAt != null,
          reservedByMe,
        },
        maintenance,
        stationUnavailable: isStationLevelUnavailable(station),
      };
    },
  );

  app.get(
    '/portal/chargers/:stationId/pricing',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Get resolved pricing for a charger',
        operationId: 'portalGetChargerPricing',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        response: {
          200: itemResponse(portalPricingInfo),
          404: errorWith('Resource not found', [
            ERROR_CODES.PRICING_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { stationId } = request.params as z.infer<typeof stationIdParams>;

      const [station] = await db
        .select({ id: chargingStations.id, freeVendEnabled: sites.freeVendEnabled })
        .from(chargingStations)
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(and(eq(chargingStations.stationId, stationId), publicStationListed()));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Free-vend sites legitimately operate without an assigned pricing
      // group -- event-projections skips tariff snapshot and payment gate
      // entirely when free_vend_enabled = true. Calling resolveTariff would
      // 404 PRICING_NOT_FOUND and the portal would show nothing instead of
      // the "Free charging at this site" badge. Short-circuit with a zeroed
      // tariff payload + isFreeVend flag so PricingDisplay surfaces the
      // badge regardless of whether a pricing group exists.
      if (station.freeVendEnabled === true) {
        return {
          currency: await getCompanyCurrency(),
          pricePerKwh: null,
          pricePerMinute: null,
          pricePerSession: null,
          idleFeePricePerMinute: null,
          reservationFeePerMinute: null,
          taxRate: null,
          taxBasis: await getCompanyTaxBasis(),
          isFreeVend: true,
          restrictions: null,
          billing: null,
          timezone: null,
          priceChangesDuringSession: false,
          paidTariffAhead: false,
        };
      }

      // The resolver billing uses (the whole group chain), so the driver is
      // shown the tariff the session is charged at.
      const resolved = await resolveStationPricing(
        { stationUuid: station.id, driverUuid: driverId },
        client,
      );
      if (resolved == null) {
        await reply.status(404).send({ error: 'No pricing found', code: 'PRICING_NOT_FOUND' });
        return;
      }
      const { tariff, groupTariffs } = resolved;
      const splitBilling = await isSplitBillingEnabled();
      const priceChangesDuringSession = splitBilling && groupTariffs.some((t) => t.priority > 0);
      // The start decides free or paid like isStationChargingFree (B3).
      const paidTariffAhead = splitBilling && hasPaidTariff(groupTariffs);

      return {
        currency: await getCompanyCurrency(),
        pricePerKwh: tariff.pricePerKwh,
        pricePerMinute: tariff.pricePerMinute,
        pricePerSession: tariff.pricePerSession,
        idleFeePricePerMinute: tariff.idleFeePricePerMinute,
        reservationFeePerMinute: tariff.reservationFeePerMinute,
        taxRate: tariff.taxRate,
        taxBasis: await getCompanyTaxBasis(),
        isFreeVend: false,
        restrictions: tariff.restrictions ?? null,
        billing: toDriverBilling(await resolveAccountBilling(client, driverId)),
        timezone: tariff.timezone,
        priceChangesDuringSession,
        paidTariffAhead,
      };
    },
  );

  app.get(
    '/portal/chargers/search',
    {
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Search chargers by station ID, site name, or address',
        operationId: 'portalSearchChargers',
        security: [],
        querystring: zodSchema(searchQuery),
        response: { 200: arrayResponse(portalChargerSearch) },
      },
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
        },
      },
    },
    async (request) => {
      const { q } = request.query as z.infer<typeof searchQuery>;

      // Match station id, site name, and the full address (street, city, state,
      // postal code) so a driver can find a charger by where it is, not just by
      // its name. Split on whitespace and require every term to match at least
      // one field, so "Main Austin" narrows to a charger on Main St in Austin.
      const searchFields = [
        chargingStations.stationId,
        sites.name,
        sites.address,
        sites.city,
        sites.state,
        sites.postalCode,
      ];
      const matchTerm = (term: string): ReturnType<typeof or> => {
        const pattern = `%${term}%`;
        return or(...searchFields.map((field) => ilike(field, pattern)));
      };
      const terms = q
        .trim()
        .split(/\s+/)
        .filter((term) => term.length > 0);
      const whereClause = terms.length > 0 ? and(...terms.map(matchTerm)) : matchTerm(q);

      const rows = await db
        .select({
          stationId: chargingStations.stationId,
          stationUuid: chargingStations.id,
          model: chargingStations.model,
          isOnline: chargingStations.isOnline,
          siteName: sites.name,
          siteAddress: sites.address,
          siteCity: sites.city,
          evseCount: sql<number>`(SELECT count(*)::int FROM evses WHERE evses.station_id = ${chargingStations.id} AND evses.retired_at IS NULL)`,
          availableCount: sql<number>`${sql.raw(availableEvseCountSql('charging_stations'))}`,
        })
        .from(chargingStations)
        .innerJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(and(publicStationListed(), whereClause))
        .limit(20);

      const stationUuids = rows.map((r) => r.stationUuid);
      const connectorRows =
        stationUuids.length > 0
          ? await db
              .select({
                stationId: evses.stationId,
                connectorType: connectors.connectorType,
                maxPowerKw: connectors.maxPowerKw,
                maxCurrentAmps: connectors.maxCurrentAmps,
                status: connectors.status,
              })
              .from(connectors)
              .innerJoin(evses, eq(connectors.evseId, evses.id))
              .where(
                sql`${evses.stationId} IN ${stationUuids} AND ${evses.retiredAt} IS NULL AND ${connectors.retiredAt} IS NULL`,
              )
          : [];

      const connectorsByStation = new Map<string, typeof connectorRows>();
      for (const c of connectorRows) {
        const list = connectorsByStation.get(c.stationId) ?? [];
        list.push(c);
        connectorsByStation.set(c.stationId, list);
      }

      return rows.map((r) => ({
        stationId: r.stationId,
        model: r.model,
        isOnline: r.isOnline,
        siteName: r.siteName,
        siteAddress: r.siteAddress,
        siteCity: r.siteCity,
        evseCount: r.evseCount,
        availableCount: r.availableCount,
        connectors: (connectorsByStation.get(r.stationUuid) ?? []).map((c) => ({
          connectorType: c.connectorType,
          maxPowerKw: c.maxPowerKw,
          maxCurrentAmps: c.maxCurrentAmps,
          status: c.status,
        })),
      }));
    },
  );

  app.get(
    '/portal/chargers/nearby',
    {
      schema: {
        tags: ['Portal Chargers'],
        summary: 'List nearby chargers by coordinates',
        operationId: 'portalListNearbyChargers',
        security: [],
        querystring: zodSchema(nearbyQuery),
        response: { 200: arrayResponse(portalNearbyStation) },
      },
    },
    async (request) => {
      const { lat, lng, radius, limit } = request.query as z.infer<typeof nearbyQuery>;

      // Use station-level coordinates when available, fall back to site
      const latExpr = sql`COALESCE(${chargingStations.latitude}, ${sites.latitude})`;
      const lngExpr = sql`COALESCE(${chargingStations.longitude}, ${sites.longitude})`;

      // Haversine distance in km
      const distanceExpr = sql<number>`(
        6371 * acos(
          LEAST(1.0, GREATEST(-1.0,
            cos(radians(${lat})) * cos(radians(CAST(${latExpr} AS double precision)))
            * cos(radians(CAST(${lngExpr} AS double precision)) - radians(${lng}))
            + sin(radians(${lat})) * sin(radians(CAST(${latExpr} AS double precision)))
          ))
        )
      )`;

      const rows = await db
        .select({
          stationId: chargingStations.stationId,
          stationUuid: chargingStations.id,
          model: chargingStations.model,
          isOnline: chargingStations.isOnline,
          siteName: sites.name,
          siteAddress: sites.address,
          siteCity: sites.city,
          distanceKm: distanceExpr,
          evseCount: sql<number>`(SELECT count(*)::int FROM evses WHERE evses.station_id = ${chargingStations.id} AND evses.retired_at IS NULL)`,
          availableCount: sql<number>`${sql.raw(availableEvseCountSql('charging_stations'))}`,
        })
        .from(chargingStations)
        .innerJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(
          and(
            publicStationListed(),
            sql`COALESCE(${chargingStations.latitude}, ${sites.latitude}) IS NOT NULL`,
            sql`COALESCE(${chargingStations.longitude}, ${sites.longitude}) IS NOT NULL`,
            sql`${distanceExpr} <= ${radius}`,
          ),
        )
        .orderBy(sql`${distanceExpr}`)
        .limit(limit);

      const stationUuids = rows.map((r) => r.stationUuid);
      const connectorRows =
        stationUuids.length > 0
          ? await db
              .select({
                stationId: evses.stationId,
                connectorType: connectors.connectorType,
                maxPowerKw: connectors.maxPowerKw,
                maxCurrentAmps: connectors.maxCurrentAmps,
                status: connectors.status,
              })
              .from(connectors)
              .innerJoin(evses, eq(connectors.evseId, evses.id))
              .where(
                sql`${evses.stationId} IN ${stationUuids} AND ${evses.retiredAt} IS NULL AND ${connectors.retiredAt} IS NULL`,
              )
          : [];

      const connectorsByStation = new Map<string, typeof connectorRows>();
      for (const c of connectorRows) {
        const list = connectorsByStation.get(c.stationId) ?? [];
        list.push(c);
        connectorsByStation.set(c.stationId, list);
      }

      return rows.map((r) => ({
        stationId: r.stationId,
        model: r.model,
        isOnline: r.isOnline,
        siteName: r.siteName,
        siteAddress: r.siteAddress,
        siteCity: r.siteCity,
        distanceKm: Math.round(r.distanceKm * 10) / 10,
        evseCount: r.evseCount,
        availableCount: r.availableCount,
        connectors: (connectorsByStation.get(r.stationUuid) ?? []).map((c) => ({
          connectorType: c.connectorType,
          maxPowerKw: c.maxPowerKw,
          maxCurrentAmps: c.maxCurrentAmps,
          status: c.status,
        })),
      }));
    },
  );

  // --- Map config endpoint (registered before /:stationId to avoid route conflicts) ---

  const mapConfigResponse = z
    .object({
      apiKey: z
        .string()
        .describe('Google Maps JavaScript API key (empty string when not configured)'),
      defaultLat: z.number().describe('Default map center latitude'),
      defaultLng: z.number().describe('Default map center longitude'),
      defaultZoom: z.number().describe('Default Google Maps zoom level'),
    })
    .passthrough();

  app.get(
    '/portal/chargers/map-config',
    {
      // Unauthenticated. Cap traffic so a bot cannot pull the published
      // Google Maps key fragment thousands of times per second to amplify
      // quota consumption.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Get Google Maps configuration',
        operationId: 'portalGetMapConfig',
        security: [],
        response: { 200: itemResponse(mapConfigResponse) },
      },
    },
    async (request) => {
      const rows = await db
        .select({ key: settings.key, value: settings.value })
        .from(settings)
        .where(
          inArray(settings.key, [
            'googleMaps.apiKeyEnc',
            'googleMaps.defaultLat',
            'googleMaps.defaultLng',
            'googleMaps.defaultZoom',
          ]),
        );

      const map = new Map(rows.map((r) => [r.key, r.value as string]));

      const rawApiKey = map.get('googleMaps.apiKeyEnc') ?? '';
      const encryptionKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
      let apiKey = '';
      if (rawApiKey !== '' && encryptionKey !== '') {
        try {
          apiKey = decryptString(rawApiKey, encryptionKey);
        } catch (err) {
          // Empty apiKey makes the frontend render "Maps not configured".
          request.log.error(
            { err, key: 'googleMaps.apiKeyEnc' },
            'Decrypting the Google Maps API key failed, maps stay off',
          );
        }
      }

      return {
        apiKey,
        defaultLat: mapViewNumber(map.get('googleMaps.defaultLat'), DEFAULT_MAP_VIEW.lat),
        defaultLng: mapViewNumber(map.get('googleMaps.defaultLng'), DEFAULT_MAP_VIEW.lng),
        defaultZoom: mapViewNumber(map.get('googleMaps.defaultZoom'), DEFAULT_MAP_VIEW.zoom),
      };
    },
  );

  // --- Location detail endpoints (registered before /:stationId to avoid route conflicts) ---

  const siteIdParams = z.object({
    siteId: z.string().describe('Site ID'),
  });

  const portalLocationDetail = z
    .object({
      siteId: z.string().describe('Site ID'),
      name: z.string().nullable().describe('Site name'),
      address: z.string().nullable().describe('Street address'),
      city: z.string().nullable().describe('City'),
      state: z.string().nullable().describe('State or region'),
      postalCode: z.string().nullable().describe('Postal or ZIP code'),
      latitude: z.string().nullable().describe('Latitude in decimal degrees (string)'),
      longitude: z.string().nullable().describe('Longitude in decimal degrees (string)'),
      hoursOfOperation: z.string().nullable().describe('Free-form hours of operation text'),
      contactName: z
        .string()
        .nullable()
        .describe('Public contact name (null when contact is private)'),
      contactEmail: z
        .string()
        .nullable()
        .describe('Public contact email (null when contact is private)'),
      contactPhone: z
        .string()
        .nullable()
        .describe('Public contact phone (null when contact is private)'),
      stationCount: z.number().describe('Number of stations at this site'),
      evseCount: z.number().describe('Total EVSEs across all stations at this site'),
      availableCount: z
        .number()
        .describe(
          'Number of EVSEs across the site a driver can use now (same rule as the charger search)',
        ),
      chargers: z
        .array(
          z
            .object({
              stationId: z.string().describe('OCPP station identity'),
              stationName: z.string().describe('Station display name'),
              evseId: z.number().int().describe('OCPP EVSE ID'),
              connectorType: z.string().nullable().describe('Physical connector type'),
              maxPowerKw: z.string().nullable().describe('Maximum power in kW (decimal string)'),
              status: z.string().describe('Live connector status'),
              available: z
                .boolean()
                .describe(
                  'Whether a driver can start here now: the station is online, enabled and not under maintenance, the EVSE is not reserved, and the connector status is startable',
                ),
            })
            .passthrough(),
        )
        .describe('One row per EVSE connector at the site, ordered by station and EVSE'),
    })
    .passthrough();

  const portalLocationImage = z
    .object({
      id: z.number().describe('Image ID'),
      stationId: z.string().describe('Owning station ID'),
      fileName: z.string().describe('Original uploaded file name'),
      fileSize: z.number().describe('File size in bytes'),
      contentType: z.string().describe('MIME content type'),
      caption: z.string().nullable().describe('Operator-supplied caption shown to drivers'),
    })
    .passthrough();

  const popularTimesQuery = z.object({
    weeks: z.coerce
      .number()
      .int()
      .min(1)
      .max(52)
      .default(4)
      .describe('Number of weeks to average over'),
  });

  const popularTimesItem = z
    .object({
      dow: z.number().describe('Day of week (0 = Sunday, 6 = Saturday) in the site timezone'),
      hour: z.number().describe('Hour of day (0-23) in the site timezone'),
      avgSessions: z
        .number()
        .describe('Average sessions per (dow, hour) bucket over the requested weeks'),
    })
    .passthrough();

  const imageIdParams = z.object({
    siteId: z.string().describe('Site ID'),
    imageId: z.coerce.number().int().describe('Image ID'),
  });

  app.get(
    '/portal/chargers/location/:siteId',
    {
      // Public route. Rate limit to keep bot enumeration of siteIds within
      // reasonable bounds without blocking a real user opening a few
      // location pages per minute.
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Get location detail for a site',
        operationId: 'portalGetLocationDetail',
        security: [],
        params: zodSchema(siteIdParams),
        response: {
          200: itemResponse(portalLocationDetail),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { siteId } = request.params as z.infer<typeof siteIdParams>;

      const [site] = await db
        .select({
          id: sites.id,
          name: sites.name,
          address: sites.address,
          city: sites.city,
          state: sites.state,
          postalCode: sites.postalCode,
          latitude: sites.latitude,
          longitude: sites.longitude,
          hoursOfOperation: sites.hoursOfOperation,
          contactName: sites.contactName,
          contactEmail: sites.contactEmail,
          contactPhone: sites.contactPhone,
          contactIsPublic: sites.contactIsPublic,
        })
        .from(sites)
        .where(and(eq(sites.id, siteId), publicSiteListed()));

      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const [counts] = await db
        .select({
          stationCount: sql<number>`count(DISTINCT ${chargingStations.id})::int`,
          evseCount: sql<number>`count(DISTINCT ${evses.id})::int`,
          availableCount: sql<number>`count(DISTINCT ${evses.id}) FILTER (WHERE ${sql.raw(evseAvailableSql('evses', 'charging_stations'))})::int`,
        })
        .from(chargingStations)
        .leftJoin(evses, and(eq(evses.stationId, chargingStations.id), isNull(evses.retiredAt)))
        .leftJoin(connectors, and(eq(connectors.evseId, evses.id), isNull(connectors.retiredAt)))
        .where(and(eq(chargingStations.siteId, siteId), publicStationListed()));

      // Per-EVSE detail for the chargers list. One row per EVSE with the first
      // connector's type / power / status (most stations have 1 connector per
      // EVSE, and the portal renders one button per EVSE).
      const chargers = await db
        .select({
          stationId: chargingStations.stationId,
          stationName: chargingStations.stationId,
          evseId: evses.evseId,
          connectorType: connectors.connectorType,
          maxPowerKw: connectors.maxPowerKw,
          status: connectors.status,
          available: sql<boolean>`(${sql.raw(evseOpenToDriversSql('evses', 'charging_stations'))} AND ${inArray(connectors.status, [...STARTABLE_CONNECTOR_STATUSES])})`,
        })
        .from(chargingStations)
        .innerJoin(evses, and(eq(evses.stationId, chargingStations.id), isNull(evses.retiredAt)))
        .innerJoin(connectors, and(eq(connectors.evseId, evses.id), isNull(connectors.retiredAt)))
        .where(and(eq(chargingStations.siteId, siteId), publicStationListed()))
        .orderBy(chargingStations.stationId, evses.evseId);

      const isContactPublic = site.contactIsPublic;

      return {
        siteId: site.id,
        name: site.name,
        address: site.address,
        city: site.city,
        state: site.state,
        postalCode: site.postalCode,
        latitude: site.latitude,
        longitude: site.longitude,
        hoursOfOperation: site.hoursOfOperation,
        contactName: isContactPublic ? site.contactName : null,
        contactEmail: isContactPublic ? site.contactEmail : null,
        contactPhone: isContactPublic ? site.contactPhone : null,
        stationCount: counts?.stationCount ?? 0,
        evseCount: counts?.evseCount ?? 0,
        availableCount: counts?.availableCount ?? 0,
        chargers,
      };
    },
  );

  app.get(
    '/portal/chargers/location/:siteId/images',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Get driver-visible images for a site',
        operationId: 'portalGetLocationImages',
        security: [],
        params: zodSchema(siteIdParams),
        response: { 200: arrayResponse(portalLocationImage) },
      },
    },
    async (request) => {
      const { siteId } = request.params as z.infer<typeof siteIdParams>;

      const images = await db
        .select({
          id: stationImages.id,
          stationId: stationImages.stationId,
          fileName: stationImages.fileName,
          fileSize: stationImages.fileSize,
          contentType: stationImages.contentType,
          caption: stationImages.caption,
        })
        .from(stationImages)
        .innerJoin(chargingStations, eq(stationImages.stationId, chargingStations.id))
        // Only stations the location page lists: a pending, refused or deleted
        // station's photos stay private.
        .where(
          and(
            eq(chargingStations.siteId, siteId),
            publicStationListed(),
            eq(stationImages.isDriverVisible, true),
          ),
        )
        .orderBy(asc(stationImages.sortOrder), asc(stationImages.id));

      return images;
    },
  );

  app.get(
    '/portal/chargers/location/:siteId/images/:imageId/download-url',
    {
      // Stricter limit on the presigned-URL endpoint than the image-list
      // endpoint because each call issues a new S3 signature operation and
      // could be used to enumerate imageIds.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Get presigned download URL for a driver-visible image',
        operationId: 'portalGetLocationImageDownloadUrl',
        security: [],
        params: zodSchema(imageIdParams),
        response: {
          200: itemResponse(
            z
              .object({
                downloadUrl: z.string().describe('Presigned S3 GET URL valid for a short time'),
              })
              .passthrough(),
          ),
          404: errorWith('Resource not found', [
            ERROR_CODES.IMAGE_NOT_FOUND,
            ERROR_CODES.STORAGE_NOT_CONFIGURED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { siteId, imageId } = request.params as z.infer<typeof imageIdParams>;

      const [image] = await db
        .select({
          id: stationImages.id,
          s3Key: stationImages.s3Key,
          s3Bucket: stationImages.s3Bucket,
          isDriverVisible: stationImages.isDriverVisible,
        })
        .from(stationImages)
        .innerJoin(chargingStations, eq(stationImages.stationId, chargingStations.id))
        .where(
          and(
            eq(stationImages.id, imageId),
            eq(chargingStations.siteId, siteId),
            publicStationListed(),
            eq(stationImages.isDriverVisible, true),
          ),
        );

      if (image == null) {
        await reply.status(404).send({ error: 'Image not found', code: 'IMAGE_NOT_FOUND' });
        return;
      }

      const s3 = await getS3Config();
      if (s3 == null) {
        await reply
          .status(404)
          .send({ error: 'Attachment storage not configured', code: 'STORAGE_NOT_CONFIGURED' });
        return;
      }

      const downloadUrl = await generateDownloadUrl(s3, image.s3Bucket, image.s3Key);
      return { downloadUrl };
    },
  );

  app.get(
    '/portal/chargers/location/:siteId/popular-times',
    {
      // Aggregation query over up to a year of sessions per call; tighter
      // limit than the other location endpoints because each call is
      // measurably more expensive on the database.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Get popular times for a site',
        operationId: 'portalGetLocationPopularTimes',
        security: [],
        params: zodSchema(siteIdParams),
        querystring: zodSchema(popularTimesQuery),
        response: {
          200: arrayResponse(popularTimesItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { siteId } = request.params as z.infer<typeof siteIdParams>;
      const { weeks } = request.query as z.infer<typeof popularTimesQuery>;

      const [site] = await db
        .select({ id: sites.id, timezone: sites.timezone })
        .from(sites)
        .where(and(eq(sites.id, siteId), publicSiteListed()));

      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const tz = site.timezone;
      const since = new Date();
      since.setDate(since.getDate() - weeks * 7);

      // Sessions of conformance (OCTT) stations are not counted.
      const stationIds = db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(and(eq(chargingStations.siteId, siteId), isOperatorStation()));

      const rows = await db
        .select({
          dow: sql<number>`extract(dow from ${chargingSessions.startedAt} at time zone ${tz})::int`,
          hour: sql<number>`extract(hour from ${chargingSessions.startedAt} at time zone ${tz})::int`,
          totalSessions: count(),
        })
        .from(chargingSessions)
        .where(
          and(
            inArray(chargingSessions.stationId, stationIds),
            gte(chargingSessions.startedAt, since),
          ),
        )
        .groupBy(sql`1`, sql`2`)
        .orderBy(sql`1`, sql`2`);

      return rows.map((r) => ({
        dow: r.dow,
        hour: r.hour,
        avgSessions: Math.round((r.totalSessions / weeks) * 10) / 10,
      }));
    },
  );

  app.get(
    '/portal/chargers/:stationId',
    {
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Get station details with all EVSEs and connectors',
        operationId: 'portalGetStationDetail',
        security: [],
        params: zodSchema(stationIdParams),
        response: {
          200: itemResponse(portalStationDetail),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const { stationId } = request.params as z.infer<typeof stationIdParams>;

      const [station] = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          model: chargingStations.model,
          isOnline: chargingStations.isOnline,
          disabledReason: chargingStations.disabledReason,
          firmwareState: chargingStations.firmwareState,
          reportedStatus: chargingStations.reportedStatus,
          isSimulator: chargingStations.isSimulator,
          siteName: sites.name,
          siteAddress: sites.address,
          siteCity: sites.city,
          siteState: sites.state,
          siteContactName: sites.contactName,
          siteContactEmail: sites.contactEmail,
          siteContactPhone: sites.contactPhone,
          siteContactIsPublic: sites.contactIsPublic,
        })
        .from(chargingStations)
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(and(eq(chargingStations.stationId, stationId), publicStationListed()));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const evseRows = await db
        .select({
          id: evses.id,
          evseId: evses.evseId,
          connectorId: connectors.connectorId,
          connectorType: connectors.connectorType,
          maxPowerKw: connectors.maxPowerKw,
          maxCurrentAmps: connectors.maxCurrentAmps,
          connectorStatus: connectors.status,
        })
        .from(evses)
        .leftJoin(connectors, and(eq(connectors.evseId, evses.id), isNull(connectors.retiredAt)))
        .where(and(eq(evses.stationId, station.id), isNull(evses.retiredAt)))
        .orderBy(asc(evses.evseId));

      const evseMap = new Map<
        number,
        {
          evseUuid: string;
          evseId: number;
          connectors: Array<{
            connectorId: number;
            connectorType: string | null;
            maxPowerKw: number | null;
            maxCurrentAmps: number | null;
            status: string;
          }>;
        }
      >();
      for (const row of evseRows) {
        if (!evseMap.has(row.evseId)) {
          evseMap.set(row.evseId, { evseUuid: row.id, evseId: row.evseId, connectors: [] });
        }
        if (row.connectorId != null) {
          const evseEntry = evseMap.get(row.evseId);
          evseEntry?.connectors.push({
            connectorId: row.connectorId,
            connectorType: row.connectorType,
            maxPowerKw: row.maxPowerKw != null ? Number(row.maxPowerKw) : null,
            maxCurrentAmps: row.maxCurrentAmps,
            status: row.connectorStatus ?? 'unavailable',
          });
        }
      }

      // Look up active reservations for ALL EVSEs on the station, not just
      // ones whose connector status currently reads `reserved`. Status flips
      // to `preparing`/`occupied` the moment the holder plugs in but the
      // reservation gate must keep applying until the reservation ends.
      const allEvseUuids = Array.from(evseMap.values()).map((e) => e.evseUuid);

      const reservationExpiryMap = new Map<string, string>();
      const reservationDriverMap = new Map<string, string | null>();
      if (allEvseUuids.length > 0) {
        const activeReservations = await db
          .select({
            evseId: reservations.evseId,
            expiresAt: reservations.expiresAt,
            driverId: reservations.driverId,
          })
          .from(reservations)
          .where(
            and(
              eq(reservations.stationId, station.id),
              or(eq(reservations.status, 'active'), eq(reservations.status, 'scheduled')),
              sql`COALESCE(${reservations.startsAt}, ${reservations.createdAt}) <= NOW()`,
              sql`${reservations.expiresAt} > NOW()`,
            ),
          )
          .orderBy(asc(reservations.expiresAt));

        for (const res of activeReservations) {
          // Station-level reservation (no evseId) applies to every EVSE
          if (res.evseId == null) {
            for (const uuid of allEvseUuids) {
              if (!reservationExpiryMap.has(uuid)) {
                reservationExpiryMap.set(uuid, res.expiresAt.toISOString());
                reservationDriverMap.set(uuid, res.driverId);
              }
            }
          } else if (allEvseUuids.includes(res.evseId)) {
            if (!reservationExpiryMap.has(res.evseId)) {
              reservationExpiryMap.set(res.evseId, res.expiresAt.toISOString());
              reservationDriverMap.set(res.evseId, res.driverId);
            }
          }
        }
      }

      // The holder's id is never returned: the route is public.
      const callerDriverId = reservationDriverMap.size > 0 ? await optionalDriverId(request) : null;
      const paymentProvider = await activePaymentProvider(request.log);

      const isContactPublic = station.siteContactIsPublic === true;
      const maintenance = await getMaintenancePayloadForStation(station.id, request.log);

      return {
        stationId: station.stationId,
        siteId: station.siteId ?? null,
        model: station.model,
        isOnline: station.isOnline,
        isSimulator: station.isSimulator,
        siteName: station.siteName,
        siteAddress: station.siteAddress,
        siteCity: station.siteCity,
        siteState: station.siteState,
        siteContactName: isContactPublic ? station.siteContactName : null,
        siteContactEmail: isContactPublic ? station.siteContactEmail : null,
        siteContactPhone: isContactPublic ? station.siteContactPhone : null,
        paymentEnabled: paymentProvider != null,
        evses: Array.from(evseMap.values()).map((e) => ({
          evseId: e.evseId,
          connectors: e.connectors,
          reservationExpiresAt: reservationExpiryMap.get(e.evseUuid) ?? null,
          reserved: reservationExpiryMap.has(e.evseUuid),
          reservedByMe:
            callerDriverId != null && reservationDriverMap.get(e.evseUuid) === callerDriverId,
        })),
        maintenance,
        stationUnavailable: isStationLevelUnavailable(station),
      };
    },
  );

  app.post(
    '/portal/chargers/:stationId/evse/:evseId/check-status',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Check connector status via TriggerMessage',
        description:
          'Dispatches OCPP TriggerMessage(StatusNotification) and waits up to 10s for the station to report fresh connector status. Used by the portal pre-start flow to detect cable presence before remote start. Per-station rate limited (5/min).',
        operationId: 'portalCheckConnectorStatus',
        security: [{ bearerAuth: [] }],
        params: zodSchema(chargerParams),
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
      const { stationId, evseId } = request.params as z.infer<typeof chargerParams>;

      // Resolve station
      const [station] = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          isOnline: chargingStations.isOnline,
          ocppProtocol: chargingStations.ocppProtocol,
        })
        .from(chargingStations)
        .where(and(eq(chargingStations.stationId, stationId), publicStationListed()));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      if (!station.isOnline) {
        await sendStatusCheckError(reply, 'STATION_OFFLINE');
        return;
      }

      // Serve a recent cached status before charging the per-station rate
      // limit so concurrent drivers at the same site share one TriggerMessage
      // dispatch instead of locking each other out at 5 calls/min.
      const cached = getCachedConnectorStatus(stationId, evseId);
      if (cached != null) {
        if (cached.errorCode != null) {
          await sendStatusCheckError(reply, cached.errorCode);
          return;
        }
        return { connectorStatus: cached.status };
      }

      // Rate limit per station (OCPP-protection layer). Only counted when no
      // cache is available, so well-behaved drivers riding the cache do not
      // consume the budget.
      if (isStationCheckRateLimited(stationId)) {
        await reply
          .status(429)
          .send({ error: 'Too many status checks for this station', code: 'RATE_LIMITED' });
        return;
      }

      // Find the first connector on this EVSE
      const connectorRows = await db.execute<{ connector_id: number }>(
        sql`SELECT c.connector_id FROM connectors c
            JOIN evses e ON c.evse_id = e.id
            WHERE e.station_id = ${station.id} AND e.evse_id = ${evseId}
              AND e.retired_at IS NULL AND c.retired_at IS NULL
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

  app.post(
    '/portal/chargers/:stationId/evse/:evseId/start',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Start a charging session on a charger EVSE',
        description:
          'Validates connector availability, performs a fail-fast pre-authorization with the active payment provider on the supplied payment method (skipped for free tariffs and for drivers whose fleet bills on account, who need no payment method), then dispatches RequestStartTransaction (OCPP 2.1) or RemoteStartTransaction (OCPP 1.6) to the station. On TxInProgress rejection, attempts ghost-transaction recovery (RequestStop + retry). Returns 402 PAYMENT_PREAUTH_FAILED if the card is declined, 402 FLEET_CREDIT_LIMIT_REACHED when the billing fleet of the driver is at its credit limit, 400 if the connector is not in a startable state, 502/504 on station rejection or timeout.',
        operationId: 'portalStartCharging',
        security: [{ bearerAuth: [] }],
        params: zodSchema(chargerParams),
        body: zodSchema(startChargingBody),
        response: {
          200: itemResponse(startChargingResponse),
          400: errorWith('Bad request', [
            ERROR_CODES.CONNECTOR_NOT_AVAILABLE,
            ERROR_CODES.PAYMENT_METHOD_REQUIRED,
            ERROR_CODES.SESSION_ALREADY_ACTIVE,
            ERROR_CODES.STATION_OFFLINE,
          ]),
          402: errorWith('Payment required', [
            ERROR_CODES.FLEET_CREDIT_LIMIT_REACHED,
            ERROR_CODES.PAYMENT_PREAUTH_FAILED,
          ]),
          403: errorWith('Forbidden', [
            ERROR_CODES.CONNECTOR_RESERVED,
            ERROR_CODES.STATION_OFFLINE,
          ]),
          404: errorWith('Resource not found', [
            ERROR_CODES.EVSE_NOT_FOUND,
            ERROR_CODES.PAYMENT_METHOD_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
          409: errorWith('Conflict', [
            ERROR_CODES.EVSE_IN_USE,
            ERROR_CODES.RESERVATION_BUFFER_ACTIVE,
            ERROR_CODES.MAINTENANCE_ACTIVE,
            ERROR_CODES.STATION_UNAVAILABLE,
          ]),
          500: errorWith('Internal server error', [
            ERROR_CODES.INTERNAL_ERROR,
            ERROR_CODES.SESSION_CREATE_FAILED,
          ]),
          502: errorWith('Start rejected', [ERROR_CODES.START_REJECTED]),
          504: errorWith('Station timeout', [ERROR_CODES.STATION_TIMEOUT]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const params = request.params as z.infer<typeof chargerParams>;
      const body = request.body as z.infer<typeof startChargingBody>;

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
          freeVendEnabled: sites.freeVendEnabled,
        })
        .from(chargingStations)
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        // A pending or blocked station answers like an unknown one.
        .where(and(eq(chargingStations.stationId, params.stationId), publicStationListed()));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Second layer (P11): the onboarding gate runs before any other state.
      if (!(await checkStationOnboarded(station, reply))) return;

      const activeMaintenance = await getActiveMaintenanceForStation(station.id);
      if (activeMaintenance != null) {
        await reply.status(409).send({
          error: 'Site is currently under maintenance',
          code: 'MAINTENANCE_ACTIVE',
          plannedEndAt: activeMaintenance.plannedEndAt.toISOString(),
        });
        return;
      }

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

      // Check EVSE availability via connector status
      const [evse] = await db
        .select({ id: evses.id })
        .from(evses)
        .where(
          and(
            eq(evses.stationId, station.id),
            eq(evses.evseId, params.evseId),
            isNull(evses.retiredAt),
          ),
        );

      if (evse == null) {
        await reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
        return;
      }

      const [connector] = await db
        .select({ status: connectors.status })
        .from(connectors)
        .where(and(eq(connectors.evseId, evse.id), isNull(connectors.retiredAt)))
        .limit(1);

      // Reservation gate first: if any active reservation covers this EVSE,
      // ONLY the reservation holder may start, regardless of connector
      // status. The connector legitimately flips to `preparing` /
      // `occupied` / `ev_connected` the moment the holder plugs in, but
      // those statuses are also "startable" in the generic sense, so
      // without this check any other driver (or guest) could race the
      // reservation holder and start a session against the holder&#39;s plug.
      const [activeReservation] = await db
        .select({
          id: reservations.id,
          driverId: reservations.driverId,
          tokenId: reservations.tokenId,
          status: reservations.status,
        })
        .from(reservations)
        .where(
          and(
            eq(reservations.stationId, station.id),
            or(eq(reservations.evseId, evse.id), sql`${reservations.evseId} IS NULL`),
            or(eq(reservations.status, 'active'), eq(reservations.status, 'scheduled')),
            // Block holder/non-holder only when the reservation window is current.
            // A scheduled reservation for tomorrow must not block other drivers today.
            sql`COALESCE(${reservations.startsAt}, ${reservations.createdAt}) <= NOW()`,
            sql`${reservations.expiresAt} > NOW()`,
          ),
        )
        .orderBy(asc(reservations.expiresAt))
        .limit(1);

      if (activeReservation != null && activeReservation.driverId !== driverId) {
        await reply.status(403).send({
          error: 'Connector is reserved for another driver',
          code: 'CONNECTOR_RESERVED',
        });
        return;
      }

      // 'finishing' (OCPP 1.6) means cable is still plugged after a previous
      // stop; real stations accept a new RemoteStart from this state. The
      // OCPP 2.1 equivalent is 'occupied' which is already in the set.
      // 'reserved' is allowed when we got past the gate above (i.e., the
      // requesting driver IS the holder).
      const startableStatuses = ['available', 'occupied', 'preparing', 'ev_connected', 'finishing'];
      if (
        connector != null &&
        !startableStatuses.includes(connector.status) &&
        !(connector.status === 'reserved' && activeReservation?.driverId === driverId)
      ) {
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
      // One exception: an OCPP 2.1 transaction the station started at plug-in
      // (cable first, TxStartPoint EVConnected) that still waits for its
      // authorization. This start takes it over (F01: the station answers
      // with that transaction and links it by the remoteStartId).
      const [evseActiveSession] = await db
        .select({ id: chargingSessions.id })
        .from(chargingSessions)
        .where(and(eq(chargingSessions.evseId, evse.id), eq(chargingSessions.status, 'active')))
        .limit(1);
      let waitingSessionId: string | null = null;
      if (evseActiveSession != null && station.ocppProtocol !== 'ocpp1.6') {
        const [waiting] = await db
          .select({ id: chargingSessions.id })
          .from(chargingSessions)
          .where(and(eq(chargingSessions.id, evseActiveSession.id), awaitingAuthorization()));
        waitingSessionId = waiting?.id ?? null;
      }
      if (evseActiveSession != null && waitingSessionId == null) {
        await reply.status(409).send({
          error: 'Another session is already active on this connector',
          code: 'EVSE_IN_USE',
        });
        return;
      }

      // Check for existing active session for this driver
      const [existingSession] = await db
        .select({ id: chargingSessions.id })
        .from(chargingSessions)
        .where(and(eq(chargingSessions.driverId, driverId), eq(chargingSessions.status, 'active')))
        .limit(1);

      if (existingSession != null) {
        await reply.status(400).send({
          error: 'You already have an active charging session',
          code: 'SESSION_ALREADY_ACTIVE',
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

      // Pre-auth runs below after session creation so a card decline fails
      // the start request immediately (returning 402) instead of letting the
      // station begin charging and the event-projection payment gate stop it
      // asynchronously.
      const paymentProvider = await activePaymentProvider(request.log);

      // Charge on account: a driver whose fleet bills on account needs no card
      // and gets no hold, with or without a payment provider. Free vend comes
      // first (nothing is billed, no stamp); the session is stamped below.
      const freeVend = station.freeVendEnabled === true;
      const accountBilling = freeVend ? null : await resolveAccountBilling(client, driverId);

      // Fleet credit limit: an account start is refused while the fleet has
      // no credit left (its exposure at or above the limit, or its running
      // sessions reserving the rest, plan S8), read under the fleet row lock.
      // The payment gate checks again at Started and reserves the session's
      // ceiling (P11).
      // The fleet's warning and reached notices go out once per month,
      // fail-open (P9).
      if (accountBilling != null) {
        const credit = await checkFleetCreditLimit(client, accountBilling.fleetId);
        if (credit != null && credit.level !== 'ok') {
          void dispatchFleetCreditLimitNotices(
            credit,
            { templatesDirs: ALL_TEMPLATES_DIRS },
            request.log,
          );
        }
        if (credit != null && (credit.level === 'reached' || credit.remainingCents <= 0)) {
          await reply.status(402).send({
            error:
              'The credit limit of the fleet your sessions are billed to is reached. Contact your fleet manager.',
            code: 'FLEET_CREDIT_LIMIT_REACHED',
          });
          return;
        }
      }

      let pmForPreAuth: { id: number } | null = null;

      if (paymentProvider != null && accountBilling == null) {
        // Check if pricing is free for this driver. Free-vend wins over the
        // tariff lookup: event-projections skips the payment gate for
        // free-vend sites, so demanding a payment method here would block
        // drivers from starting at a free-vend site that happens to have a
        // paid tariff assigned.
        // The holder of the active reservation pays its holding fee, so a
        // reservation fee makes their charging paid.
        const chargingIsFree = await isStationChargingFree(
          {
            stationUuid: station.id,
            driverUuid: driverId,
            reserved: activeReservation?.driverId === driverId,
            freeVend,
          },
          client,
        );

        if (!chargingIsFree) {
          // Payment is required -- validate the driver has a payment method
          if (body.paymentMethodId == null) {
            await reply.status(400).send({
              error: 'Payment method required',
              code: 'PAYMENT_METHOD_REQUIRED',
            });
            return;
          }

          // Verify payment method belongs to driver
          const [pmRow] = await db
            .select({ id: driverPaymentMethods.id })
            .from(driverPaymentMethods)
            .where(
              and(
                eq(driverPaymentMethods.id, body.paymentMethodId),
                eq(driverPaymentMethods.driverId, driverId),
              ),
            );

          if (pmRow == null) {
            await reply.status(404).send({
              error: 'Payment method not found',
              code: 'PAYMENT_METHOD_NOT_FOUND',
            });
            return;
          }
          pmForPreAuth = pmRow;
        }
      }

      // The starter's own current hold on this EVSE (or a station-wide one):
      // the session carries it, so the hold is consumed instead of billed as
      // a no-show when the station's Started does not echo the reservation
      // id (G12). The gate above found it: active, inside its window.
      const heldReservationId =
        activeReservation != null &&
        activeReservation.driverId === driverId &&
        activeReservation.status === 'active'
          ? activeReservation.id
          : null;
      // The start of a held reservation carries the token the hold was made
      // for (the one ReserveNow sent): a station enforcing the hold (OCPP H01)
      // refuses any other with ReservedForOtherToken. Without a hold, the
      // driver id as a Central token.
      const startIdToken =
        heldReservationId != null && activeReservation != null
          ? (await reserveNowToken({ tokenId: activeReservation.tokenId, driverId })).idToken
          : { idToken: driverId, type: 'Central' };

      // Create session first so event projection can match via remote_start_id
      const remoteStartId = Math.floor(Math.random() * 2_147_483_647);
      // A taken-over transaction keeps its id (see the takeover below).
      let transactionId = '';
      if (waitingSessionId == null && station.ocppProtocol === 'ocpp1.6') {
        // The sequence is the only source of 1.6 transaction ids: a made-up id
        // could collide with another session, so a failed read fails the start
        // before any session or hold exists.
        let nextval: string | undefined;
        try {
          const [row] = await db.execute<{ nextval: string }>(
            sql`SELECT nextval('ocpp16_transaction_id_seq')`,
          );
          nextval = row?.nextval;
          if (nextval == null) throw new Error('ocpp16_transaction_id_seq returned no value');
        } catch (err) {
          request.log.error(
            { err, stationId: station.stationId },
            'Portal start: could not allocate an OCPP 1.6 transaction id',
          );
        }
        if (nextval == null) {
          await reply
            .status(500)
            .send({ error: 'Failed to create session', code: 'SESSION_CREATE_FAILED' });
          return;
        }
        transactionId = nextval;
      } else if (waitingSessionId == null) {
        transactionId = crypto.randomUUID();
      }

      // One currency for the session row, the pre-auth, and its payment record.
      const sessionCurrency = await getCompanyCurrency();
      // A waiting cable-first transaction is taken over: the driver, the
      // remote start id and the billing stamp go on its session, only while
      // it still waits (a concurrent start or an idToken presented at the
      // station wins), so the hold and the link land on the session that
      // charges. Its transaction, currency and tariff snapshot stay; the
      // projection links the driver and reprices it for the driver when the
      // station reports the remote start (linkFirstPresentedToken).
      const sessionRows =
        waitingSessionId != null
          ? await db
              .update(chargingSessions)
              .set({
                driverId,
                remoteStartId,
                ...(heldReservationId != null ? { reservationId: heldReservationId } : {}),
                ...(freeVend ? {} : sessionBillingColumns(accountBilling)),
                updatedAt: new Date(),
              })
              .where(and(eq(chargingSessions.id, waitingSessionId), awaitingAuthorization()))
              .returning({ id: chargingSessions.id, transactionId: chargingSessions.transactionId })
          : await db
              .insert(chargingSessions)
              .values({
                stationId: station.id,
                siteId: sessionSiteIdSql(sql, station.id),
                evseId: evse.id,
                driverId,
                transactionId,
                status: 'active',
                startedAt: new Date(),
                remoteStartId,
                reservationId: heldReservationId,
                currency: sessionCurrency,
                // Write-once billing stamp (the gate keeps it): card or account.
                ...(freeVend ? {} : sessionBillingColumns(accountBilling)),
              })
              .returning({
                id: chargingSessions.id,
                transactionId: chargingSessions.transactionId,
              });

      const session = sessionRows[0];
      if (session == null && waitingSessionId != null) {
        await reply.status(409).send({
          error: 'Another session is already active on this connector',
          code: 'EVSE_IN_USE',
        });
        return;
      }
      if (session == null) {
        await reply
          .status(500)
          .send({ error: 'Failed to create session', code: 'SESSION_CREATE_FAILED' });
        return;
      }

      // A start that fails after taking over a waiting transaction ends it the
      // way the payment gate ends a session it stops: the session row is
      // closed first (above each call, P4), then the station is asked to stop
      // the transaction (fire-and-forget, a lost publish is logged, P9). The
      // session's payment record keys to it, so it cannot wait for another
      // driver.
      const tookOver = waitingSessionId != null;
      const stopTakenOverTransaction = async (): Promise<void> => {
        if (!tookOver) return;
        try {
          await publishOcppCommand(getPubSub(), {
            stationId: station.stationId,
            action: 'RequestStopTransaction',
            payload: { transactionId: session.transactionId },
          });
        } catch (err) {
          request.log.warn(
            { err, sessionId: session.id },
            'Failed to request the stop of a taken-over transaction',
          );
        }
      };

      // Fail-fast pre-auth: hold the card BEFORE telling the station to start
      // so a decline shortcuts to 402 without leaving a ghost session. Skipped
      // for free charging. The hold is recorded `pre_authorized` under the key
      // preauth_<sessionId>, so the projection's gate finds it and skips. A
      // hold whose record cannot be written is cancelled by the service.
      if (pmForPreAuth != null) {
        const hold = await authorizeSessionHold(
          {
            sessionId: session.id,
            driverId,
            methodRowId: pmForPreAuth.id,
            siteId: station.siteId ?? null,
            trigger: 'portal_start',
          },
          paymentContext(request.log, getAuditActor(request)),
        );
        if (hold.outcome === 'declined' || hold.outcome === 'record_failed') {
          const declined = hold.outcome === 'declined';
          await db
            .update(chargingSessions)
            .set({
              status: 'failed',
              stoppedReason: declined ? 'PreAuthDeclined' : 'PreAuthRecordFailed',
              endedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(chargingSessions.id, session.id));
          await stopTakenOverTransaction();
          if (declined) {
            await reply.status(402).send({
              error: `Payment authorization declined: ${hold.reason}`,
              code: 'PAYMENT_PREAUTH_FAILED',
            });
          } else {
            await reply.status(500).send({
              error: 'Failed to record payment authorization',
              code: 'INTERNAL_ERROR',
            });
          }
          return;
        }
        if (hold.outcome === 'not_configured') {
          // The card is saved with a provider this process cannot use; the
          // projection's gate applies the same rule when the station starts.
          request.log.warn(
            { sessionId: session.id, providerId: hold.providerId },
            'Payment provider of the card not configured; session not pre-authorized',
          );
        }
      }

      // Send RequestStartTransaction and wait for station response
      const cmdResult = await sendOcppCommandAndWait(station.stationId, 'RequestStartTransaction', {
        evseId: params.evseId,
        remoteStartId,
        idToken: startIdToken,
      });
      await recordStationCommandAudit(
        {
          stationId: station.id,
          actor: getAuditActor(request),
          command: 'RequestStartTransaction',
          sessionId: session.id,
          evseId: params.evseId,
          outcome: commandOutcome(cmdResult),
        },
        request.log,
      );

      // A start the station did not answer or rejected is closed the way the
      // remote start timeout job closes one (failUnstartedRemoteSession): only
      // while the session is still active and no transaction reached it (P5),
      // ended now at zero cost (P4); then its hold is released. A taken-over
      // waiting transaction already has its events: it is faulted under the
      // same guard and the station is asked to stop it. Returns 'started' when
      // the station's Started reached the session first (it is charging),
      // 'closed' when this call closed it, 'already_closed' otherwise.
      const closeFailedStart = async (
        stoppedReason: string,
        holdReason: string,
      ): Promise<'started' | 'closed' | 'already_closed'> => {
        let closed = false;
        if (!tookOver) {
          const result = await failUnstartedRemoteSession(session.id, stoppedReason);
          if (result.outcome === 'skipped') return 'started';
          closed = result.outcome === 'failed';
        } else {
          const now = new Date();
          const faulted = await db
            .update(chargingSessions)
            .set({
              status: 'faulted',
              stoppedReason,
              endedAt: now,
              finalCostCents: 0,
              currentCostCents: 0,
              updatedAt: now,
            })
            .where(and(eq(chargingSessions.id, session.id), eq(chargingSessions.status, 'active')))
            .returning({ id: chargingSessions.id });
          closed = faulted.length > 0;
          if (closed) await stopTakenOverTransaction();
        }
        // The station will not start: the hold placed above is released now
        // instead of staying open until the provider expires it (P4). Best
        // effort (P9): the start already failed for the driver.
        try {
          await cancelOpenSessionHold(
            session.id,
            holdReason,
            paymentContext(request.log, getAuditActor(request)),
          );
        } catch (err) {
          request.log.warn(
            { err, sessionId: session.id },
            'Failed to cancel the hold of a failed start',
          );
        }
        return closed ? 'closed' : 'already_closed';
      };

      if (cmdResult.error != null) {
        const outcome = await closeFailedStart(
          REMOTE_START_TIMEOUT_REASON,
          'Station did not answer the start',
        );
        if (outcome === 'started') {
          // The station's Started arrived before its answer: the session runs.
          request.log.info(
            { sessionId: session.id, stationId: station.stationId },
            'Portal start: no answer from the station, but its transaction started',
          );
          return { chargingSessionId: session.id };
        }
        if (outcome === 'closed') {
          await writeCsmsSessionAudit(
            {
              sessionId: session.id,
              // The audit action enum names every CSMS-side close `faulted`;
              // `after` holds the status written.
              action: 'faulted',
              actor: 'system',
              actorLabel: 'portal-start-timeout',
              before: { status: 'active' },
              after: {
                status: tookOver ? 'faulted' : 'failed',
                stoppedReason: REMOTE_START_TIMEOUT_REASON,
              },
              notes: 'Station did not answer RequestStartTransaction',
            },
            db,
            request.log,
          );
          void dispatchDriverNotification(
            client,
            'session.Faulted',
            driverId,
            { stationId: station.stationId, reason: 'Station did not respond' },
            ALL_TEMPLATES_DIRS,
            getPubSub(),
          );
        }
        await reply.status(504).send({ error: 'Station did not respond', code: 'STATION_TIMEOUT' });
        return;
      }

      const cmdStatus = cmdResult.response?.['status'] as string | undefined;
      if (cmdStatus !== 'Accepted') {
        // TxInProgress recovery: station has a ghost transaction the CSMS doesn't know about
        const statusInfo = cmdResult.response?.['statusInfo'] as
          | { reasonCode?: string; additionalInfo?: string }
          | undefined;
        // A taken-over transaction is the one in progress, never a ghost.
        const isTxInProgress = !tookOver && statusInfo?.reasonCode === 'TxInProgress';

        if (isTxInProgress) {
          const ghostTxId =
            statusInfo.additionalInfo ??
            (cmdResult.response?.['transactionId'] as string | undefined);

          // Check if we have an active session on this EVSE in the CSMS
          const [evseActiveSession] = await db
            .select({ id: chargingSessions.id })
            .from(chargingSessions)
            .where(
              and(
                eq(chargingSessions.evseId, evse.id),
                eq(chargingSessions.status, 'active'),
                sql`${chargingSessions.id} != ${session.id}`,
              ),
            )
            .limit(1);

          if (evseActiveSession == null) {
            // No active CSMS session on this EVSE -- it is a ghost transaction
            request.log.info(
              { ghostTxId: ghostTxId ?? 'unknown', stationId: station.stationId },
              'TxInProgress recovery: ghost transaction detected',
            );

            // If we have the transaction ID, stop the ghost transaction first
            if (ghostTxId != null) {
              await sendOcppCommandAndWait(station.stationId, 'RequestStopTransaction', {
                transactionId: ghostTxId,
              });
            }

            // Wait for the station to finish cleaning up, then retry
            await new Promise((resolve) => setTimeout(resolve, 5000));

            const retryResult = await sendOcppCommandAndWait(
              station.stationId,
              'RequestStartTransaction',
              {
                evseId: params.evseId,
                remoteStartId,
                idToken: startIdToken,
              },
            );

            const retryStatus = retryResult.response?.['status'] as string | undefined;
            if (retryStatus === 'Accepted') {
              request.log.info(
                { stationId: station.stationId },
                'TxInProgress recovery: retry succeeded',
              );
              await scheduleRemoteStartTimeout(
                { kind: 'session', sessionId: session.id },
                station,
                request.log,
              );
              return { chargingSessionId: session.id };
            }
            // Retry failed, fall through to fault the session
          }
        }

        const reason = `Station rejected: ${cmdStatus ?? 'Unknown'}`;
        const outcome = await closeFailedStart(
          REMOTE_START_REJECTED_REASON,
          `Station rejected the start: ${cmdStatus ?? 'Unknown'}`,
        );
        if (outcome === 'started') {
          // A transaction reached the session although the station answered
          // Rejected: the session is charging, so the start succeeded.
          request.log.warn(
            { sessionId: session.id, stationId: station.stationId, cmdStatus },
            'Portal start: the station rejected the start, but its transaction started',
          );
          return { chargingSessionId: session.id };
        }
        if (outcome === 'closed') {
          await writeCsmsSessionAudit(
            {
              sessionId: session.id,
              // The audit action enum names every CSMS-side close `faulted`;
              // `after` holds the status written.
              action: 'faulted',
              actor: 'system',
              actorLabel: 'portal-start-rejected',
              before: { status: 'active' },
              after: {
                status: tookOver ? 'faulted' : 'failed',
                stoppedReason: REMOTE_START_REJECTED_REASON,
              },
              notes: `Station rejected RequestStartTransaction: ${cmdStatus ?? 'Unknown'}`,
            },
            db,
            request.log,
          );
          void dispatchDriverNotification(
            client,
            'session.Faulted',
            driverId,
            { stationId: station.stationId, reason },
            ALL_TEMPLATES_DIRS,
            getPubSub(),
          );
        }
        await reply.status(502).send({
          error: `Station rejected start request: ${cmdStatus ?? 'Unknown'}`,
          code: 'START_REJECTED',
        });
        return;
      }

      await scheduleRemoteStartTimeout(
        { kind: 'session', sessionId: session.id },
        station,
        request.log,
      );
      return { chargingSessionId: session.id };
    },
  );

  app.get(
    '/portal/chargers/sessions/active',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Chargers'],
        summary: 'List active charging sessions for the driver',
        operationId: 'portalListActiveSessions',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(
            z
              .object({
                data: z
                  .array(activeSessionItem)
                  .describe('Active charging sessions for the authenticated driver'),
              })
              .passthrough(),
          ),
        },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;

      const sessions = await db
        .select({
          id: chargingSessions.id,
          stationId: chargingStations.stationId,
          stationName: chargingStations.model,
          transactionId: chargingSessions.transactionId,
          startedAt: chargingSessions.startedAt,
          energyDeliveredWh: chargingSessions.energyDeliveredWh,
          currentCostCents: chargingSessions.currentCostCents,
          currency: sessionCurrencySql(),
        })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .where(
          and(
            eq(chargingSessions.driverId, driverId),
            eq(chargingSessions.status, 'active'),
            isOperatorStation(),
          ),
        );

      return { data: sessions };
    },
  );

  app.post(
    '/portal/chargers/sessions/:sessionId/stop',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Stop an active charging session',
        description:
          'Sends RequestStopTransaction (OCPP 2.1) or RemoteStopTransaction (OCPP 1.6) for the supplied sessionId and waits up to 35s for the station response. If the station rejects with reasonCode=TxNotFound (a "ghost session"), the API asks the OCPP server to end the session as completed and billed at its last metered energy, and returns status=ghostRecovered. Returns 404 if the session does not exist or is not owned by the driver, 409 SESSION_STOP_REJECTED if the station rejects the stop (the session keeps charging), 409 STATION_OFFLINE if the station is not connected (the stop is sent when it reconnects), 504 if the station does not respond within the timeout window.',
        operationId: 'portalStopSession',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionIdParams),
        response: {
          200: itemResponse(stopSessionResponse),
          404: errorWith('Session not found', [ERROR_CODES.SESSION_NOT_FOUND]),
          409: errorWith('Station rejected the stop or is offline', [
            ERROR_CODES.SESSION_STOP_REJECTED,
            ERROR_CODES.STATION_OFFLINE,
          ]),
          504: errorWith('Station timeout', [ERROR_CODES.STATION_TIMEOUT]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { sessionId } = request.params as z.infer<typeof sessionIdParams>;

      const [session] = await db
        .select({
          id: chargingSessions.id,
          transactionId: chargingSessions.transactionId,
          stationDbId: chargingStations.id,
          stationOcppId: chargingStations.stationId,
          ocppProtocol: chargingStations.ocppProtocol,
        })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .where(
          and(
            eq(chargingSessions.id, sessionId),
            eq(chargingSessions.driverId, driverId),
            eq(chargingSessions.status, 'active'),
          ),
        );

      if (session == null) {
        await reply.status(404).send({
          error: 'Active session not found',
          code: 'SESSION_NOT_FOUND',
        });
        return;
      }

      const cmdResult = await sendOcppCommandAndWait(
        session.stationOcppId,
        'RequestStopTransaction',
        { transactionId: session.transactionId },
      );
      await recordStationCommandAudit(
        {
          stationId: session.stationDbId,
          actor: getAuditActor(request),
          command: 'RequestStopTransaction',
          sessionId: session.id,
          outcome: commandOutcome(cmdResult),
        },
        request.log,
      );

      if (cmdResult.queued === true) {
        // The OCPP server holds the stop in the offline command queue and
        // sends it when the station reconnects: the session keeps running
        // until then.
        await reply.status(409).send({
          error: 'Station is offline; the stop is sent when it reconnects',
          code: 'STATION_OFFLINE',
        });
        return;
      }

      if (cmdResult.error != null) {
        await reply.status(504).send({ error: 'Station did not respond', code: 'STATION_TIMEOUT' });
        return;
      }

      const status = cmdResult.response?.['status'] as string | undefined;
      const statusInfo = cmdResult.response?.['statusInfo'] as { reasonCode?: string } | undefined;
      const isGhost = status === 'Rejected' && statusInfo?.reasonCode === 'TxNotFound';

      if (isGhost) {
        // Ghost session: ended completed and billed by the OCPP server, as on the
        // operator stop (the station has no record of the transaction).
        await requestSessionEnd(session.id, 'GhostRecovered', request.log);
        request.log.info(
          { sessionId: session.id, transactionId: session.transactionId },
          'Ghost session recovered: station returned TxNotFound, session end requested',
        );
        return { status: 'ghostRecovered', chargingSessionId: session.id };
      }

      if (status !== 'Accepted') {
        // The station refused the stop (2.1 RequestStopTransaction or 1.6
        // RemoteStopTransaction Rejected): the session keeps charging, so the
        // driver must not be told it is stopping.
        await reply.status(409).send({
          error: `Station rejected the stop request: ${status ?? 'Unknown'}`,
          code: 'SESSION_STOP_REJECTED',
        });
        return;
      }

      return { status: 'stopping', chargingSessionId: session.id };
    },
  );

  // Driver reservations

  app.get(
    '/portal/reservations',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Chargers'],
        summary: 'List reservations for the driver',
        operationId: 'portalListReservations',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(
            z
              .object({
                data: z
                  .array(reservationItem)
                  .describe('Reservations for the authenticated driver, newest first'),
              })
              .passthrough(),
          ),
        },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;

      const rows = await db
        .select({
          id: reservations.id,
          reservationId: reservations.reservationId,
          stationOcppId: chargingStations.stationId,
          status: reservations.status,
          startsAt: reservations.startsAt,
          expiresAt: reservations.expiresAt,
          createdAt: reservations.createdAt,
          stationDbId: reservations.stationId,
          feeTaxBasis: reservations.feeTaxBasis,
          feeTaxRate: reservations.feeTaxRate,
          feePerMinute: reservations.feePerMinute,
          feeCancellationCents: reservations.feeCancellationCents,
        })
        .from(reservations)
        .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
        .where(and(eq(reservations.driverId, driverId), isOperatorStation()))
        .orderBy(desc(reservations.createdAt), desc(reservations.id))
        .limit(50);

      return {
        data: await Promise.all(
          rows.map(async (r) => ({
            id: r.id,
            reservationId: r.reservationId,
            stationOcppId: r.stationOcppId,
            status: r.status,
            startsAt: r.startsAt,
            expiresAt: r.expiresAt,
            createdAt: r.createdAt,
            ...(await reservationFeesView(
              { ...r, stationId: r.stationDbId, driverId },
              request.log,
            )),
          })),
        ),
      };
    },
  );

  app.get(
    '/portal/reservations/:id',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Get a reservation by id with linked session for used reservations',
        operationId: 'portalGetReservation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(reservationIdParams),
        response: {
          200: itemResponse(reservationDetail),
          404: errorWith('Reservation not found', [ERROR_CODES.RESERVATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof reservationIdParams>;

      const [reservation] = await db
        .select({
          id: reservations.id,
          reservationId: reservations.reservationId,
          stationOcppId: chargingStations.stationId,
          siteName: sites.name,
          siteAddress: sites.address,
          siteCity: sites.city,
          siteState: sites.state,
          evseDbId: reservations.evseId,
          status: reservations.status,
          startsAt: reservations.startsAt,
          expiresAt: reservations.expiresAt,
          createdAt: reservations.createdAt,
          updatedAt: reservations.updatedAt,
          stationDbId: reservations.stationId,
          feeTaxBasis: reservations.feeTaxBasis,
          feeTaxRate: reservations.feeTaxRate,
          feePerMinute: reservations.feePerMinute,
          feeCancellationCents: reservations.feeCancellationCents,
        })
        .from(reservations)
        .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(and(eq(reservations.id, id), eq(reservations.driverId, driverId)));

      if (reservation == null) {
        await reply
          .status(404)
          .send({ error: 'Reservation not found', code: 'RESERVATION_NOT_FOUND' });
        return;
      }

      let evseIdInt: number | null = null;
      if (reservation.evseDbId != null) {
        const [evseRow] = await db
          .select({ evseId: evses.evseId })
          .from(evses)
          .where(eq(evses.id, reservation.evseDbId));
        evseIdInt = evseRow?.evseId ?? null;
      }

      // The OCPP TransactionEvent.Started projection links a session back to the
      // reservation when the station echoes the reservationId. Surface that link
      // only for terminal/used reservations so active drivers can see the receipt.
      let sessionId: string | null = null;
      if (reservation.status === 'used') {
        const [sessionRow] = await db
          .select({ id: chargingSessions.id })
          .from(chargingSessions)
          .where(eq(chargingSessions.reservationId, reservation.id))
          .orderBy(desc(chargingSessions.startedAt))
          .limit(1);
        sessionId = sessionRow?.id ?? null;
      }

      return {
        id: reservation.id,
        reservationId: reservation.reservationId,
        stationOcppId: reservation.stationOcppId,
        siteName: reservation.siteName,
        siteAddress: reservation.siteAddress,
        siteCity: reservation.siteCity,
        siteState: reservation.siteState,
        evseId: evseIdInt,
        status: reservation.status,
        startsAt: reservation.startsAt,
        expiresAt: reservation.expiresAt,
        createdAt: reservation.createdAt,
        updatedAt: reservation.updatedAt,
        sessionId,
        ...(await reservationFeesView(
          { ...reservation, stationId: reservation.stationDbId, driverId },
          request.log,
        )),
      };
    },
  );

  app.post(
    '/portal/reservations',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Create a reservation on a station',
        description:
          "Creates a reservation owned by the authenticated driver. Future-dated reservations are persisted as scheduled and activated by a delayed worker job at startsAt. An immediate reservation sends ReserveNow with the driver's token and waits for the station: a refusal or a failed send answers 502 RESERVATION_REJECTED, no answer 504 RESERVATION_TIMEOUT, and the reservation is cancelled without a fee. Requires a default payment method to cover potential cancellation fees. Returns 409 on EVSE/time conflict; of two concurrent creates for one window only one succeeds.",
        operationId: 'portalCreateReservation',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createDriverReservationBody),
        response: {
          200: itemResponse(reservationCreated),
          400: errorWith('Bad request', [
            ERROR_CODES.PAYMENT_METHOD_REQUIRED,
            ERROR_CODES.RESERVATION_EXPIRES_TOO_SOON,
            ERROR_CODES.RESERVATION_STARTS_IN_PAST,
            ERROR_CODES.RESERVATION_TOO_LONG,
            ERROR_CODES.RESERVATION_WINDOW_TOO_SHORT,
            ERROR_CODES.STATION_OFFLINE,
          ]),
          403: errorWith('Forbidden', [ERROR_CODES.FORBIDDEN, ERROR_CODES.RESERVATION_DISABLED]),
          404: errorWith('Resource not found', [
            ERROR_CODES.EVSE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
          409: errorWith('Conflict', [
            ERROR_CODES.EVSE_IN_USE,
            ERROR_CODES.RESERVATION_CONFLICT,
            ERROR_CODES.RESERVATION_DURING_MAINTENANCE,
            ERROR_CODES.STATION_UNAVAILABLE,
          ]),
          500: errorWith('Reservation create failed', [ERROR_CODES.RESERVATION_CREATE_FAILED]),
          502: errorWith('Station rejected the reservation or the command could not be sent', [
            ERROR_CODES.RESERVATION_REJECTED,
          ]),
          504: errorWith('Station did not respond within timeout', [
            ERROR_CODES.RESERVATION_TIMEOUT,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof createDriverReservationBody>;

      const [station] = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          isOnline: chargingStations.isOnline,
          availability: chargingStations.availability,
          onboardingStatus: chargingStations.onboardingStatus,
          reservationsEnabled: chargingStations.reservationsEnabled,
          disabledReason: chargingStations.disabledReason,
          firmwareState: chargingStations.firmwareState,
          reportedStatus: chargingStations.reportedStatus,
        })
        .from(chargingStations)
        // A pending or blocked station answers like an unknown one.
        .where(and(eq(chargingStations.stationId, body.stationId), publicStationListed()));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Second layer (P11): the onboarding gate runs before any other state.
      if (!(await checkStationOnboarded(station, reply))) return;

      // The service runs every create check (window, online, eligibility,
      // maintenance, EVSE, busy EVSE, payment method), binds the driver's
      // latest active token, and checks overlaps and inserts under the
      // station lock (G1).
      let reservation: Awaited<ReturnType<typeof createReservation>>;
      try {
        reservation = await createReservation({
          station,
          evseOcppId: body.evseId,
          driverId,
          startsAt: body.startsAt != null ? new Date(body.startsAt) : null,
          expiresAt: new Date(body.expiresAt),
          actor: { kind: 'driver', driverId },
          logger: request.log,
        });
      } catch (err) {
        if (err instanceof MaintenanceConflictError) {
          await reply.status(409).send({ error: err.message, code: err.code, ...err.details });
          return;
        }
        throw err;
      }

      // An immediate reservation waits for the station (G4): any answer but
      // Accepted, or none, cancels it as system without a fee.
      const outcome = await dispatchReservation(reservation, {
        stationOcppId: station.stationId,
        siteId: station.siteId,
        notifyCreated: true,
        logger: request.log,
      });
      switch (outcome.kind) {
        case 'scheduled':
        case 'accepted':
          return reservation;
        case 'rejected':
          await reply.status(502).send({
            error: `Station rejected reservation: ${outcome.status}`,
            code: 'RESERVATION_REJECTED',
          });
          return;
        case 'failed':
          await reply.status(502).send({ error: outcome.error, code: 'RESERVATION_REJECTED' });
          return;
        case 'no_response':
          await reply.status(504).send({ error: outcome.error, code: 'RESERVATION_TIMEOUT' });
          return;
      }
    },
  );

  app.delete(
    '/portal/reservations/:id',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Cancel a reservation',
        description:
          'Cancels a driver-owned reservation. The reservation is marked cancelled first, then CancelReservation is published to the station for an active reservation; scheduled reservations are cancelled DB-only (not yet pushed to the station). May charge a cancellation fee per the reservation policy when the cancellation is within the fee window. Returns 404 if the reservation is not owned by the driver.',
        operationId: 'portalCancelReservation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(reservationIdParams),
        response: {
          200: itemResponse(cancelReservationResponse),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Reservation not found', [ERROR_CODES.RESERVATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof reservationIdParams>;

      const [reservation] = await db
        .select({
          id: reservations.id,
          reservationId: reservations.reservationId,
          status: reservations.status,
          stationOcppId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          startsAt: reservations.startsAt,
          createdAt: reservations.createdAt,
        })
        .from(reservations)
        .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
        .where(and(eq(reservations.id, id), eq(reservations.driverId, driverId)));

      if (reservation == null) {
        await reply
          .status(404)
          .send({ error: 'Reservation not found', code: 'RESERVATION_NOT_FOUND' });
        return;
      }

      if (reservation.status !== 'active' && reservation.status !== 'scheduled') {
        await reply
          .status(400)
          .send({ error: 'Reservation is not active', code: 'RESERVATION_NOT_ACTIVE' });
        return;
      }

      // Database first (G7): the guarded cancel flips the row (one winner,
      // which audits and charges the fee inside the cancellation window),
      // then the winner of an active hold publishes CancelReservation; a
      // scheduled one never reached the station.
      const { feeChargedCents, cancelled, feeChargeFailed, feeCurrency, warning } =
        await cancelReservationWithStation({
          reservationDbId: reservation.id,
          siteId: reservation.siteId,
          driverId,
          startsAt: reservation.startsAt ?? reservation.createdAt,
          createdAt: reservation.createdAt,
          actor: 'driver',
          actorDriverId: driverId,
          reason: 'driver_initiated',
          chargeFee: true,
          payments: paymentContext(request.log, getAuditActor(request)),
          logger: request.log,
          stationOcppId: reservation.stationOcppId,
          reservationOcppId: reservation.reservationId,
          // G7: a refused or unanswered cancel is audited and reported.
          waitForStation: true,
        });

      // Only notify when this caller actually flipped the row. A concurrent
      // operator/system cancel winning the race already sent its own message;
      // firing another would deliver a misleading "feeFormatted: ''" and
      // double-notify the driver.
      if (cancelled) {
        // The fee charged (tax included), formatted in the driver's language.
        const cancellationFeeFormatted =
          feeChargedCents > 0 && feeCurrency != null
            ? notificationMoney(feeChargedCents, feeCurrency)
            : '';
        void notifyReservationDriver(
          'reservation.Cancelled',
          {
            reservationDbId: reservation.id,
            reservationOcppId: reservation.reservationId,
            stationOcppId: reservation.stationOcppId,
            driverId,
          },
          {
            cancellationFeeFormatted,
            cancellationFeeCents: feeChargedCents,
            currency: feeCurrency ?? '',
          },
          { logger: request.log },
        );
      }

      return {
        status: 'cancelled',
        cancellationFeeChargedCents: feeChargedCents,
        ...(feeChargeFailed ? { feeChargeFailed: true } : {}),
        ...(warning != null ? { warning } : {}),
      };
    },
  );
}
