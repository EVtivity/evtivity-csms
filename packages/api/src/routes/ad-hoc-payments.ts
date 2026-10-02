// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zodSchema } from '../lib/zod-schema.js';
import { itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { authorize } from '../middleware/rbac.js';
import type { JwtPayload } from '../plugins/auth.js';
import { startAdHocPayment } from '../services/ad-hoc-payment.service.js';

const adHocPaymentBody = z.object({
  stationId: z.string().min(1).max(255).describe('OCPP identity of the charging station'),
  evseId: z.number().int().min(1).describe('EVSE the payment is for'),
  pspRef: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\x21-\x7e]+$/, 'pspRef must be printable ASCII without spaces')
    .describe(
      'Unique reference of the authorized payment at the payment service provider. Sent to the station as the DirectPayment idToken',
    ),
  cardLast4Digits: z
    .string()
    .regex(/^\d{4}$/)
    .optional()
    .describe('Last 4 digits of the payment card, sent as idToken additionalInfo CardLast4Digits'),
  cardBin: z
    .string()
    .regex(/^\d{6,8}$/)
    .optional()
    .describe('Bank identification number of the payment card, sent as additionalInfo CardBin'),
  maxCostCents: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Authorized amount in cents of the company currency. Returned as transactionLimit.maxCost',
    ),
  maxEnergyWh: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Energy limit in Wh. Returned as transactionLimit.maxEnergy'),
  maxTimeSeconds: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Duration limit in seconds. Returned as transactionLimit.maxTime'),
  email: z.string().email().max(255).optional().describe('EV driver email for the receipt'),
});

const adHocPaymentResponse = z
  .object({
    pspRef: z.string().describe('PSP reference the transaction was started with'),
    stationId: z.string().describe('OCPP identity of the charging station'),
    evseId: z.number().int().describe('EVSE the transaction was started on'),
    replayed: z
      .boolean()
      .describe(
        'True when this pspRef already started a transaction on this EVSE and nothing was sent again',
      ),
  })
  .passthrough();

export function adHocPaymentRoutes(app: FastifyInstance): void {
  app.post(
    '/ad-hoc-payments',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Payments'],
        summary: 'Start a transaction for an authorized ad hoc payment',
        description:
          'Called by a stand-alone payment terminal or a payment service provider after it authorized a payment card for a charging station (OCPP 2.1 C24, C25). Sends RequestStartTransaction with idToken = pspRef, type DirectPayment, and the card details as additionalInfo, then waits up to 35s for the station. When the transaction starts, the station receives the limits (maxCostCents, maxEnergyWh, maxTimeSeconds) as transactionLimit. A retry with the same pspRef for the same EVSE returns replayed = true and sends nothing. Needs an OCPP 2.1 station.',
        operationId: 'startAdHocPayment',
        security: [{ bearerAuth: [] }],
        body: zodSchema(adHocPaymentBody),
        response: {
          200: itemResponse(adHocPaymentResponse),
          400: errorWith('Bad request', [
            ERROR_CODES.OCPP_VERSION_MISMATCH,
            ERROR_CODES.STATION_OFFLINE,
          ]),
          404: errorWith('Resource not found', [
            ERROR_CODES.STATION_NOT_FOUND,
            ERROR_CODES.EVSE_NOT_FOUND,
          ]),
          409: errorWith('Conflict', [
            ERROR_CODES.EVSE_IN_USE,
            ERROR_CODES.MAINTENANCE_ACTIVE,
            ERROR_CODES.TOKEN_DUPLICATE,
          ]),
          502: errorWith('Station rejected', [ERROR_CODES.STATION_REJECTED]),
          504: errorWith('Station did not respond within timeout', [ERROR_CODES.STATION_TIMEOUT]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const body = request.body as z.infer<typeof adHocPaymentBody>;
      const result = await startAdHocPayment(body, userId, request.log);
      if (!result.ok) {
        await reply.status(result.status).send({ error: result.error, code: result.code });
        return;
      }
      return {
        pspRef: body.pspRef,
        stationId: body.stationId,
        evseId: body.evseId,
        replayed: result.replayed,
      };
    },
  );
}
