// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import Handlebars from 'handlebars';
import {
  db,
  stationMessageTemplates,
  getCompanyCurrency,
  getCompanyPriceDisplay,
  getCompanyTaxBasis,
  getStationMessagePricingFormat,
  getStationMessageBrandLine,
} from '@evtivity/database';
import {
  STATION_MESSAGE_DEFAULTS,
  STATION_MESSAGE_LANGUAGES,
  buildStationPriceContext,
  clearStationMessageCache,
  formatCurrencyAmount,
  formatStationElapsed,
  formatStationIdleFeeRate,
  formatStationQuantity,
  formatStationTime,
  type StationMessageLanguage,
  type StationMessageState,
} from '@evtivity/lib';
import { zodSchema } from '../lib/zod-schema.js';
import { itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { authorize } from '../middleware/rbac.js';
import type { JwtPayload } from '../plugins/auth.js';
import { requestStationMessageRepush } from '@evtivity/services/station-message.service';

// State screens re-render on a template change; one-shot templates render on
// their next dispatch.
const STATE_SCREEN_TEMPLATES = new Set<StationMessageState>([
  'available',
  'occupied',
  'reserved',
  'charging',
  'suspended',
  'discharging',
  'faulted',
  'unavailable',
]);

const STATION_MESSAGE_STATES = [
  'available',
  'occupied',
  'reserved',
  'charging',
  'suspended',
  'discharging',
  'faulted',
  'unavailable',
  'payment_failed',
  'payment_required',
  'guest_unauthorized',
  'unauthorized',
  'prepaid_exhausted',
  'account_credit_limit',
] as const satisfies readonly StationMessageState[];

const stateEnum = z.enum(STATION_MESSAGE_STATES);

const stateParams = z.object({
  state: stateEnum.describe('Station message state'),
});

const languageEnum = z.enum(STATION_MESSAGE_LANGUAGES);

const languageQuery = z.object({
  language: languageEnum.describe('Display language of the template'),
});

const updateBody = z.object({
  body: z.string().min(1).max(5000).describe('Handlebars template body'),
});

const previewBody = z.object({
  state: stateEnum.describe('Station message state'),
  language: languageEnum.describe(
    'Display language: sample prices, numbers, and the tax rate are formatted in it',
  ),
  body: z.string().min(1).max(5000).describe('Handlebars template body to render'),
  sampleContext: z.record(z.string().max(1000)).optional().describe('Variable overrides'),
});

const templateItem = z
  .object({
    state: stateEnum.describe('Station operating state the template renders for'),
    language: languageEnum.describe('Display language of the template'),
    body: z.string().max(5000).describe('Handlebars template body sent to the station display'),
    updatedAt: z.coerce.date().nullable().describe('Timestamp of the most recent edit'),
    updatedBy: z.string().nullable().describe('Operator user ID who last edited the template'),
  })
  .passthrough();

const previewItem = z
  .object({
    rendered: z.string().describe('Compiled template output using sample context values'),
  })
  .passthrough();

// Sample tariff and session for the preview: prices are stored net, so the
// preview shows them the way stations do (company.priceDisplay, company
// currency, stationMessage.pricingFormat) in the chosen language.
const SAMPLE_TARIFF = {
  pricePerKwh: '0.30',
  pricePerMinute: '0.02',
  pricePerSession: null,
  idleFeePricePerMinute: '0.10',
  taxRate: '0.19',
};

async function sampleContext(language: StationMessageLanguage): Promise<Record<string, unknown>> {
  const [currency, priceDisplay, taxBasis, pricingFormat, brandLine] = await Promise.all([
    getCompanyCurrency(),
    getCompanyPriceDisplay(),
    getCompanyTaxBasis(),
    getStationMessagePricingFormat(),
    getStationMessageBrandLine(),
  ]);
  return {
    companyName: 'EVtivity',
    brandLine: brandLine.trim() !== '' ? brandLine : 'EVtivity',
    stationOcppId: 'CS-1234',
    ...buildStationPriceContext({
      tariff: SAMPLE_TARIFF,
      priceDisplay,
      taxBasis,
      pricingFormat,
      currency,
      language,
    }),
    energyKwh: formatStationQuantity(12.4, language),
    powerKw: formatStationQuantity(22, language),
    costFormatted: formatCurrencyAmount(342, currency, language),
    // A session started 1 h 12 min ago.
    elapsedFormatted: formatStationElapsed(new Date(0), language, 72 * 60_000),
    idleFeeRate: formatStationIdleFeeRate({
      pricePerMinute: SAMPLE_TARIFF.idleFeePricePerMinute,
      taxRate: SAMPLE_TARIFF.taxRate,
      priceDisplay,
      taxBasis,
      currency,
      language,
    }),
    supportPhone: '+1-555-0100',
    driverFirstName: 'Alex',
    reservationExpiresAt: formatStationTime(new Date(2026, 0, 1, 15, 45), language),
  };
}

export function stationMessageTemplateRoutes(app: FastifyInstance): void {
  app.get(
    '/station-message-templates',
    {
      onRequest: [authorize('settings.integrations:read')],
      schema: {
        tags: ['Settings'],
        summary: 'List all station message templates',
        operationId: 'listStationMessageTemplates',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(z.object({ data: z.array(templateItem) }).passthrough()) },
      },
    },
    async () => {
      const rows = await db
        .select({
          state: stationMessageTemplates.state,
          language: stationMessageTemplates.language,
          body: stationMessageTemplates.body,
          updatedAt: stationMessageTemplates.updatedAt,
          updatedBy: stationMessageTemplates.updatedBy,
        })
        .from(stationMessageTemplates)
        .orderBy(stationMessageTemplates.language, stationMessageTemplates.state);

      return { data: rows };
    },
  );

  app.put(
    '/station-message-templates/:state',
    {
      onRequest: [authorize('settings.integrations:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Upsert a station message template body',
        operationId: 'updateStationMessageTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stateParams),
        querystring: zodSchema(languageQuery),
        body: zodSchema(updateBody),
        response: {
          200: itemResponse(templateItem),
          404: errorWith('Template not found', [ERROR_CODES.TEMPLATE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { state } = request.params as z.infer<typeof stateParams>;
      const { language } = request.query as z.infer<typeof languageQuery>;
      const { body } = request.body as z.infer<typeof updateBody>;
      const jwtUser = request.user as unknown as JwtPayload;
      const userId = typeof jwtUser.userId === 'string' ? jwtUser.userId : null;

      const updatedAt = new Date();
      const [row] = await db
        .insert(stationMessageTemplates)
        .values({ state, language, body, updatedAt, updatedBy: userId })
        .onConflictDoUpdate({
          target: [stationMessageTemplates.state, stationMessageTemplates.language],
          set: { body, updatedAt, updatedBy: userId },
        })
        .returning({
          state: stationMessageTemplates.state,
          language: stationMessageTemplates.language,
          body: stationMessageTemplates.body,
          updatedAt: stationMessageTemplates.updatedAt,
          updatedBy: stationMessageTemplates.updatedBy,
        });

      if (row == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      clearStationMessageCache();
      if (STATE_SCREEN_TEMPLATES.has(state)) await requestStationMessageRepush(request.log);
      return row;
    },
  );

  app.delete(
    '/station-message-templates/:state',
    {
      onRequest: [authorize('settings.integrations:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Reset a station message template to its seed default',
        operationId: 'resetStationMessageTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stateParams),
        querystring: zodSchema(languageQuery),
        response: { 200: itemResponse(templateItem) },
      },
    },
    async (request) => {
      const { state } = request.params as z.infer<typeof stateParams>;
      const { language } = request.query as z.infer<typeof languageQuery>;
      const defaultBody = STATION_MESSAGE_DEFAULTS[language][state];

      const jwtUser = request.user as unknown as JwtPayload;
      const userId = typeof jwtUser.userId === 'string' ? jwtUser.userId : null;
      const updatedAt = new Date();

      const [row] = await db
        .insert(stationMessageTemplates)
        .values({ state, language, body: defaultBody, updatedAt, updatedBy: userId })
        .onConflictDoUpdate({
          target: [stationMessageTemplates.state, stationMessageTemplates.language],
          set: { body: defaultBody, updatedAt, updatedBy: userId },
        })
        .returning({
          state: stationMessageTemplates.state,
          language: stationMessageTemplates.language,
          body: stationMessageTemplates.body,
          updatedAt: stationMessageTemplates.updatedAt,
          updatedBy: stationMessageTemplates.updatedBy,
        });

      clearStationMessageCache();
      if (STATE_SCREEN_TEMPLATES.has(state)) await requestStationMessageRepush(request.log);
      return row;
    },
  );

  app.post(
    '/station-message-templates/preview',
    {
      onRequest: [authorize('settings.integrations:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Render a station message template body with sample variables',
        operationId: 'previewStationMessageTemplate',
        security: [{ bearerAuth: [] }],
        body: zodSchema(previewBody),
        response: { 200: itemResponse(previewItem) },
      },
    },
    async (request) => {
      const {
        body,
        language,
        sampleContext: overrides,
      } = request.body as z.infer<typeof previewBody>;

      const ctx = await sampleContext(language);
      if (overrides != null) {
        for (const [key, value] of Object.entries(overrides)) {
          if (typeof value === 'string') ctx[key] = value;
        }
      }

      let rendered: string;
      try {
        const template = Handlebars.compile(body, { noEscape: true });
        rendered = template(ctx);
      } catch (err) {
        request.log.debug(
          { err },
          'Station message template preview did not render, returning empty',
        );
        rendered = '';
      }

      return { rendered };
    },
  );
}
