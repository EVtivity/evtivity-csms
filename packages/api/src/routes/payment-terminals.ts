// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Payment terminals (`/v1/payment-terminals`, features/payment-terminals.md):
// the registry, pairing to a station and connector, the terminal's SIM, the
// terminal payments, an operator payment on a terminal and the void of a
// hold. Every route is scoped by the terminal's site (a site-restricted user
// gets 404 PAYMENT_TERMINAL_NOT_FOUND for a terminal of another site or
// without a site); a terminal payment is scoped by the site it was stamped
// with at its start, never the terminal's current site.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  chargingStations,
  db,
  evses,
  getTerminal,
  openTerminalAttachment,
  paymentTerminals,
  paymentTerminalTransactions,
  simAttachments,
  sites,
  type PaymentTerminal,
} from '@evtivity/database';
import { buildCsv, escapeLikePattern, isValidIccid } from '@evtivity/lib';
import {
  TerminalProviderError,
  TERMINAL_AMOUNT_MAX_CENTS,
  TERMINAL_AMOUNT_MIN_CENTS,
  TERMINAL_PROVIDER_IDS,
  TERMINAL_TXN_STATES,
  type TerminalProviderId,
} from '@evtivity/payment-terminals';
import { isVoidable, voidTerminalTransaction } from '@evtivity/payments';
import {
  attachPaymentTerminalSim,
  auditPaymentTerminalAction,
  createPaymentTerminal,
  deletePaymentTerminal,
  detachPaymentTerminalSim,
  pairPaymentTerminal,
  setPaymentTerminalStatus,
  unpairPaymentTerminal,
  updatePaymentTerminal,
  type TerminalActor,
} from '@evtivity/services/payment-terminal.service';
import { startTerminalPaymentFlow } from '@evtivity/services/payment-terminal-flow';
import { authorize, requestHasPermission } from '../middleware/rbac.js';
import { zodSchema } from '../lib/zod-schema.js';
import {
  errorWith,
  itemResponse,
  paginatedResponse,
  successResponse,
} from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { prefixedId } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { siteInScope } from '../lib/site-scope.js';
import { paymentContext, terminalRegistry } from '../lib/payments.js';
import { config } from '../lib/config.js';
import type { JwtPayload } from '../plugins/auth.js';

export const PAYMENT_TERMINAL_NOT_FOUND = {
  error: 'Payment terminal not found',
  code: 'PAYMENT_TERMINAL_NOT_FOUND',
} as const;

const TERMINAL_TRANSACTION_NOT_FOUND = {
  error: 'Terminal payment not found',
  code: 'TERMINAL_TRANSACTION_NOT_FOUND',
} as const;

const terminalIdParams = z.object({
  id: prefixedId('ptm').describe('Payment terminal ID'),
});

const transactionIdParams = z.object({
  id: prefixedId('ptx').describe('Terminal payment ID'),
});

const terminalItem = z
  .object({
    id: z.string().describe('Payment terminal ID'),
    label: z.string().nullable().describe('Operator label'),
    provider: z.string().describe('Terminal provider: simulated or idtech'),
    integrationMode: z
      .enum(['cloud', 'hardware'])
      .describe('cloud: the CSMS calls the provider cloud; hardware: the charger drives it'),
    providerDeviceId: z.string().nullable().describe("The provider's device ID"),
    vendor: z.string().nullable().describe('Vendor (OCPP PaymentCtrlr VendorName)'),
    model: z.string().nullable().describe('Model, such as VP6825 or VP7200'),
    serialNumber: z.string().nullable().describe('Serial number'),
    firmwareVersion: z.string().nullable().describe('Firmware version the provider reported'),
    siteId: z.string().nullable().describe('Site of the terminal'),
    siteName: z.string().nullable().describe('Site name'),
    stationId: z.string().nullable().describe('Paired charging station (internal ID)'),
    stationOcppId: z.string().nullable().describe('OCPP identity of the paired station'),
    evseId: z
      .string()
      .nullable()
      .describe('Paired connector (internal EVSE ID); null: station-wide'),
    evseNumber: z.number().nullable().describe('OCPP EVSE ID of the paired connector'),
    status: z.enum(['active', 'inactive']).describe('Operator status'),
    online: z.boolean().nullable().describe('Last known device status; null when not known'),
    lastSeenAt: z.string().nullable().describe('When the provider last saw the device'),
    statusFetchedAt: z.string().nullable().describe('When the CSMS last read the device status'),
    offlineSince: z.string().nullable().describe('Start of the current offline period'),
    hasDisplay: z
      .boolean()
      .describe('The model shows prompts on its own screen (a VP7200 uses the station display)'),
    simAttached: z.boolean().describe('The terminal has an open SIM attachment'),
    createdAt: z.string().describe('Created'),
    updatedAt: z.string().describe('Last changed'),
  })
  .loose();

const transactionItem = z
  .object({
    id: z.string().describe('Terminal payment ID'),
    paymentTerminalId: z.string().describe('Payment terminal'),
    state: z.enum(TERMINAL_TXN_STATES).describe('Payment state'),
    currency: z.string().describe('ISO 4217 currency'),
    requestedCents: z.number().describe('Hold requested'),
    authorizedCents: z.number().nullable().describe('Hold the card authorized'),
    capturedCents: z.number().nullable().describe('Amount captured at the end of the session'),
    refundedCents: z.number().describe('Amount refunded'),
    cardLast4: z.string().nullable().describe('Last 4 digits of the card'),
    cardBrand: z.string().nullable().describe('Card brand'),
    declineCode: z.string().nullable().describe("Processor's decline code"),
    failureReason: z.string().nullable().describe('Why the payment failed or was released'),
    siteId: z.string().nullable().describe('Site of the station at the start'),
    stationId: z.string().nullable().describe('Station at the start'),
    evseNumber: z.number().nullable().describe('OCPP EVSE ID the start went to; 0: station-wide'),
    sessionId: z.string().nullable().describe('Charging session paid with it'),
    paymentRecordId: z.number().nullable().describe('Payment record of the capture'),
    requestedAt: z.string().describe('Started'),
    authorizedAt: z.string().nullable().describe('Card authorized'),
    capturedAt: z.string().nullable().describe('Captured'),
    voidedAt: z.string().nullable().describe('Released'),
  })
  .loose();

