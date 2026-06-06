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
  writeAudit,
  ocpiPartnerAuditLog,
} from '@evtivity/database';
import { getAuditActor } from '../lib/audit-actor.js';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import {
  successResponse,
  paginatedResponse,
  itemResponse,
  errorWith,
} from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { isPrivateUrl, encryptString } from '@evtivity/lib';
import { getPubSub } from '../lib/pubsub.js';
import { config as apiConfig } from '../lib/config.js';
import { authorize } from '../middleware/rbac.js';

const ocpiPartnerItem = z
  .object({
    id: z.string().describe('OCPI partner ID'),
    name: z.string().max(255).describe('Partner name'),
    countryCode: z.string().length(2).describe('ISO 3166-1 alpha-2 country code'),
    partyId: z.string().max(3).describe('OCPI party identifier'),
    roles: z.unknown().describe('OCPI roles advertised by the partner'),
    ourRoles: z.unknown().describe('OCPI roles advertised by this CSMS to the partner'),
    status: z
      .enum(['pending', 'connected', 'suspended', 'disconnected'])
      .describe('Partner connection status'),
    version: z.string().max(20).nullable().describe('Negotiated OCPI version'),
    versionUrl: z.string().max(2048).nullable().describe('OCPI versions endpoint URL'),
    hasPartnerRegistrationToken: z
      .boolean()
      .describe(
        'True when a partner registration token is stored; the ciphertext itself is never returned. Operators rotate it via PATCH partnerRegistrationToken.',
      ),
    createdAt: z.string().describe('Row creation timestamp'),
    updatedAt: z.string().describe('Row last update timestamp'),
  })
  .passthrough();

