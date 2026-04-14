// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc, sql, and } from 'drizzle-orm';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import {
  db,
  ocpiPartners,
  ocpiPartnerEndpoints,
  ocpiCredentialsTokens,
  ocpiSyncLog,
} from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import {
  errorResponse,
  successResponse,
  paginatedResponse,
  itemResponse,
} from '../lib/response-schemas.js';
import { isPrivateUrl } from '@evtivity/lib';
import { getPubSub } from '../lib/pubsub.js';
import { authorize } from '../middleware/rbac.js';

const ocpiPartnerItem = z.object({}).passthrough();

const createPartnerResponse = z
  .object({ partner: z.object({}).passthrough(), registrationToken: z.string() })
  .passthrough();

const registerSyncResponse = z.object({ message: z.string() }).passthrough();

const syncLogItem = z
  .object({
    id: z.string(),
    partnerId: z.string(),
    module: z.string(),
    direction: z.string(),
    action: z.string(),
    status: z.string(),
    objectsCount: z.number().nullable(),
    errorMessage: z.string().nullable(),
    createdAt: z.coerce.date(),
  })
  .passthrough();

const partnerParams = z.object({
  id: ID_PARAMS.ocpiPartnerId.describe('OCPI partner ID'),
});

const createPartnerBody = z.object({
  name: z.string().min(1).max(255),
  countryCode: z.string().length(2).describe('ISO 3166-1 alpha-2 country code'),
  partyId: z.string().min(1).max(3).describe('OCPI party identifier'),
  versionUrl: z.string().url().optional().describe('OCPI versions endpoint URL'),
});

const updatePartnerBody = z.object({
  name: z.string().min(1).max(255).optional(),
  status: z
    .enum(['pending', 'connected', 'suspended', 'disconnected'])
    .optional()
    .describe('Partner connection status'),
  versionUrl: z.string().url().optional().describe('OCPI versions endpoint URL'),
});

const syncParams = z.object({
  id: ID_PARAMS.ocpiPartnerId.describe('OCPI partner ID'),
  module: z.string().min(1).describe('OCPI module name to sync (e.g. locations, tariffs, cdrs)'),
});

const syncLogQuery = paginationQuery.extend({
  partnerId: ID_PARAMS.ocpiPartnerId.optional().describe('Filter sync logs by partner ID'),
});