const listQuery = paginationQuery.extend({
  siteId: z.string().optional().describe('Only terminals of this site'),
  stationId: z.string().optional().describe('Only terminals paired to this station (internal ID)'),
  status: z.enum(['active', 'inactive']).optional().describe('Operator status'),
  online: z.enum(['true', 'false']).optional().describe('Last known device status'),
});

export const PAYMENT_TERMINAL_EXPORT_COLUMNS = [
  'id',
  'name',
  'provider',
  'providerDeviceId',
  'model',
  'serialNumber',
  'mode',
  'status',
  'online',
  'site',
  'station',
  'connector',
  'lastSeenAt',
];

/** The list filters and the caller's site scope (shared by the list and the export). */
function listWhere(query: z.infer<typeof listQuery>, siteIds: string[] | null): SQL | undefined {
  const conditions: SQL[] = [siteScope(siteIds)];
  if (query.siteId != null) conditions.push(eq(paymentTerminals.siteId, query.siteId));
  if (query.stationId != null) conditions.push(eq(paymentTerminals.stationId, query.stationId));
  if (query.status != null) conditions.push(eq(paymentTerminals.status, query.status));
  if (query.online != null) conditions.push(eq(paymentTerminals.online, query.online === 'true'));
  if (query.search != null && query.search.trim() !== '') {
    const pattern = `%${escapeLikePattern(query.search.trim())}%`;
    const match = or(
      ilike(paymentTerminals.label, pattern),
      ilike(paymentTerminals.serialNumber, pattern),
      ilike(paymentTerminals.providerDeviceId, pattern),
    );
    if (match != null) conditions.push(match);
  }
  return and(...conditions);
}

const createBody = z.object({
  provider: z
    .enum(TERMINAL_PROVIDER_IDS as [TerminalProviderId, ...TerminalProviderId[]])
    .describe('Terminal provider'),
  providerDeviceId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\x21-\x7e]+$/, 'printable ASCII without spaces')
    .describe("The provider's device ID (from GET /v1/payment-terminals/provider-devices)"),
  label: z.string().max(100).optional().describe('Operator label'),
  vendor: z.string().max(255).optional().describe('Vendor'),
  model: z.string().max(255).optional().describe('Model, such as VP6825 or VP7200'),
  serialNumber: z.string().max(255).optional().describe('Serial number'),
  siteId: z
    .string()
    .optional()
    .describe('Site of an unpaired terminal; a paired terminal takes its station site'),
  stationId: z.string().optional().describe('Station to pair to (internal ID)'),
  evseId: z
    .string()
    .nullable()
    .optional()
    .describe('Connector to pair to (internal EVSE ID); null or omitted: station-wide'),
});

const patchBody = z.object({
  label: z.string().max(100).nullable().optional().describe('Operator label'),
  vendor: z.string().max(255).nullable().optional().describe('Vendor'),
  model: z.string().max(255).nullable().optional().describe('Model'),
  serialNumber: z.string().max(255).nullable().optional().describe('Serial number'),
  siteId: z
    .string()
    .nullable()
    .optional()
    .describe('Site of an unpaired terminal (access to every site needed to move it)'),
});

const pairBody = z.object({
  stationId: z.string().describe('Station to pair to (internal ID)'),
  evseId: z
    .string()
    .nullable()
    .describe('Connector (internal EVSE ID), or null for a station-wide terminal'),
});

const statusBody = z.object({
  status: z.enum(['active', 'inactive']).describe('active takes payments, inactive does not'),
});

const paymentBody = z.object({
  amountCents: z
    .number()
    .int()
    .min(TERMINAL_AMOUNT_MIN_CENTS)
    .max(TERMINAL_AMOUNT_MAX_CENTS)
    .optional()
    .describe('Hold in cents (1 to 1,000,000); default the site hold amount'),
  receiptEmail: z.email().max(255).optional().describe('Where the receipt goes'),
});

const simBody = z.object({
  iccid: z.string().min(18).max(22).describe("ICCID of the terminal's own SIM"),
});

function terminalActor(request: FastifyRequest): TerminalActor {
  const { userId } = request.user as JwtPayload;
  return { audit: getAuditActor(request), userId };
}

/** The terminal, or a 404 sent for one the caller may not see. */
async function visibleTerminal(
  request: FastifyRequest,
  reply: FastifyReply,
  id: string,
): Promise<PaymentTerminal | null> {
  const { userId } = request.user as JwtPayload;
  const terminal = await getTerminal(id);
  const siteIds = await getUserSiteIds(userId);
  if (terminal == null || !siteInScope(siteIds, terminal.siteId)) {
    await reply.status(404).send(PAYMENT_TERMINAL_NOT_FOUND);
    return null;
  }
  return terminal;
}

/** The station and EVSE of a pairing, checked against the caller's sites (404 like a missing one). */
async function checkPairingAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  stationId: string,
  evseId: string | null,
): Promise<boolean> {
  const { userId } = request.user as JwtPayload;
  const siteIds = await getUserSiteIds(userId);
  const [station] = await db
    .select({ id: chargingStations.id, siteId: chargingStations.siteId })
    .from(chargingStations)
    .where(eq(chargingStations.id, stationId));
  if (station == null || !siteInScope(siteIds, station.siteId)) {
    await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
    return false;
  }
  if (evseId != null) {
    const [evse] = await db
      .select({ id: evses.id })
      .from(evses)
      .where(and(eq(evses.id, evseId), eq(evses.stationId, stationId)));
    if (evse == null) {
      await reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
      return false;
    }
  }
  return true;
}