interface PartnerRow {
  id: string;
  name: string;
  countryCode: string;
  partyId: string;
  roles: unknown;
  ourRoles: unknown;
  status: 'pending' | 'connected' | 'suspended' | 'disconnected';
  version: string | null;
  versionUrl: string | null;
  partnerRegistrationTokenEnc: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// Strip the encrypted registration-token ciphertext from API responses and
// surface a presence boolean instead. The ciphertext is operationally a
// secret — leaking it expands the attack surface even though the symmetric
// key is held server-side.
function publicPartner(row: PartnerRow): Omit<PartnerRow, 'partnerRegistrationTokenEnc'> & {
  hasPartnerRegistrationToken: boolean;
} {
  const { partnerRegistrationTokenEnc, ...rest } = row;
  return {
    ...rest,
    hasPartnerRegistrationToken: partnerRegistrationTokenEnc != null,
  };
}

const createPartnerResponse = z
  .object({
    partner: ocpiPartnerItem.describe('Created partner record'),
    registrationToken: z
      .string()
      .max(255)
      .describe('One-time registration token to share with the partner'),
  })
  .passthrough();

const syncLogItem = z
  .object({
    // ocpi_sync_log.id is `serial integer` in the DB schema; the Zod type
    // must match or fast-json-stringify mangles the response.
    id: z.number().int().describe('Identifier'),
    partnerId: z.string().describe('OCPI partner ID'),
    module: z
      .enum(['locations', 'tariffs', 'cdrs', 'tokens', 'sessions', 'commands'])
      .describe('OCPI module name involved in the sync'),
    direction: z.enum(['push', 'pull']).describe('Whether data flowed out (push) or in (pull)'),
    action: z.string().max(50).describe('Specific action performed (e.g., pull, push, register)'),
    status: z.enum(['started', 'completed', 'failed']).describe('Outcome status of the sync'),
    // ocpi_sync_log.objects_count is `varchar(10) NOT NULL DEFAULT '0'`.
    objectsCount: z.string().max(10).describe('Number of objects transferred during the sync'),
    errorMessage: z.string().max(1000).nullable().describe('Error details when the sync failed'),
    createdAt: z.coerce.date().describe('Timestamp when the sync ran'),
  })
  .passthrough();

const partnerParams = z.object({
  id: ID_PARAMS.ocpiPartnerId.describe('OCPI partner ID'),
});

const createPartnerBody = z.object({
  name: z.string().min(1).max(255),
  countryCode: z.string().length(2).describe('ISO 3166-1 alpha-2 country code'),
  partyId: z.string().min(1).max(3).describe('OCPI party identifier'),
  versionUrl: z.string().url().max(2048).optional().describe('OCPI versions endpoint URL'),
  partnerRegistrationToken: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe(
      "Partner's OOB-shared OCPI 2.2.1 Token C. Required only for outbound registration, when WE are the Sender calling the partner's /credentials endpoint.",
    ),
});

const updatePartnerBody = z.object({
  name: z.string().min(1).max(255).optional(),
  status: z
    .enum(['pending', 'connected', 'suspended', 'disconnected'])
    .optional()
    .describe('Partner connection status'),
  versionUrl: z.string().url().max(2048).optional().describe('OCPI versions endpoint URL'),
  partnerRegistrationToken: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe(
      "Partner's OOB-shared OCPI 2.2.1 Token C. Set or rotate when the partner provides a new outbound-registration token.",
    ),
});

const syncParams = z.object({
  id: ID_PARAMS.ocpiPartnerId.describe('OCPI partner ID'),
  module: z
    .enum(['locations', 'tariffs', 'cdrs', 'tokens', 'sessions'])
    .describe('OCPI module name to sync'),
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
          .orderBy(desc(ocpiPartners.createdAt), desc(ocpiPartners.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(ocpiPartners)
          .where(where),
      ]);

      return {
        data: data.map((row) => publicPartner(row)),
        total: countRows[0]?.count ?? 0,
      } satisfies PaginatedResponse<ReturnType<typeof publicPartner>>;
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
        response: {
          200: itemResponse(ocpiPartnerItem),
          404: errorWith('Partner not found', [ERROR_CODES.PARTNER_NOT_FOUND]),
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

      const endpoints = await db
        .select()
        .from(ocpiPartnerEndpoints)
        .where(eq(ocpiPartnerEndpoints.partnerId, id));

      return { ...publicPartner(partner), endpoints };
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
          400: errorWith('Private url', [ERROR_CODES.PRIVATE_URL]),
          409: errorWith('Duplicate partner', [ERROR_CODES.DUPLICATE_PARTNER]),
          500: errorWith('Internal error', [ERROR_CODES.INTERNAL_ERROR]),
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

      const partnerRegistrationTokenEnc =
        body.partnerRegistrationToken != null
          ? encryptString(body.partnerRegistrationToken, apiConfig.SETTINGS_ENCRYPTION_KEY)
          : null;

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
          partnerRegistrationTokenEnc,
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

      const actor = getAuditActor(request);
      await writeAudit(
        { table: ocpiPartnerAuditLog, idColumn: 'ocpi_partner_id' },
        {
          entityId: partner.id,
          entityIdSnapshot: partner.id,
          action: 'created',
          ...actor,
          after: partner,
        },
        db,
        request.log,
      );

      await reply.status(201).send({
        partner: publicPartner(partner),
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
        response: {
          200: itemResponse(ocpiPartnerItem),
          400: errorWith('Private url', [ERROR_CODES.PRIVATE_URL]),
          404: errorWith('Partner not found', [ERROR_CODES.PARTNER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof partnerParams>;
      const body = request.body as z.infer<typeof updatePartnerBody>;

      // The before-snapshot SELECT also serves as the existence check, so we
      // don't need a separate id-only SELECT first.
      const [before] = await db.select().from(ocpiPartners).where(eq(ocpiPartners.id, id));

      if (before == null) {
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
      if (body.partnerRegistrationToken != null) {
        updateData['partnerRegistrationTokenEnc'] = encryptString(
          body.partnerRegistrationToken,
          apiConfig.SETTINGS_ENCRYPTION_KEY,
        );
      }

      const [updated] = await db
        .update(ocpiPartners)
        .set(updateData)
        .where(eq(ocpiPartners.id, id))
        .returning();

      if (updated != null) {
        const actor = getAuditActor(request);
        await writeAudit(
          { table: ocpiPartnerAuditLog, idColumn: 'ocpi_partner_id' },
          {
            entityId: updated.id,
            entityIdSnapshot: updated.id,
            action: 'updated',
            ...actor,
            before,
            after: updated,
          },
          db,
          request.log,
        );
      }

      return updated != null ? publicPartner(updated) : null;
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
        response: {
          200: successResponse,
          404: errorWith('Partner not found', [ERROR_CODES.PARTNER_NOT_FOUND]),
        },
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

      const actor = getAuditActor(request);
      await writeAudit(
        { table: ocpiPartnerAuditLog, idColumn: 'ocpi_partner_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'disconnected',
          ...actor,
        },
        db,
        request.log,
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
        description:
          'Publishes an ocpi_register event so the OCPI server kicks off the credentials handshake against the partner versionUrl. Registration is asynchronous; the partner status updates as the OCPI server progresses through versions, endpoints, and credentials POST. Returns 400 if the partner has no versionUrl configured.',
        operationId: 'registerOcpiPartner',
        security: [{ bearerAuth: [] }],
        params: zodSchema(partnerParams),
        response: {
          200: successResponse,
          400: errorWith('Missing version url', [ERROR_CODES.MISSING_VERSION_URL]),
          404: errorWith('Partner not found', [ERROR_CODES.PARTNER_NOT_FOUND]),
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

      const actor = getAuditActor(request);
      await writeAudit(
        { table: ocpiPartnerAuditLog, idColumn: 'ocpi_partner_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'registered',
          ...actor,
        },
        db,
        request.log,
      );

      return { success: true };
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
        description:
          'Publishes an ocpi_sync event so the OCPI server pulls the requested module (locations, tariffs, cdrs, tokens) from the partner sender endpoint. Results are upserted into the corresponding ocpi_external_* tables. Returns immediately; track sync progress via the sync log endpoint.',
        operationId: 'syncOcpiPartnerModule',
        security: [{ bearerAuth: [] }],
        params: zodSchema(syncParams),
        response: {
          200: successResponse,
          400: errorWith('Partner not connected', [ERROR_CODES.PARTNER_NOT_CONNECTED]),
          404: errorWith('Partner not found', [ERROR_CODES.PARTNER_NOT_FOUND]),
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

      const actor = getAuditActor(request);
      await writeAudit(
        { table: ocpiPartnerAuditLog, idColumn: 'ocpi_partner_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'sync_triggered',
          ...actor,
          notes: `Module: ${module}`,
        },
        db,
        request.log,
      );

      return { success: true };
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
          .orderBy(desc(ocpiSyncLog.createdAt), desc(ocpiSyncLog.id))
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
