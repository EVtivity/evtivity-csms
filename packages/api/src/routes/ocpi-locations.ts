// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, sites, ocpiLocationPublish, ocpiLocationPublishPartners } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { getPubSub } from '../lib/pubsub.js';
import { authorize } from '../middleware/rbac.js';
import {
  errorResponse,
  successResponse,
  itemResponse,
  arrayResponse,
} from '../lib/response-schemas.js';

const locationPublishListItem = z
  .object({
    id: z.string(),
    name: z.string(),
    address: z.string().nullable(),
    city: z.string().nullable(),
    country: z.string().nullable(),
    isPublished: z.boolean(),
    publishToAll: z.boolean(),
    ocpiLocationId: z.string().nullable(),
  })
  .passthrough();

const locationPublishDetail = z
  .object({
    siteId: z.string(),
    siteName: z.string(),
    isPublished: z.boolean(),
    publishToAll: z.boolean(),
    ocpiLocationId: z.string().nullable(),
    partnerIds: z.array(z.string()),
  })
  .passthrough();

const siteParams = z.object({
  siteId: ID_PARAMS.siteId.describe('Site ID'),
});

const publishBody = z.object({
  isPublished: z.boolean().describe('Whether the location is published to OCPI partners'),
  publishToAll: z
    .boolean()
    .optional()
    .describe('If true, publish to all partners. If false, use partnerIds list'),
  ocpiLocationId: z.string().max(36).optional().describe('Custom OCPI location identifier'),
  partnerIds: z
    .array(ID_PARAMS.ocpiPartnerId)
    .optional()
    .describe('Partner IDs to publish to when publishToAll is false'),
});

export function ocpiLocationRoutes(app: FastifyInstance): void {
  // GET /ocpi/locations - list all sites with publish status
  app.get(
    '/ocpi/locations',
    {
      onRequest: [authorize('roaming:read')],
      schema: {
        tags: ['OCPI'],
        summary: 'List all sites with OCPI publish status',
        operationId: 'listOcpiLocations',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(locationPublishListItem) },
      },
    },
    async () => {
      const siteRows = await db
        .select({
          id: sites.id,
          name: sites.name,
          address: sites.address,
          city: sites.city,
          country: sites.country,
        })
        .from(sites)
        .orderBy(sites.name);

      const publishRows = await db.select().from(ocpiLocationPublish);

      const publishMap = new Map<string, (typeof publishRows)[number]>();
      for (const row of publishRows) {
        publishMap.set(row.siteId, row);
      }

      return siteRows.map((site) => {
        const pub = publishMap.get(site.id);
        return {
          ...site,
          isPublished: pub?.isPublished ?? false,
          publishToAll: pub?.publishToAll ?? true,
          ocpiLocationId: pub?.ocpiLocationId ?? null,
        };
      });
    },
  );

  // GET /ocpi/locations/:siteId - get publish settings for a site
  app.get(
    '/ocpi/locations/:siteId',
    {
      onRequest: [authorize('roaming:read')],
      schema: {
        tags: ['OCPI'],
        summary: 'Get OCPI publish settings for a site',
        operationId: 'getOcpiLocation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        response: { 200: itemResponse(locationPublishDetail), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { siteId } = request.params as z.infer<typeof siteParams>;

      const [site] = await db
        .select({ id: sites.id, name: sites.name })
        .from(sites)
        .where(eq(sites.id, siteId))
        .limit(1);

      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const [publish] = await db
        .select()
        .from(ocpiLocationPublish)
        .where(eq(ocpiLocationPublish.siteId, siteId))
        .limit(1);

      let partnerIds: string[] = [];
      if (publish != null && !publish.publishToAll) {
        const partners = await db
          .select({ partnerId: ocpiLocationPublishPartners.partnerId })
          .from(ocpiLocationPublishPartners)
          .where(eq(ocpiLocationPublishPartners.locationPublishId, publish.id));
        partnerIds = partners.map((p) => p.partnerId);
      }

      return {
        siteId,
        siteName: site.name,
        isPublished: publish?.isPublished ?? false,
        publishToAll: publish?.publishToAll ?? true,
        ocpiLocationId: publish?.ocpiLocationId ?? null,
        partnerIds,
      };
    },
  );

  // PUT /ocpi/locations/:siteId - update publish settings
  app.put(
    '/ocpi/locations/:siteId',
    {
      onRequest: [authorize('roaming:write')],
      schema: {
        tags: ['OCPI'],
        summary: 'Update OCPI publish settings for a site',
        operationId: 'updateOcpiLocation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        body: zodSchema(publishBody),
        response: { 200: successResponse, 404: errorResponse, 500: errorResponse },
      },
    },
    async (request, reply) => {
      const { siteId } = request.params as z.infer<typeof siteParams>;
      const body = request.body as z.infer<typeof publishBody>;

      const [site] = await db
        .select({ id: sites.id })
        .from(sites)
        .where(eq(sites.id, siteId))
        .limit(1);

      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const [existing] = await db
        .select()
        .from(ocpiLocationPublish)
        .where(eq(ocpiLocationPublish.siteId, siteId))
        .limit(1);

      let publishId: number;

      if (existing != null) {
        const updateData: Record<string, unknown> = {
          isPublished: body.isPublished,
          updatedAt: new Date(),
        };
        if (body.publishToAll != null) updateData['publishToAll'] = body.publishToAll;
        if (body.ocpiLocationId != null) updateData['ocpiLocationId'] = body.ocpiLocationId;

        await db
          .update(ocpiLocationPublish)
          .set(updateData)
          .where(eq(ocpiLocationPublish.id, existing.id));
        publishId = existing.id;
      } else {
        const insertValues: {
          siteId: string;
          isPublished: boolean;
          publishToAll?: boolean;
          ocpiLocationId?: string;
        } = {
          siteId,
          isPublished: body.isPublished,
        };
        if (body.publishToAll != null) insertValues.publishToAll = body.publishToAll;
        if (body.ocpiLocationId != null) insertValues.ocpiLocationId = body.ocpiLocationId;

        const [inserted] = await db
          .insert(ocpiLocationPublish)
          .values(insertValues)
          .returning({ id: ocpiLocationPublish.id });

        if (inserted == null) {
          await reply
            .status(500)
            .send({ error: 'Failed to create publish setting', code: 'INTERNAL_ERROR' });
          return;
        }
        publishId = inserted.id;
      }

      // Update partner visibility if not publish_to_all
      if (body.partnerIds != null) {
        await db
          .delete(ocpiLocationPublishPartners)
          .where(eq(ocpiLocationPublishPartners.locationPublishId, publishId));

        if (body.partnerIds.length > 0) {
          await db.insert(ocpiLocationPublishPartners).values(
            body.partnerIds.map((partnerId) => ({
              locationPublishId: publishId,
              partnerId,
            })),
          );
        }
      }

      // Notify push service
      await getPubSub().publish('ocpi_push', JSON.stringify({ type: 'location', siteId }));

      return { success: true };
    },
  );
}