export function ocpiPartnerRoutes(app: FastifyInstance): void {
  // GET /ocpi/partners - list partners
  app.get(
    '/ocpi/partners',
    {
      onRequest: [authorize('roaming:read')],
      schema: {
        tags: ['OCPI'],
        summary: 'List OCPI partners',
        operationId: 'listOcpiPartners',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(ocpiPartnerItem) },
      },
    },
    async (request) => {
      const { page, limit, search } = request.query as z.infer<typeof paginationQuery>;
      const offset = (page - 1) * limit;

      const conditions = [];
      if (search != null && search !== '') {
        conditions.push(
          sql`(${ocpiPartners.name} ILIKE ${'%' + search + '%'} OR ${ocpiPartners.countryCode} ILIKE ${'%' + search + '%'} OR ${ocpiPartners.partyId} ILIKE ${'%' + search + '%'})`,
        );
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [data, countRows] = await Promise.all([
        db
          .select()
          .from(ocpiPartners)
          .where(where)
          .orderBy(desc(ocpiPartners.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(ocpiPartners)
          .where(where),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // GET /ocpi/partners/:id - partner detail with endpoints
  app.get(
    '/ocpi/partners/:id',
    {
      onRequest: [authorize('roaming:read')],
      schema: {
        tags: ['OCPI'],
        summary: 'Get OCPI partner details',
        operationId: 'getOcpiPartner',
        security: [{ bearerAuth: [] }],
        params: zodSchema(partnerParams),
        response: { 200: itemResponse(ocpiPartnerItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof partnerParams>;

      const [partner] = await db
        .select()
        .from(ocpiPartners)
        .where(eq(ocpiPartners.id, id))
        .limit(1);

      if (partner == null) {
        await reply.status(404).send({ error: 'Partner not found', code: 'PARTNER_NOT_FOUND' });
        return;
      }

      const endpoints = await db
        .select()
        .from(ocpiPartnerEndpoints)
        .where(eq(ocpiPartnerEndpoints.partnerId, id));

      return { ...partner, endpoints };
    },
  );

  // POST /ocpi/partners - create partner + generate registration token
  app.post(
    '/ocpi/partners',
    {
      onRequest: [authorize('roaming:write')],
      schema: {
        tags: ['OCPI'],
        summary: 'Create OCPI partner',
        operationId: 'createOcpiPartner',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createPartnerBody),
        response: {
          201: itemResponse(createPartnerResponse),
          400: errorResponse,
          409: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createPartnerBody>;

      // Check for duplicate
      const existing = await db
        .select({ id: ocpiPartners.id })
        .from(ocpiPartners)
        .where(
          and(
            eq(ocpiPartners.countryCode, body.countryCode),
            eq(ocpiPartners.partyId, body.partyId),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        await reply.status(409).send({
          error: 'Partner with this country code and party ID already exists',
          code: 'DUPLICATE_PARTNER',
        });
        return;
      }

      if (body.versionUrl != null && isPrivateUrl(body.versionUrl)) {
        await reply.status(400).send({
          error: 'Version URL must not point to a private or internal address',
          code: 'PRIVATE_URL',
        });
        return;
      }

      const [partner] = await db
        .insert(ocpiPartners)
        .values({
          name: body.name,
          countryCode: body.countryCode,
          partyId: body.partyId,
          versionUrl: body.versionUrl,
          status: 'pending',
          roles: [],
          ourRoles: [],
        })
        .returning();

      if (partner == null) {
        await reply.status(500).send({ error: 'Failed to create partner', code: 'INTERNAL_ERROR' });
        return;
      }

      // Generate registration token for the partner to use
      const registrationToken = randomBytes(32).toString('hex');
      const tokenHash = await argon2.hash(registrationToken);

      await db.insert(ocpiCredentialsTokens).values({
        partnerId: partner.id,
        tokenHash,
        tokenPrefix: registrationToken.slice(0, 8),
        direction: 'received',
        isActive: true,
      });

      await reply.status(201).send({
        partner,
        registrationToken,
      });
    },
  );

  // PATCH /ocpi/partners/:id - update partner
  app.patch(
    '/ocpi/partners/:id',
    {
      onRequest: [authorize('roaming:write')],
      schema: {
        tags: ['OCPI'],
        summary: 'Update OCPI partner',
        operationId: 'updateOcpiPartner',
        security: [{ bearerAuth: [] }],
        params: zodSchema(partnerParams),
        body: zodSchema(updatePartnerBody),
        response: { 200: itemResponse(ocpiPartnerItem), 400: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof partnerParams>;
      const body = request.body as z.infer<typeof updatePartnerBody>;

      const [existing] = await db
        .select({ id: ocpiPartners.id })
        .from(ocpiPartners)
        .where(eq(ocpiPartners.id, id))
        .limit(1);

      if (existing == null) {
        await reply.status(404).send({ error: 'Partner not found', code: 'PARTNER_NOT_FOUND' });
        return;
      }

      if (body.versionUrl != null && isPrivateUrl(body.versionUrl)) {
        await reply.status(400).send({
          error: 'Version URL must not point to a private or internal address',
          code: 'PRIVATE_URL',
        });
        return;
      }

      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name != null) updateData['name'] = body.name;
      if (body.status != null) updateData['status'] = body.status;
      if (body.versionUrl != null) updateData['versionUrl'] = body.versionUrl;

      const [updated] = await db
        .update(ocpiPartners)
        .set(updateData)
        .where(eq(ocpiPartners.id, id))
        .returning();

      return updated;
    },
  );

  // DELETE /ocpi/partners/:id - disconnect partner
  app.delete(
    '/ocpi/partners/:id',
    {
      onRequest: [authorize('roaming:write')],
      schema: {
        tags: ['OCPI'],
        summary: 'Disconnect OCPI partner',
        operationId: 'deleteOcpiPartner',
        security: [{ bearerAuth: [] }],
        params: zodSchema(partnerParams),
        response: { 200: successResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof partnerParams>;

      const [existing] = await db
        .select({ id: ocpiPartners.id })
        .from(ocpiPartners)
        .where(eq(ocpiPartners.id, id))
        .limit(1);

      if (existing == null) {
        await reply.status(404).send({ error: 'Partner not found', code: 'PARTNER_NOT_FOUND' });
        return;
      }

      await db
        .update(ocpiPartners)
        .set({ status: 'disconnected', updatedAt: new Date() })
        .where(eq(ocpiPartners.id, id));

      // Deactivate all tokens
      await db
        .update(ocpiCredentialsTokens)
        .set({ isActive: false })
        .where(
          and(eq(ocpiCredentialsTokens.partnerId, id), eq(ocpiCredentialsTokens.isActive, true)),
        );

      return { success: true };
    },
  );

  // POST /ocpi/partners/:id/register - initiate outbound registration
  app.post(
    '/ocpi/partners/:id/register',
    {
      onRequest: [authorize('roaming:write')],
      schema: {
        tags: ['OCPI'],
        summary: 'Initiate outbound OCPI registration',
        operationId: 'registerOcpiPartner',
        security: [{ bearerAuth: [] }],
        params: zodSchema(partnerParams),
        response: {
          200: itemResponse(registerSyncResponse),
          400: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof partnerParams>;

      const [partner] = await db
        .select()
        .from(ocpiPartners)
        .where(eq(ocpiPartners.id, id))
        .limit(1);

      if (partner == null) {
        await reply.status(404).send({ error: 'Partner not found', code: 'PARTNER_NOT_FOUND' });
        return;
      }

      if (partner.versionUrl == null || partner.versionUrl === '') {
        await reply.status(400).send({
          error: 'Partner version URL is required for registration',
          code: 'MISSING_VERSION_URL',
        });
        return;
      }

      // Registration is done via the OCPI server, notify via pub/sub
      const pubsub = getPubSub();
      await pubsub.publish(
        'ocpi_register',
        JSON.stringify({ partnerId: id, versionUrl: partner.versionUrl }),
      );

      return { message: 'Registration initiated' };
    },
  );

  // POST /ocpi/partners/:id/sync/:module - trigger manual sync
  app.post(
    '/ocpi/partners/:id/sync/:module',
    {
      onRequest: [authorize('roaming:write')],
      schema: {
        tags: ['OCPI'],
        summary: 'Trigger manual OCPI module sync',
        operationId: 'syncOcpiPartnerModule',
        security: [{ bearerAuth: [] }],
        params: zodSchema(syncParams),
        response: {
          200: itemResponse(registerSyncResponse),
          400: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id, module } = request.params as z.infer<typeof syncParams>;

      const [partner] = await db
        .select({ id: ocpiPartners.id, status: ocpiPartners.status })
        .from(ocpiPartners)
        .where(eq(ocpiPartners.id, id))
        .limit(1);

      if (partner == null) {
        await reply.status(404).send({ error: 'Partner not found', code: 'PARTNER_NOT_FOUND' });
        return;
      }

      if (partner.status !== 'connected') {
        await reply.status(400).send({
          error: 'Partner must be connected to sync',
          code: 'PARTNER_NOT_CONNECTED',
        });
        return;
      }

      const pubsub = getPubSub();
      await pubsub.publish('ocpi_sync', JSON.stringify({ partnerId: id, module }));

      return { message: `Sync initiated for module: ${module}` };
    },
  );

  // GET /ocpi/sync-log - sync history
  app.get(
    '/ocpi/sync-log',
    {
      onRequest: [authorize('roaming:read')],
      schema: {
        tags: ['OCPI'],
        summary: 'List OCPI sync log entries',
        operationId: 'listOcpiSyncLog',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(syncLogQuery),
        response: { 200: paginatedResponse(syncLogItem) },
      },
    },
    async (request) => {
      const { page, limit, partnerId } = request.query as z.infer<typeof syncLogQuery>;
      const offset = (page - 1) * limit;

      const conditions = [];
      if (partnerId != null) {
        conditions.push(eq(ocpiSyncLog.partnerId, partnerId));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [data, countRows] = await Promise.all([
        db
          .select({
            id: ocpiSyncLog.id,
            partnerId: ocpiSyncLog.partnerId,
            module: ocpiSyncLog.module,
            direction: ocpiSyncLog.direction,
            action: ocpiSyncLog.action,
            status: ocpiSyncLog.status,
            objectsCount: ocpiSyncLog.objectsCount,
            errorMessage: ocpiSyncLog.errorMessage,
            createdAt: ocpiSyncLog.createdAt,
          })
          .from(ocpiSyncLog)
          .where(where)
          .orderBy(desc(ocpiSyncLog.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(ocpiSyncLog)
          .where(where),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );
}
