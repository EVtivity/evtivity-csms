// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { checkStationSiteAccess } from '../lib/site-access.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { authorize } from '../middleware/rbac.js';
import type { JwtPayload } from '../plugins/auth.js';
import {
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

  app.put(
    '/stations/:id/web-payments',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Enable dynamic QR code payments on a station',
        description:
          'Sends SetVariables WebPaymentsCtrlr (URLTemplate to the portal QR page, TOTPVersion v1, ValidityTime, Length, a new random SharedSecret, Enabled true) to an online OCPP 2.1 station and stores the encrypted shared secret only when the station accepts every variable. The portal then checks the one-time password in each scanned QR code URL (OCPP 2.1 C25.FR.07-09). Calling it again rotates the secret.',
        operationId: 'enableStationWebPayments',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(enableBody),
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
