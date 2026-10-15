// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc, sql, and } from 'drizzle-orm';
import {
  db,
  claimCdrPushRetry,
  createCreditCdr,
  ocpiCdrs,
  ocpiPartners,
  sessionAuditLog,
  supersedeCreditedSessionCdrs,
  writeAudit,
} from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { paginatedResponse, itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { authorize } from '../middleware/rbac.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { sessionInSites } from '../lib/ocpi-site-scope.js';
import type { JwtPayload } from '../plugins/auth.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { publishOcpiCdrRequest } from '../lib/ocpi-cdr-request.js';

const cdrListItem = z
  .object({
    id: z.string().describe('Identifier'),
    partnerId: z.string().nullable().describe('OCPI partner ID, when known'),
    ocpiCdrId: z.string().max(36).describe('OCPI CDR identifier (UUID) used by partners'),
    chargingSessionId: z
      .string()
      .nullable()
      .describe('Linked CSMS charging session ID, when this CDR maps to a local session'),
    totalEnergy: z
      .string()
      .nullable()
      .describe('Total energy delivered in kWh, as a decimal string'),
    totalCost: z
      .string()
      .nullable()
      .describe(
        'Total cost excluding tax as a decimal string (OCPI excl_vat in 2.2.1, before_taxes in 2.3.0). Negative on a credit CDR',
      ),
    currency: z.string().length(3).nullable().describe('ISO 4217 currency code'),
    isCredit: z.boolean().describe('True when this CDR is a credit (refund) for an earlier CDR'),
    hasCredit: z
      .boolean()
      .describe('True when a credit CDR credits this CDR (always false on a credit CDR)'),
    supersededAt: z.coerce
      .date()
      .nullable()
      .describe(
        'When an operator reissued the session after crediting this CDR; null for the live CDR',
      ),
    pushStatus: z
      .enum(['pending', 'sent', 'confirmed', 'failed'])
      .describe('Outbound delivery status to the partner'),
    createdAt: z.coerce.date().describe('Timestamp when the CDR was created'),
    partnerName: z.string().max(255).nullable().describe('Display name of the OCPI partner'),
  })
  .passthrough();

const creditCdrResponse = z
  .object({
    cdrId: z
      .string()
      .describe(
        'OCPI id of the credit CDR. Crediting a CDR that already has a credit CDR returns that one',
      ),
  })
  .passthrough();

const cdrIdParams = z.object({
  id: z.string().min(1).max(36).describe('OCPI CDR identifier (ocpiCdrId)'),
});

const reissueCdrBody = z.object({
  reason: z.string().min(1).max(500).describe('Why the session is billed again'),
});

const reissueCdrResponse = z
  .object({
    chargingSessionId: z.string().describe('The charging session whose CDR is issued again'),
    status: z
      .enum(['reissued', 'pending'])
      .describe(
        'reissued: the credited CDRs were superseded and a new CDR is being issued; pending: a reissue was already asked for and its CDR is not issued yet',
      ),
  })
  .passthrough();

const retryCdrPushResponse = z
  .object({
    cdrId: z.string().describe('OCPI CDR identifier pushed again'),
    pushStatus: z.literal('pending').describe('The CDR waits for the OCPI server to push it'),
  })
  .passthrough();

const cdrQuery = paginationQuery.extend({
  partnerId: ID_PARAMS.ocpiPartnerId.optional().describe('Filter by OCPI partner ID'),
  pushStatus: z
    .enum(['pending', 'sent', 'confirmed', 'failed'])
    .optional()
    .describe('Filter by CDR push status'),
});

const creditCdrBody = z.object({
  originalCdrId: z.string().min(1).describe('OCPI CDR ID to credit'),
  reason: z.string().min(1).max(500).describe('Reason for the credit CDR'),
});

export function ocpiCdrRoutes(app: FastifyInstance): void {
  // GET /ocpi/cdrs - paginated CDRs
  app.get(
    '/ocpi/cdrs',
    {
      onRequest: [authorize('roaming:read')],
      schema: {
        tags: ['OCPI'],
        summary: 'List OCPI charge detail records',
        operationId: 'listOcpiCdrs',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(cdrQuery),
        response: { 200: paginatedResponse(cdrListItem) },
      },
    },
    async (request) => {
      const { page, limit, partnerId, pushStatus } = request.query as z.infer<typeof cdrQuery>;
      const offset = (page - 1) * limit;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) return { data: [], total: 0 };

      const conditions = [];
      if (siteIds != null) {
        conditions.push(sessionInSites(ocpiCdrs.chargingSessionId, siteIds));
      }
      if (partnerId != null) {
        conditions.push(eq(ocpiCdrs.partnerId, partnerId));
      }
      if (pushStatus != null) {
        conditions.push(eq(ocpiCdrs.pushStatus, pushStatus));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [data, countRows] = await Promise.all([
        db
          .select({
            id: ocpiCdrs.id,
            partnerId: ocpiCdrs.partnerId,
            ocpiCdrId: ocpiCdrs.ocpiCdrId,
            chargingSessionId: ocpiCdrs.chargingSessionId,
            totalEnergy: ocpiCdrs.totalEnergy,
            totalCost: ocpiCdrs.totalCost,
            currency: ocpiCdrs.currency,
            isCredit: ocpiCdrs.isCredit,
            supersededAt: ocpiCdrs.supersededAt,
            hasCredit: sql<boolean>`(${ocpiCdrs.isCredit} = false AND EXISTS (
              SELECT 1 FROM ocpi_cdrs credit
              WHERE credit.partner_id = ${ocpiCdrs.partnerId}
                AND credit.is_credit = true
                AND credit.cdr_data->>'credit_reference_id' = ${ocpiCdrs.ocpiCdrId}
            ))`,
            pushStatus: ocpiCdrs.pushStatus,
            createdAt: ocpiCdrs.createdAt,
            partnerName: ocpiPartners.name,
          })
          .from(ocpiCdrs)
          .leftJoin(ocpiPartners, eq(ocpiCdrs.partnerId, ocpiPartners.id))
          .where(where)
          .orderBy(desc(ocpiCdrs.createdAt), desc(ocpiCdrs.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(ocpiCdrs)
          .where(where),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // POST /ocpi/cdrs/credit - create a credit CDR
  app.post(
    '/ocpi/cdrs/credit',
    {
      onRequest: [authorize('roaming:write')],
      schema: {
        tags: ['OCPI'],
        summary: 'Create a credit CDR',
        operationId: 'createOcpiCreditCdr',
        security: [{ bearerAuth: [] }],
        body: zodSchema(creditCdrBody),
        response: {
          201: itemResponse(creditCdrResponse),
          400: errorWith('Credit CDR not possible', [
            ERROR_CODES.INVALID_OPERATION,
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          404: errorWith('Cdr not found', [ERROR_CODES.CDR_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof creditCdrBody>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null) {
        // A site-restricted user credits only CDRs of sessions at its own
        // sites. Any other CDR answers like an unknown one.
        const [inScope] =
          siteIds.length === 0
            ? []
            : await db
                .select({ id: ocpiCdrs.id })
                .from(ocpiCdrs)
                .where(
                  and(
                    eq(ocpiCdrs.ocpiCdrId, body.originalCdrId),
                    sessionInSites(ocpiCdrs.chargingSessionId, siteIds),
                  ),
                )
                .limit(1);
        if (inScope == null) {
          await reply.status(404).send({ error: 'CDR not found', code: 'CDR_NOT_FOUND' });
          return;
        }
      }

      // One credit CDR builder for the API and the OCPI server (OCPI 10.1.1:
      // only total_cost is negated, in the Price shape of the CDR's version).
      const result = await createCreditCdr(body.originalCdrId, body.reason);
      switch (result.status) {
        case 'not_found':
          await reply.status(404).send({ error: 'CDR not found', code: 'CDR_NOT_FOUND' });
          return;
        case 'is_credit':
          await reply
            .status(400)
            .send({ error: 'Cannot credit a credit CDR', code: 'INVALID_OPERATION' });
          return;
        case 'invalid_cdr':
          await reply
            .status(400)
            .send({ error: 'The CDR has no total cost to credit', code: 'VALIDATION_ERROR' });
          return;
        case 'created':
          // Only a new credit CDR is audited: 'existing' is a retry of a
          // credit already recorded.
          await writeAudit(
            { table: sessionAuditLog, idColumn: 'session_id' },
            {
              entityId: result.chargingSessionId,
              entityIdSnapshot: result.chargingSessionId,
              action: 'cdr_credited',
              ...getAuditActor(request),
              before: null,
              after: {
                originalCdrId: body.originalCdrId,
                creditCdrId: result.cdrId,
                partnerId: result.partnerId,
                totalCost: result.cdrData['total_cost'] ?? null,
              },
              notes: body.reason,
            },
            db,
            request.log,
          );
          await reply.status(201).send({ cdrId: result.cdrId });
          return;
        case 'existing':
          await reply.status(201).send({ cdrId: result.cdrId });
          return;
      }
    },
  );

  /**
   * Whether a site-restricted user may act on the CDR: only CDRs of sessions
   * at its own sites. Any other CDR answers like an unknown one.
   */
  async function cdrInUserScope(userId: string, cdrId: string): Promise<boolean> {
    const siteIds = await getUserSiteIds(userId);
    if (siteIds == null) return true;
    if (siteIds.length === 0) return false;
    const [inScope] = await db
      .select({ id: ocpiCdrs.id })
      .from(ocpiCdrs)
      .where(
        and(eq(ocpiCdrs.ocpiCdrId, cdrId), sessionInSites(ocpiCdrs.chargingSessionId, siteIds)),
      )
      .limit(1);
    return inScope != null;
  }

  // POST /ocpi/cdrs/:id/reissue - bill a credited session again with a new CDR
  app.post(
    '/ocpi/cdrs/:id/reissue',
    {
      onRequest: [authorize('roaming:write')],
      schema: {
        tags: ['OCPI'],
        summary: 'Reissue the CDR of a credited roaming session',
        description:
          'OCPI 10.1: a sent CDR is never changed. After every CDR of the session was credited, a new CDR with a new id is issued from the session and sent to the partner. Use it after correcting a session that was billed wrong.',
        operationId: 'reissueOcpiCdr',
        security: [{ bearerAuth: [] }],
        params: zodSchema(cdrIdParams),
        body: zodSchema(reissueCdrBody),
        response: {
          202: itemResponse(reissueCdrResponse),
          404: errorWith('Cdr not found', [ERROR_CODES.CDR_NOT_FOUND]),
          409: errorWith('A CDR of the session is not credited', [ERROR_CODES.CDR_NOT_CREDITED]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof cdrIdParams>;
      const body = request.body as z.infer<typeof reissueCdrBody>;
      const { userId } = request.user as JwtPayload;
      if (!(await cdrInUserScope(userId, id))) {
        await reply.status(404).send({ error: 'CDR not found', code: 'CDR_NOT_FOUND' });
        return;
      }

      const result = await supersedeCreditedSessionCdrs(id);
      switch (result.status) {
        case 'not_found':
          await reply.status(404).send({ error: 'CDR not found', code: 'CDR_NOT_FOUND' });
          return;
        case 'not_credited':
          await reply.status(409).send({
            error: 'Credit every CDR of the session before reissuing it',
            code: 'CDR_NOT_CREDITED',
            details: { cdrId: result.cdrId },
          });
          return;
        case 'pending':
          // A repeat before the new CDR exists: the job is asked for again
          // (deduplicated by its generation), nothing else changes.
          await publishOcpiCdrRequest({
            sessionId: result.chargingSessionId,
            generation: result.generation,
          });
          await reply
            .status(202)
            .send({ chargingSessionId: result.chargingSessionId, status: 'pending' });
          return;
        case 'reissued':
          await writeAudit(
            { table: sessionAuditLog, idColumn: 'session_id' },
            {
              entityId: result.chargingSessionId,
              entityIdSnapshot: result.chargingSessionId,
              action: 'cdr_reissued',
              ...getAuditActor(request),
              before: { liveCdrIds: result.supersededCdrIds },
              after: { supersededCdrIds: result.supersededCdrIds, partnerId: result.partnerId },
              notes: body.reason,
            },
            db,
            request.log,
          );
          await publishOcpiCdrRequest({
            sessionId: result.chargingSessionId,
            generation: result.generation,
          });
          await reply
            .status(202)
            .send({ chargingSessionId: result.chargingSessionId, status: 'reissued' });
          return;
      }
    },
  );

  // POST /ocpi/cdrs/:id/push - push a CDR whose push failed again
  app.post(
    '/ocpi/cdrs/:id/push',
    {
      onRequest: [authorize('roaming:write')],
      schema: {
        tags: ['OCPI'],
        summary: 'Push a failed CDR to its partner again',
        operationId: 'retryOcpiCdrPush',
        security: [{ bearerAuth: [] }],
        params: zodSchema(cdrIdParams),
        response: {
          202: itemResponse(retryCdrPushResponse),
          404: errorWith('Cdr not found', [ERROR_CODES.CDR_NOT_FOUND]),
          409: errorWith('The CDR push did not fail', [ERROR_CODES.CDR_PUSH_NOT_FAILED]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof cdrIdParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await cdrInUserScope(userId, id))) {
        await reply.status(404).send({ error: 'CDR not found', code: 'CDR_NOT_FOUND' });
        return;
      }

      const result = await claimCdrPushRetry(id);
      switch (result.status) {
        case 'not_found':
          await reply.status(404).send({ error: 'CDR not found', code: 'CDR_NOT_FOUND' });
          return;
        case 'not_failed':
          await reply.status(409).send({
            error: 'Only a CDR whose push failed can be pushed again',
            code: 'CDR_PUSH_NOT_FAILED',
            details: { pushStatus: result.pushStatus },
          });
          return;
        case 'claimed':
          await writeAudit(
            { table: sessionAuditLog, idColumn: 'session_id' },
            {
              entityId: result.chargingSessionId,
              entityIdSnapshot: result.chargingSessionId,
              action: 'cdr_push_retried',
              ...getAuditActor(request),
              before: { cdrId: id, pushStatus: 'failed' },
              after: { cdrId: id, pushStatus: 'pending', partnerId: result.partnerId },
              notes: null,
            },
            db,
            request.log,
          );
          await publishOcpiCdrRequest({ cdrId: id, retry: result.retry });
          await reply.status(202).send({ cdrId: id, pushStatus: 'pending' });
          return;
      }
    },
  );
}