function iso(value: Date | null): string | null {
  return value != null ? value.toISOString() : null;
}

async function terminalViews(rows: PaymentTerminal[]): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return [];
  const siteIdsOf = [...new Set(rows.map((r) => r.siteId).filter((s): s is string => s != null))];
  const stationIdsOf = [
    ...new Set(rows.map((r) => r.stationId).filter((s): s is string => s != null)),
  ];
  const evseIdsOf = [...new Set(rows.map((r) => r.evseId).filter((s): s is string => s != null))];
  const [siteRows, stationRows, evseRows, simRows] = await Promise.all([
    siteIdsOf.length > 0
      ? db
          .select({ id: sites.id, name: sites.name })
          .from(sites)
          .where(inArray(sites.id, siteIdsOf))
      : Promise.resolve([]),
    stationIdsOf.length > 0
      ? db
          .select({ id: chargingStations.id, ocppId: chargingStations.stationId })
          .from(chargingStations)
          .where(inArray(chargingStations.id, stationIdsOf))
      : Promise.resolve([]),
    evseIdsOf.length > 0
      ? db
          .select({ id: evses.id, evseId: evses.evseId })
          .from(evses)
          .where(inArray(evses.id, evseIdsOf))
      : Promise.resolve([]),
    db
      .select({ terminalId: simAttachments.paymentTerminalId })
      .from(simAttachments)
      .where(
        and(
          inArray(
            simAttachments.paymentTerminalId,
            rows.map((r) => r.id),
          ),
          isNull(simAttachments.detachedAt),
        ),
      ),
  ]);
  const siteName = new Map(siteRows.map((s) => [s.id, s.name]));
  const stationOcpp = new Map(stationRows.map((s) => [s.id, s.ocppId]));
  const evseNumber = new Map(evseRows.map((e) => [e.id, e.evseId]));
  const withSim = new Set(simRows.map((r) => r.terminalId));
  return rows.map((t) => ({
    id: t.id,
    label: t.label,
    provider: t.provider,
    integrationMode: t.integrationMode,
    providerDeviceId: t.providerDeviceId,
    vendor: t.vendor,
    model: t.model,
    serialNumber: t.serialNumber,
    firmwareVersion: t.firmwareVersion,
    siteId: t.siteId,
    siteName: t.siteId != null ? (siteName.get(t.siteId) ?? null) : null,
    stationId: t.stationId,
    stationOcppId: t.stationId != null ? (stationOcpp.get(t.stationId) ?? null) : null,
    evseId: t.evseId,
    evseNumber: t.evseId != null ? (evseNumber.get(t.evseId) ?? null) : null,
    status: t.status,
    online: t.online,
    lastSeenAt: iso(t.lastSeenAt),
    statusFetchedAt: iso(t.statusFetchedAt),
    offlineSince: iso(t.offlineSince),
    hasDisplay: t.model !== 'VP7200',
    simAttached: withSim.has(t.id),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  }));
}

function transactionView(
  t: typeof paymentTerminalTransactions.$inferSelect,
): Record<string, unknown> {
  return {
    id: t.id,
    paymentTerminalId: t.paymentTerminalId,
    state: t.state,
    currency: t.currency,
    requestedCents: t.requestedCents,
    authorizedCents: t.authorizedCents,
    capturedCents: t.capturedCents,
    refundedCents: t.refundedCents,
    cardLast4: t.cardLast4,
    cardBrand: t.cardBrand,
    declineCode: t.declineCode,
    failureReason: t.failureReason,
    siteId: t.siteId,
    stationId: t.stationId,
    evseNumber: t.evseNumber,
    sessionId: t.sessionId,
    paymentRecordId: t.paymentRecordId,
    requestedAt: t.requestedAt.toISOString(),
    authorizedAt: iso(t.authorizedAt),
    capturedAt: iso(t.capturedAt),
    voidedAt: iso(t.voidedAt),
  };
}

const PROVIDER_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  auth: 'The terminal provider refused the credentials',
  declined: 'The card was declined',
  not_found: 'The terminal provider does not know the device',
  device_offline: 'The payment terminal is offline',
  device_busy: 'The payment terminal is busy',
  rate_limited: 'The terminal provider asked to wait',
  unavailable: 'The terminal provider did not answer',
  validation: 'The terminal provider refused the request',
  unsupported: 'The terminal provider does not support this',
};

async function sendProviderError(reply: FastifyReply, err: TerminalProviderError): Promise<void> {
  await reply.status(502).send({
    error: PROVIDER_ERROR_MESSAGES[err.kind] ?? 'The terminal provider request failed',
    code: 'PAYMENT_TERMINAL_PROVIDER_ERROR',
    kind: err.kind,
  });
}

const providerErrorFields = {
  kind: z
    .string()
    .optional()
    .describe('Provider error kind (auth, device_offline, unavailable, ...)'),
};

