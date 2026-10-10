// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { checkStationSiteAccess } from '../lib/site-access.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { authorize, requestHasPermission } from '../middleware/rbac.js';
import type { JwtPayload } from '../plugins/auth.js';
import {
  checkWebPaymentSupport,
  disableWebPayments,
  enableWebPayments,
  getWebPaymentConfig,
} from '../services/web-payment.service.js';

const stationParams = z.object({
  id: ID_PARAMS.stationId.describe('Station ID'),
});

const enableBody = z.object({
  validitySeconds: z
    .number()
    .int()
    .min(6)
    .max(3600)
    .default(60)
    .describe('How long one QR code password is valid (WebPaymentsCtrlr.ValidityTime, seconds)'),
  totpLength: z
    .number()
    .int()
    .min(6)
    .max(32)
    .default(8)
    .describe('Length of the QR code password (WebPaymentsCtrlr.Length)'),
});

const webPaymentConfig = z
  .object({
    enabled: z.boolean().describe('Whether the station shows dynamic QR codes the CSMS can check'),
    validitySeconds: z
      .number()
      .int()
      .nullable()
      .describe('WebPaymentsCtrlr.ValidityTime in seconds, null when disabled'),
    totpLength: z.number().int().nullable().describe('WebPaymentsCtrlr.Length, null when disabled'),
    totpVersion: z
      .string()
      .nullable()
      .describe('WebPaymentsCtrlr.TOTPVersion (v1), null when disabled'),
    urlTemplate: z
      .string()
      .nullable()
      .describe('WebPaymentsCtrlr.URLTemplate pointing to the portal, null when disabled'),
  })
  .passthrough();

const supportQuery = z.object({
  live: z
    .enum(['true', 'false'])
    .default('false')
    .describe(
      'true asks an online station with GetVariables; false answers from the stored device model only',
    ),
});

const webPaymentSupport = z
  .object({
    status: z
      .enum(['supported', 'not_supported', 'unknown'])
      .describe('Whether the station can show dynamic QR codes (WebPaymentsCtrlr)'),
    reason: z
      .enum([
        'reported',
        'not_available',
        'unknown_component',
        'unknown_variable',
        'ocpp_version',
        'offline',
        'timeout',
        'command_failed',
        'unexpected_response',
        'not_checked',
      ])
      .describe(
        'Why: reported (the station reports WebPaymentsCtrlr), not_available (Available false), unknown_component or unknown_variable (GetVariables answer), ocpp_version (not OCPP 2.1), offline, timeout, command_failed, unexpected_response, not_checked (no recent report, ask live)',
      ),
    source: z
      .enum(['station', 'device_model', 'none'])
      .describe('station: live GetVariables, device_model: stored report, none: not asked'),
    stationEnabled: z
      .boolean()
      .nullable()
      .describe('WebPaymentsCtrlr.Enabled as reported by the station, null when not reported'),
    checkedAt: z
      .string()
      .nullable()
      .describe('When the station answered or last reported the component, null when not asked'),
  })
  .passthrough();

function isLiveCheck(request: FastifyRequest): boolean {
  return (request.query as { live?: unknown } | undefined)?.live === 'true';
}

const changeErrors = {
  400: errorWith('Bad request', [ERROR_CODES.OCPP_VERSION_MISMATCH, ERROR_CODES.VALIDATION_ERROR]),
  404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
  409: errorWith('Station offline', [ERROR_CODES.STATION_OFFLINE]),
  502: errorWith('The station did not accept the configuration', [
    ERROR_CODES.STATION_SECURITY_CHANGE_REJECTED,
    ERROR_CODES.OCPP_COMMAND_FAILED,
  ]),
};

export function stationWebPaymentRoutes(app: FastifyInstance): void {
  app.get(
    '/stations/:id/web-payments',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get the dynamic QR code payment configuration of a station',
        operationId: 'getStationWebPayments',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: {
          200: itemResponse(webPaymentConfig),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      return getWebPaymentConfig(id);
    },
  );

  app.get(
    '/stations/:id/web-payments/support',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Check whether a station supports dynamic QR codes',
        description:
          'Dynamic QR codes need an OCPP 2.1 station whose firmware implements WebPaymentsCtrlr and that has a display. Without live=true the answer comes from the stored device model (a NotifyReport or GetVariables answer from the last 24 hours) and the station is not contacted (stations:read). With live=true an online station is asked with GetVariables WebPaymentsCtrlr TOTPVersion, Enabled and Available: UnknownComponent means not supported. Offline stations fall back to the stored device model. live=true sends an OCPP command, so it needs stations:write, like other station commands, and is limited to 10 requests per minute per user (429).',
        operationId: 'checkStationWebPaymentSupport',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(supportQuery),
        response: {
          200: itemResponse(webPaymentSupport),
          403: errorWith('live=true needs stations:write', [ERROR_CODES.INSUFFICIENT_PERMISSIONS]),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
      // live=true fires GetVariables at the station; without a per-user cap a
      // stuck UI or a script can spam the station and the OCPP message bus.
      // Stored-model answers are not limited here.
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          allowList: (request: FastifyRequest) => !isLiveCheck(request),
          keyGenerator: (request: FastifyRequest) => {
            const user = request.user as { userId?: string } | undefined;
            return user?.userId ?? request.ip;
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { live } = request.query as z.infer<typeof supportQuery>;
      const { userId } = request.user as JwtPayload;
      if (live === 'true' && !(await requestHasPermission(request, 'stations:write'))) {
        await reply
          .status(403)
          .send({ error: 'Insufficient permissions', code: 'INSUFFICIENT_PERMISSIONS' });
        return;
      }
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      return checkWebPaymentSupport(id, { live: live === 'true', log: request.log });
    },
  );

  app.put(
    '/stations/:id/web-payments',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Enable dynamic QR code payments on a station',
        description:
          'Sends SetVariables WebPaymentsCtrlr (URLTemplate to the portal QR page, TOTPVersion v1, ValidityTime, Length, a new random SharedSecret, Enabled true) to an online OCPP 2.1 station and stores the encrypted shared secret only when the station accepts every variable. Returns 409 WEB_PAYMENTS_NOT_SUPPORTED, and sends nothing, when the stored device model reports WebPaymentsCtrlr as not available, and also when the station answers UnknownComponent or UnknownVariable. A station not checked yet can be enabled: its SetVariables answer decides. The portal then checks the one-time password in each scanned QR code URL (OCPP 2.1 C25.FR.07-09). Calling it again rotates the secret.',
        operationId: 'enableStationWebPayments',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(enableBody),
        response: {
          200: itemResponse(webPaymentConfig),
          ...changeErrors,
          409: errorWith('Station offline or dynamic QR codes not supported', [
            ERROR_CODES.STATION_OFFLINE,
            ERROR_CODES.WEB_PAYMENTS_NOT_SUPPORTED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const body = request.body as z.infer<typeof enableBody>;
      return enableWebPayments(id, body, { actor: getAuditActor(request), log: request.log });
    },
  );

  app.delete(
    '/stations/:id/web-payments',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Disable dynamic QR code payments on a station',
        description:
          'Sends SetVariables WebPaymentsCtrlr.Enabled = false to an online OCPP 2.1 station, then removes the stored shared secret, so QR codes the station still shows are refused.',
        operationId: 'disableStationWebPayments',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: { 200: itemResponse(webPaymentConfig), ...changeErrors },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      return disableWebPayments(id, { actor: getAuditActor(request), log: request.log });
    },
  );
}