export function paymentTerminalRoutes(app: FastifyInstance): void {
  app.get(
    '/payment-terminals/feature',
    {
      onRequest: [authorize('paymentTerminals:read')],
      schema: {
        tags: ['Payment Terminals'],
        summary: 'Payment terminal feature status',
        description:
          'Whether the Payment Terminals page applies: a terminal provider is configured in this process, or a terminal exists. Lists the providers available now.',
        operationId: 'getPaymentTerminalFeature',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(
            z
              .object({
                available: z.boolean().describe('Show the Payment Terminals page'),
                providers: z.array(z.string()).describe('Terminal providers available now'),
                terminalCount: z.number().describe('Terminals the caller can see'),
              })
              .loose(),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      const providers = await terminalRegistry.availableProviders();
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(paymentTerminals)
        .where(siteScope(siteIds));
      const terminalCount = row?.count ?? 0;
      return { available: providers.length > 0 || terminalCount > 0, providers, terminalCount };
    },
  );

  app.get(
    '/payment-terminals',
    {
      onRequest: [authorize('paymentTerminals:read')],
      schema: {
        tags: ['Payment Terminals'],
        summary: 'List payment terminals',
        description:
          "The payment terminals of the caller's sites (all-site users also see terminals without a site), newest first. search matches the label, serial number and provider device ID.",
        operationId: 'listPaymentTerminals',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(listQuery),
        response: { 200: paginatedResponse(terminalItem) },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const query = request.query as z.infer<typeof listQuery>;
      const where = listWhere(query, await getUserSiteIds(userId));
      const [rows, [count]] = await Promise.all([
        db
          .select()
          .from(paymentTerminals)
          .where(where)
          .orderBy(desc(paymentTerminals.createdAt), desc(paymentTerminals.id))
          .limit(query.limit)
          .offset((query.page - 1) * query.limit),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(paymentTerminals)
          .where(where),
      ]);
      return { data: await terminalViews(rows), total: count?.count ?? 0 };
    },
  );

  app.get(
    '/payment-terminals/export',
    {
      onRequest: [authorize('paymentTerminals:read')],
      schema: {
        tags: ['Payment Terminals'],
        summary: 'Export payment terminals as CSV',
        description:
          'Exports every payment terminal matching the list filters (search, siteId, stationId, status, online) that the caller sees, newest first; page and limit are ignored. Columns: id, name, provider, providerDeviceId, model, serialNumber, mode, status, online, site, station (OCPP identity), connector (OCPP EVSE ID; empty: station-wide), lastSeenAt. Holds no credentials and no card data.',
        operationId: 'exportPaymentTerminals',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(listQuery),
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const query = request.query as z.infer<typeof listQuery>;
      const rows = await db
        .select()
        .from(paymentTerminals)
        .where(listWhere(query, await getUserSiteIds(userId)))
        .orderBy(desc(paymentTerminals.createdAt), desc(paymentTerminals.id));
      const views = await terminalViews(rows);
      const csv = buildCsv(
        PAYMENT_TERMINAL_EXPORT_COLUMNS,
        views.map((v) => [
          v.id,
          v.label,
          v.provider,
          v.providerDeviceId,
          v.model,
          v.serialNumber,
          v.integrationMode,
          v.status,
          v.online,
          v.siteName,
          v.stationOcppId,
          v.evseNumber,
          v.lastSeenAt,
        ]),
      );
      await reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename=payment-terminals.csv')
        .send(csv);
    },
  );

  app.get(
    '/payment-terminals/provider-devices',
    {
      onRequest: [authorize('paymentTerminals:write')],
      schema: {
        tags: ['Payment Terminals'],
        summary: "List a provider's devices",
        description:
          'The devices the terminal provider account holds, for the import picker. Each says whether it is already registered. Needs access to every site (the provider account serves every site).',
        operationId: 'listPaymentTerminalProviderDevices',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(
          z.object({
            provider: z
              .enum(TERMINAL_PROVIDER_IDS as [TerminalProviderId, ...TerminalProviderId[]])
              .describe('Terminal provider'),
          }),
        ),
        response: {
          200: itemResponse(
            z
              .object({
                devices: z.array(
                  z
                    .object({
                      providerDeviceId: z.string().describe("The provider's device ID"),
                      vendor: z.string().nullable().describe('Vendor, such as ID TECH'),
                      serialNumber: z.string().nullable().describe('Serial number'),
                      model: z.string().nullable().describe('Model'),
                      online: z.boolean().nullable().describe('Device status'),
                      registered: z.boolean().describe('Already a payment terminal'),
                    })
                    .loose(),
                ),
              })
              .loose(),
          ),
          400: errorWith('Provider not configured', [
            ERROR_CODES.PAYMENT_TERMINAL_PROVIDER_NOT_CONFIGURED,
          ]),
          404: errorWith('Not found', [ERROR_CODES.PAYMENT_TERMINAL_NOT_FOUND]),
          502: errorWith(
            'Provider request failed',
            [ERROR_CODES.PAYMENT_TERMINAL_PROVIDER_ERROR],
            providerErrorFields,
          ),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      if ((await getUserSiteIds(userId)) != null) {
        await reply.status(404).send(PAYMENT_TERMINAL_NOT_FOUND);
        return;
      }
      const { provider: providerId } = request.query as { provider: TerminalProviderId };
      const provider = await terminalRegistry.getProvider(providerId);
      if (provider == null) {
        await reply.status(400).send({
          error: 'The payment terminal provider is off or has no credentials',
          code: 'PAYMENT_TERMINAL_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }
      try {
        const { devices } = await provider.listDevices();
        const registered = await db
          .select({ deviceId: paymentTerminals.providerDeviceId })
          .from(paymentTerminals)
          .where(eq(paymentTerminals.provider, providerId));
        const known = new Set(registered.map((r) => r.deviceId));
        return {
          devices: devices.map((d) => ({
            providerDeviceId: d.providerDeviceId,
            vendor: d.vendor,
            serialNumber: d.serialNumber,
            model: d.model,
            online: d.online,
            registered: known.has(d.providerDeviceId),
          })),
        };
      } catch (err: unknown) {
        if (!(err instanceof TerminalProviderError)) throw err;
        request.log.warn({ err, provider: providerId }, 'Terminal device list failed');
        await sendProviderError(reply, err);
        return;
      }
    },
  );

  app.post(
    '/payment-terminals',
    {
      onRequest: [authorize('paymentTerminals:write')],
      schema: {
        tags: ['Payment Terminals'],
        summary: 'Register a payment terminal',
        description:
          "Registers a cloud terminal by its provider device ID, optionally paired to a station (and one connector, or station-wide; pairing also needs stations:write). A paired terminal takes the station's site. A site-restricted user pairs to a station of their sites or names one of their sites; a terminal without a site is for all-site users only.",
        operationId: 'createPaymentTerminal',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createBody),
        response: {
          201: itemResponse(terminalItem),
          400: errorWith('Validation error', [
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.PAYMENT_TERMINAL_PROVIDER_NOT_CONFIGURED,
          ]),
          403: errorWith('Insufficient permissions', [ERROR_CODES.INSUFFICIENT_PERMISSIONS]),
          404: errorWith('Not found', [
            ERROR_CODES.STATION_NOT_FOUND,
            ERROR_CODES.EVSE_NOT_FOUND,
            ERROR_CODES.SITE_NOT_FOUND,
          ]),
          409: errorWith('Conflict', [
            ERROR_CODES.PAYMENT_TERMINAL_DEVICE_TAKEN,
            ERROR_CODES.PAYMENT_TERMINAL_EVSE_TAKEN,
          ]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createBody>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if ((await terminalRegistry.getProvider(body.provider)) == null) {
        await reply.status(400).send({
          error: 'The payment terminal provider is off or has no credentials',
          code: 'PAYMENT_TERMINAL_PROVIDER_NOT_CONFIGURED',
        });
        return;
      }
      const pairing =
        body.stationId != null ? { stationId: body.stationId, evseId: body.evseId ?? null } : null;
      if (pairing != null) {
        if (!(await requestHasPermission(request, 'stations:write'))) {
          await reply
            .status(403)
            .send({ error: 'Insufficient permissions', code: 'INSUFFICIENT_PERMISSIONS' });
          return;
        }
        if (!(await checkPairingAccess(request, reply, pairing.stationId, pairing.evseId))) return;
      } else if (body.siteId != null) {
        const [site] = await db
          .select({ id: sites.id })
          .from(sites)
          .where(eq(sites.id, body.siteId));
        if (site == null || !siteInScope(siteIds, site.id)) {
          await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
          return;
        }
      } else if (siteIds != null) {
        await reply.status(400).send({
          error: 'Pair the terminal to a station or give one of your sites',
          code: 'VALIDATION_ERROR',
        });
        return;
      }
      const result = await createPaymentTerminal(
        {
          provider: body.provider,
          integrationMode: 'cloud',
          providerDeviceId: body.providerDeviceId,
          label: body.label?.trim() || null,
          vendor: body.vendor ?? (body.provider === 'idtech' ? 'ID TECH' : null),
          model: body.model ?? null,
          serialNumber: body.serialNumber ?? null,
          firmwareVersion: null,
          siteId: pairing == null ? (body.siteId ?? null) : null,
          pairing,
        },
        { actor: terminalActor(request), log: request.log },
      );
      switch (result.kind) {
        case 'created': {
          const [view] = await terminalViews([result.terminal]);
          return reply.status(201).send(view);
        }
        case 'device_taken':
          return reply.status(409).send({
            error: 'This device is already registered as a payment terminal',
            code: 'PAYMENT_TERMINAL_DEVICE_TAKEN',
          });
        case 'evse_taken':
          return reply.status(409).send({
            error: 'Another active payment terminal is paired to this connector',
            code: 'PAYMENT_TERMINAL_EVSE_TAKEN',
          });
        case 'station_not_found':
          return reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        case 'evse_not_found':
          return reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
      }
    },
  );

  app.get(
    '/payment-terminals/:id',
    {
      onRequest: [authorize('paymentTerminals:read')],
      schema: {
        tags: ['Payment Terminals'],
        summary: 'Get a payment terminal',
        operationId: 'getPaymentTerminal',
        security: [{ bearerAuth: [] }],
        params: zodSchema(terminalIdParams),
        response: {
          200: itemResponse(terminalItem),
          404: errorWith('Not found', [ERROR_CODES.PAYMENT_TERMINAL_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const terminal = await visibleTerminal(request, reply, id);
      if (terminal == null) return;
      const [view] = await terminalViews([terminal]);
      return view;
    },
  );

  app.patch(
    '/payment-terminals/:id',
    {
      onRequest: [authorize('paymentTerminals:write')],
      schema: {
        tags: ['Payment Terminals'],
        summary: 'Edit a payment terminal',
        description:
          "Edits the label, vendor, model and serial number. The site of an unpaired terminal changes only with access to every site; a paired terminal follows its station's site (409 PAYMENT_TERMINAL_NOT_PAIRED is not used here: a site change of a paired terminal answers 400).",
        operationId: 'updatePaymentTerminal',
        security: [{ bearerAuth: [] }],
        params: zodSchema(terminalIdParams),
        body: zodSchema(patchBody),
        response: {
          200: itemResponse(terminalItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Not found', [
            ERROR_CODES.PAYMENT_TERMINAL_NOT_FOUND,
            ERROR_CODES.SITE_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as z.infer<typeof patchBody>;
      const terminal = await visibleTerminal(request, reply, id);
      if (terminal == null) return;
      const { userId } = request.user as JwtPayload;
      if (body.siteId !== undefined && body.siteId !== terminal.siteId) {
        if ((await getUserSiteIds(userId)) != null) {
          await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
          return;
        }
        if (body.siteId != null) {
          const [site] = await db
            .select({ id: sites.id })
            .from(sites)
            .where(eq(sites.id, body.siteId));
          if (site == null) {
            await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
            return;
          }
        }
      }
      const result = await updatePaymentTerminal(
        id,
        {
          ...(body.label !== undefined ? { label: body.label?.trim() || null } : {}),
          ...(body.vendor !== undefined ? { vendor: body.vendor } : {}),
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.serialNumber !== undefined ? { serialNumber: body.serialNumber } : {}),
          ...(body.siteId !== undefined ? { siteId: body.siteId } : {}),
        },
        { actor: terminalActor(request), log: request.log },
      );
      if (result.kind === 'not_found') return reply.status(404).send(PAYMENT_TERMINAL_NOT_FOUND);
      if (result.kind === 'paired_site_change') {
        return reply.status(400).send({
          error: "A paired terminal follows its station's site; unpair it first",
          code: 'VALIDATION_ERROR',
        });
      }
      const [view] = await terminalViews([result.after]);
      return view;
    },
  );

  app.delete(
    '/payment-terminals/:id',
    {
      onRequest: [authorize('paymentTerminals:write')],
      schema: {
        tags: ['Payment Terminals'],
        summary: 'Delete a payment terminal',
        description:
          'Deletes a terminal that never took a payment. A terminal with payments is kept for the payment history: deactivate it instead (409 PAYMENT_TERMINAL_HAS_TRANSACTIONS).',
        operationId: 'deletePaymentTerminal',
        security: [{ bearerAuth: [] }],
        params: zodSchema(terminalIdParams),
        response: {
          200: successResponse,
          404: errorWith('Not found', [ERROR_CODES.PAYMENT_TERMINAL_NOT_FOUND]),
          409: errorWith('Conflict', [ERROR_CODES.PAYMENT_TERMINAL_HAS_TRANSACTIONS]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if ((await visibleTerminal(request, reply, id)) == null) return;
      const result = await deletePaymentTerminal(id, {
        actor: terminalActor(request),
        log: request.log,
      });
      if (result.kind === 'not_found') return reply.status(404).send(PAYMENT_TERMINAL_NOT_FOUND);
      if (result.kind === 'has_transactions') {
        return reply.status(409).send({
          error: 'The payment terminal has payments and cannot be deleted; deactivate it instead',
          code: 'PAYMENT_TERMINAL_HAS_TRANSACTIONS',
        });
      }
      return { success: true };
    },
  );

  app.post(
    '/payment-terminals/:id/pair',
    {
      onRequest: [authorize('paymentTerminals:write', 'stations:write')],
      schema: {
        tags: ['Payment Terminals'],
        summary: 'Pair a payment terminal to a station',
        description:
          "Pairs the terminal to a station and one connector, or to the whole station (evseId null: the driver picks the connector on the terminal screen, or plugs in at any connector with a VP7200). The terminal takes the station's site. Needs access to the terminal's site and the station's site.",
        operationId: 'pairPaymentTerminal',
        security: [{ bearerAuth: [] }],
        params: zodSchema(terminalIdParams),
        body: zodSchema(pairBody),
        response: {
          200: itemResponse(terminalItem),
          404: errorWith('Not found', [
            ERROR_CODES.PAYMENT_TERMINAL_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
            ERROR_CODES.EVSE_NOT_FOUND,
          ]),
          409: errorWith('Conflict', [ERROR_CODES.PAYMENT_TERMINAL_EVSE_TAKEN]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as z.infer<typeof pairBody>;
      if ((await visibleTerminal(request, reply, id)) == null) return;
      if (!(await checkPairingAccess(request, reply, body.stationId, body.evseId))) return;
      const result = await pairPaymentTerminal(
        id,
        { stationId: body.stationId, evseId: body.evseId },
        { actor: terminalActor(request), log: request.log },
      );
      switch (result.kind) {
        case 'paired': {
          const [view] = await terminalViews([result.after]);
          return view;
        }
        case 'not_found':
          return reply.status(404).send(PAYMENT_TERMINAL_NOT_FOUND);
        case 'evse_taken':
          return reply.status(409).send({
            error: 'Another active payment terminal is paired to this connector',
            code: 'PAYMENT_TERMINAL_EVSE_TAKEN',
          });
        case 'station_not_found':
          return reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        case 'evse_not_found':
          return reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
      }
    },
  );

  app.post(
    '/payment-terminals/:id/unpair',
    {
      onRequest: [authorize('paymentTerminals:write', 'stations:write')],
      schema: {
        tags: ['Payment Terminals'],
        summary: 'Unpair a payment terminal',
        description: 'Removes the station and connector; the site stays.',
        operationId: 'unpairPaymentTerminal',
        security: [{ bearerAuth: [] }],
        params: zodSchema(terminalIdParams),
        response: {
          200: itemResponse(terminalItem),
          404: errorWith('Not found', [ERROR_CODES.PAYMENT_TERMINAL_NOT_FOUND]),
          409: errorWith('Not paired', [ERROR_CODES.PAYMENT_TERMINAL_NOT_PAIRED]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if ((await visibleTerminal(request, reply, id)) == null) return;
      const result = await unpairPaymentTerminal(id, {
        actor: terminalActor(request),
        log: request.log,
      });
      if (result.kind === 'not_found') return reply.status(404).send(PAYMENT_TERMINAL_NOT_FOUND);
      if (result.kind === 'not_paired') {
        return reply.status(409).send({
          error: 'The payment terminal is not paired to a charging station',
          code: 'PAYMENT_TERMINAL_NOT_PAIRED',
        });
      }
      const [view] = await terminalViews([result.after]);
      return view;
    },
  );

  app.post(
    '/payment-terminals/:id/status',
    {
      onRequest: [authorize('paymentTerminals:write')],
      schema: {
        tags: ['Payment Terminals'],
        summary: 'Activate or deactivate a payment terminal',
        description:
          'An inactive terminal takes no new payment; payments already authorized settle as usual. Reactivating on a connector another active terminal took answers 409.',
        operationId: 'setPaymentTerminalStatus',
        security: [{ bearerAuth: [] }],
        params: zodSchema(terminalIdParams),
        body: zodSchema(statusBody),
        response: {
          200: itemResponse(terminalItem),
          404: errorWith('Not found', [ERROR_CODES.PAYMENT_TERMINAL_NOT_FOUND]),
          409: errorWith('Conflict', [ERROR_CODES.PAYMENT_TERMINAL_EVSE_TAKEN]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { status } = request.body as z.infer<typeof statusBody>;
      if ((await visibleTerminal(request, reply, id)) == null) return;
      const result = await setPaymentTerminalStatus(id, status, {
        actor: terminalActor(request),
        log: request.log,
      });
      if (result.kind === 'not_found') return reply.status(404).send(PAYMENT_TERMINAL_NOT_FOUND);
      if (result.kind === 'evse_taken') {
        return reply.status(409).send({
          error: 'Another active payment terminal is paired to this connector',
          code: 'PAYMENT_TERMINAL_EVSE_TAKEN',
        });
      }
      const [view] = await terminalViews([
        result.kind === 'changed' ? result.after : result.terminal,
      ]);
      return view;
    },
  );

  app.get(
    '/payment-terminals/:id/transactions',
    {
      onRequest: [authorize('paymentTerminals:read', 'payments:read')],
      schema: {
        tags: ['Payment Terminals'],
        summary: "List a terminal's payments",
        description:
          'The card payments of the terminal, newest first, at most the last 4 digits and the brand of each card. A site-restricted user sees the payments stamped with one of their sites (the station site at the start), whatever site the terminal has now.',
        operationId: 'listPaymentTerminalTransactions',
        security: [{ bearerAuth: [] }],
        params: zodSchema(terminalIdParams),
        querystring: zodSchema(paginationQuery.omit({ search: true })),
        response: {
          200: paginatedResponse(transactionItem),
          404: errorWith('Not found', [ERROR_CODES.PAYMENT_TERMINAL_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { page: number; limit: number };
      if ((await visibleTerminal(request, reply, id)) == null) return;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      const where = and(
        eq(paymentTerminalTransactions.paymentTerminalId, id),
        siteIds == null
          ? undefined
          : siteIds.length === 0
            ? sql`false`
            : inArray(paymentTerminalTransactions.siteId, siteIds),
      );
      const [rows, [count]] = await Promise.all([
        db
          .select()
          .from(paymentTerminalTransactions)
          .where(where)
          .orderBy(desc(paymentTerminalTransactions.requestedAt))
          .limit(query.limit)
          .offset((query.page - 1) * query.limit),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(paymentTerminalTransactions)
          .where(where),
      ]);
      return { data: rows.map(transactionView), total: count?.count ?? 0 };
    },
  );

  app.post(
    '/payment-terminals/:id/payments',
    {
      onRequest: [authorize('paymentTerminals:write', 'payments:write')],
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          keyGenerator: (request: FastifyRequest) => {
            const user = request.user as { userId?: string } | undefined;
            return `terminal-payment:${user?.userId ?? request.ip}`;
          },
        },
      },
      schema: {
        tags: ['Payment Terminals'],
        summary: 'Start a card payment on a terminal',
        description:
          'Asks the terminal for a card (a test payment, or a driver at the terminal). The hold is the site hold amount unless amountCents is given. When the card is authorized the CSMS starts charging on the paired connector (or the station decides for a station-wide terminal). Limited to 5 a minute per user.',
        operationId: 'startPaymentTerminalPayment',
        security: [{ bearerAuth: [] }],
        params: zodSchema(terminalIdParams),
        body: zodSchema(paymentBody),
        response: {
          200: itemResponse(
            z
              .object({
                transaction: transactionItem,
                chargingStarted: z.boolean().describe('Charging started with this payment'),
                startError: z
                  .string()
                  .nullable()
                  .describe('Why charging did not start (an error code); the hold was released'),
              })
              .loose(),
          ),
          400: errorWith('Not possible', [
            ERROR_CODES.PAYMENT_TERMINAL_HARDWARE_MODE,
            ERROR_CODES.PAYMENT_TERMINAL_PROVIDER_NOT_CONFIGURED,
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          404: errorWith('Not found', [ERROR_CODES.PAYMENT_TERMINAL_NOT_FOUND]),
          409: errorWith('Conflict', [
            ERROR_CODES.PAYMENT_TERMINAL_INACTIVE,
            ERROR_CODES.PAYMENT_TERMINAL_NOT_PAIRED,
            ERROR_CODES.PAYMENT_TERMINAL_BUSY,
          ]),
          502: errorWith(
            'Provider request failed',
            [ERROR_CODES.PAYMENT_TERMINAL_PROVIDER_ERROR],
            providerErrorFields,
          ),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as z.infer<typeof paymentBody>;
      if ((await visibleTerminal(request, reply, id)) == null) return;
      const outcome = await startTerminalPaymentFlow(
        id,
        {
          ...(body.amountCents != null ? { amountCents: body.amountCents } : {}),
          receiptEmail: body.receiptEmail ?? null,
        },
        {
          payments: paymentContext(request.log, getAuditActor(request)),
          logger: request.log,
          portalUrl: config.PORTAL_URL,
        },
      );
      if (
        outcome.kind === 'started' ||
        outcome.kind === 'charging_started' ||
        outcome.kind === 'charging_not_started' ||
        outcome.kind === 'provider_error'
      ) {
        await auditPaymentTerminalAction(id, 'payment_started', outcome.transaction, {
          actor: terminalActor(request),
          log: request.log,
        });
      }
      switch (outcome.kind) {
        case 'not_found':
          return reply.status(404).send(PAYMENT_TERMINAL_NOT_FOUND);
        case 'inactive':
          return reply
            .status(409)
            .send({ error: 'The payment terminal is inactive', code: 'PAYMENT_TERMINAL_INACTIVE' });
        case 'not_paired':
          return reply.status(409).send({
            error: 'The payment terminal is not paired to a charging station',
            code: 'PAYMENT_TERMINAL_NOT_PAIRED',
          });
        case 'busy':
          return reply.status(409).send({
            error: 'The payment terminal already has a payment in progress',
            code: 'PAYMENT_TERMINAL_BUSY',
          });
        case 'hardware':
          return reply.status(400).send({
            error: 'The charging station drives this hardware mode terminal',
            code: 'PAYMENT_TERMINAL_HARDWARE_MODE',
          });
        case 'invalid_amount':
          return reply.status(400).send({
            error: 'The hold must be 1 to 1,000,000 cents',
            code: 'VALIDATION_ERROR',
          });
        case 'not_configured':
          return reply.status(400).send({
            error: 'The payment terminal provider is off or has no credentials',
            code: 'PAYMENT_TERMINAL_PROVIDER_NOT_CONFIGURED',
          });
        case 'provider_error':
          await sendProviderError(reply, outcome.error);
          return;
        case 'started':
          return {
            transaction: transactionView(outcome.transaction),
            chargingStarted: false,
            startError: null,
          };
        case 'charging_started':
          return {
            transaction: transactionView(outcome.transaction),
            chargingStarted: true,
            startError: null,
          };
        case 'charging_not_started':
          return {
            transaction: transactionView(outcome.transaction),
            chargingStarted: false,
            startError: outcome.code,
          };
      }
    },
  );

  app.post(
    '/payment-terminal-transactions/:id/void',
    {
      onRequest: [authorize('paymentTerminals:write', 'payments:write')],
      schema: {
        tags: ['Payment Terminals'],
        summary: 'Release a terminal hold',
        description:
          'Voids a hold that is not captured (requested, presenting or authorized). A captured payment is refunded through POST /v1/payments/{id}/refund instead. Scoped by the site the payment was stamped with.',
        operationId: 'voidPaymentTerminalTransaction',
        security: [{ bearerAuth: [] }],
        params: zodSchema(transactionIdParams),
        response: {
          200: itemResponse(transactionItem),
          404: errorWith('Not found', [ERROR_CODES.TERMINAL_TRANSACTION_NOT_FOUND]),
          409: errorWith('Wrong state', [ERROR_CODES.TERMINAL_TRANSACTION_STATE]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      const [txn] = await db
        .select()
        .from(paymentTerminalTransactions)
        .where(eq(paymentTerminalTransactions.id, id));
      if (txn == null || !siteInScope(siteIds, txn.siteId)) {
        return reply.status(404).send(TERMINAL_TRANSACTION_NOT_FOUND);
      }
      if (!isVoidable(txn)) {
        return reply.status(409).send({
          error: 'The terminal payment cannot do this in its current state',
          code: 'TERMINAL_TRANSACTION_STATE',
        });
      }
      const result = await voidTerminalTransaction(
        id,
        'operator_void',
        paymentContext(request.log, getAuditActor(request)),
      );
      const after = result.transaction ?? txn;
      await auditPaymentTerminalAction(txn.paymentTerminalId, 'payment_voided', after, {
        actor: terminalActor(request),
        log: request.log,
      });
      return transactionView(after);
    },
  );

  app.post(
    '/payment-terminals/:id/sim',
    {
      onRequest: [authorize('paymentTerminals:write', 'sims:write')],
      schema: {
        tags: ['Payment Terminals'],
        summary: "Enter a terminal's SIM",
        description:
          "Attaches the terminal's own SIM (VP6825 LTE) by its ICCID: found or created in the SIM inventory, confirmed at once only for a user with access to every site. A SIM attached elsewhere and a terminal with another SIM are refused; nothing is closed.",
        operationId: 'attachPaymentTerminalSim',
        security: [{ bearerAuth: [] }],
        params: zodSchema(terminalIdParams),
        body: zodSchema(simBody),
        response: {
          200: successResponse,
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Not found', [ERROR_CODES.PAYMENT_TERMINAL_NOT_FOUND]),
          409: errorWith('Conflict', [
            ERROR_CODES.SIM_ATTACHED_ELSEWHERE,
            ERROR_CODES.SIM_INACTIVE,
            ERROR_CODES.PAYMENT_TERMINAL_HAS_SIM,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { iccid } = request.body as z.infer<typeof simBody>;
      if ((await visibleTerminal(request, reply, id)) == null) return;
      if (!isValidIccid(iccid)) {
        return reply.status(400).send({ error: 'Not an ICCID', code: 'VALIDATION_ERROR' });
      }
      const { userId } = request.user as JwtPayload;
      const withAllSites = (await getUserSiteIds(userId)) == null;
      const result = await attachPaymentTerminalSim(id, iccid, withAllSites, {
        actor: terminalActor(request),
        log: request.log,
      });
      switch (result.kind) {
        case 'attached':
        case 'unchanged':
          return { success: true };
        case 'sim_attached_elsewhere':
          return reply.status(409).send({
            error: 'The SIM is attached elsewhere',
            code: 'SIM_ATTACHED_ELSEWHERE',
          });
        case 'sim_inactive':
          return reply.status(409).send({ error: 'The SIM is inactive', code: 'SIM_INACTIVE' });
        case 'terminal_has_sim':
          return reply.status(409).send({
            error: 'The payment terminal already has a SIM',
            code: 'PAYMENT_TERMINAL_HAS_SIM',
          });
        case 'sim_not_found':
          return reply.status(404).send(PAYMENT_TERMINAL_NOT_FOUND);
      }
    },
  );

  app.delete(
    '/payment-terminals/:id/sim',
    {
      onRequest: [authorize('paymentTerminals:write', 'sims:write')],
      schema: {
        tags: ['Payment Terminals'],
        summary: "Detach a terminal's SIM",
        operationId: 'detachPaymentTerminalSim',
        security: [{ bearerAuth: [] }],
        params: zodSchema(terminalIdParams),
        response: {
          200: successResponse,
          404: errorWith('Not found', [ERROR_CODES.PAYMENT_TERMINAL_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if ((await visibleTerminal(request, reply, id)) == null) return;
      if ((await openTerminalAttachment(id)) == null) return { success: true };
      await detachPaymentTerminalSim(id, { actor: terminalActor(request), log: request.log });
      return { success: true };
    },
  );
}

/** The terminals a caller sees: all for an all-site user, else those of their sites. */
function siteScope(siteIds: string[] | null): SQL {
  if (siteIds == null) return sql`true`;
  if (siteIds.length === 0) return sql`false`;
  return inArray(paymentTerminals.siteId, siteIds);
}
