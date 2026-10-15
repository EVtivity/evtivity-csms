// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, ne } from 'drizzle-orm';
import {
  db,
  sites,
  ocpiPartners,
  ocpiLocationPublish,
  ocpiLocationPublishPartners,
  ocpiLocationAudience,
  pgConstraintName,
  pgErrorCode,
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
  ocpiPartnerAuditLog,
  siteAuditLog,
  writeAudit,
} from '@evtivity/database';
import type { OcpiLocationAudience } from '@evtivity/database';

type PublishRow = typeof ocpiLocationPublish.$inferSelect;
import { ID_PREFIXES } from '@evtivity/lib';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { lostLocationAudience, publishOcpiLocationPush } from '../lib/ocpi-location-push.js';
import { authorize } from '../middleware/rbac.js';
import { getUserSiteIds, userCanAccessSite } from '../lib/site-access.js';
import type { JwtPayload } from '../plugins/auth.js';
import { getAuditActor } from '../lib/audit-actor.js';
import {
  successResponse,
  itemResponse,
  arrayResponse,
  errorWith,
} from '../lib/response-schemas.js';

import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { OCPI_OBJECT_ID_PATTERN, OCPI_OBJECT_ID_MESSAGE } from '../lib/ocpi-object-id.js';

type PublishState = {
  isPublished: boolean;
  publishToAll: boolean | null;
  ocpiLocationId: string | null;
};

/**
 * Audit of a publish change: a site `location_published_changed` row with the
 * changed publish fields and the partners that see the location (OCPI
 * audience) before and after, and an `ocpi_partner` row for each partner that
 * gained or lost the location. Nothing changed, no row. Fail-open (writeAudit).
 */
async function writeLocationPublishAudit(
  request: FastifyRequest,
  siteId: string,
  change: {
    before: PublishState;
    after: PublishState;
    audienceBefore: OcpiLocationAudience | null;
    audienceAfter: OcpiLocationAudience | null;
  },
): Promise<void> {
  const seenBefore = new Set(change.audienceBefore?.partnerIds ?? []);
  const seenAfter = new Set(change.audienceAfter?.partnerIds ?? []);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of ['isPublished', 'publishToAll', 'ocpiLocationId'] as const) {
    if (change.before[key] !== change.after[key]) {
      before[key] = change.before[key];
      after[key] = change.after[key];
    }
  }
  const gained = [...seenAfter].filter((id) => !seenBefore.has(id)).sort();
  const lost = [...seenBefore].filter((id) => !seenAfter.has(id)).sort();
  if (gained.length > 0 || lost.length > 0) {
    before['partnerIds'] = [...seenBefore].sort();
    after['partnerIds'] = [...seenAfter].sort();
  }
  if (Object.keys(after).length === 0) return;

  const actor = getAuditActor(request);
  await writeAudit(
    { table: siteAuditLog, idColumn: 'site_id' },
    {
      entityId: siteId,
      entityIdSnapshot: siteId,
      action: 'location_published_changed',
      ...actor,
      before,
      after,
    },
    db,
    request.log,
  );
  for (const [partnerId, published] of [
    ...gained.map((id) => [id, true] as const),
    ...lost.map((id) => [id, false] as const),
  ]) {
    await writeAudit(
      { table: ocpiPartnerAuditLog, idColumn: 'ocpi_partner_id' },
      {
        entityId: partnerId,
        entityIdSnapshot: partnerId,
        action: 'location_published_changed',
        ...actor,
        before: { siteId, published: !published },
        after: { siteId, published },
      },
      db,
      request.log,
    );
  }
}
const locationPublishListItem = z
  .object({
    id: z.string().describe('Site identifier'),
    name: z.string().max(255).describe('Site name'),
    address: z.string().max(500).nullable().describe('Street address'),
    city: z.string().max(100).nullable().describe('City'),
    country: z.string().max(100).nullable().describe('Country'),
    isPublished: z.boolean().describe('Whether the site is published as an OCPI location'),
    publishToAll: z.boolean().describe('When true, the site is visible to every partner'),
    ocpiLocationId: z
      .string()
      .max(36)
      .nullable()
      .describe('Custom OCPI location identifier exposed to partners'),
  })
  .passthrough();

const locationPublishDetail = z
  .object({
    siteId: z.string().describe('Site identifier'),
    siteName: z.string().max(255).describe('Site name'),
    isPublished: z.boolean().describe('Whether the site is published as an OCPI location'),
    publishToAll: z.boolean().describe('When true, the site is visible to every partner'),
    ocpiLocationId: z
      .string()
      .max(36)
      .nullable()
      .describe('Custom OCPI location identifier exposed to partners'),
    partnerIds: z
      .array(z.string())
      .max(500)
      .optional()
      .describe(
        'Partner IDs the site is visible to when publishToAll is false. Omitted for users without access to every site (roaming partners are company-wide)',
      ),
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
    .describe(
      'If true, publish to all partners. If false, use partnerIds list. Ignored for users without access to every site: the stored value is kept',
    ),
  ocpiLocationId: z
    .string()
    .min(1)
    .max(36)
    .refine((v) => OCPI_OBJECT_ID_PATTERN.test(v), { message: OCPI_OBJECT_ID_MESSAGE })
    .optional()
    .describe(
      'Custom OCPI location identifier: 1 to 36 letters, digits, hyphens, periods, underscores or tildes. Must be unique and must not have the form of a site id (sit_ prefix) other than this site. Omit it to keep the stored one (the site id is the default)',
    ),
  partnerIds: z
    .array(ID_PARAMS.ocpiPartnerId)
    .max(500)
    .optional()
    .describe(
      'Partner IDs to publish to when publishToAll is false. Every id must name an existing partner. Ignored for users without access to every site: the stored list is kept',
    ),
});

const LOCATION_ID_TAKEN = 'OCPI location id is already in use';

async function sendValidationError(
  reply: FastifyReply,
  error: string,
  details: Record<string, string>,
): Promise<void> {
  await reply.status(400).send({ error, code: 'VALIDATION_ERROR', details });
}

/**
 * True when the OCPI location id is refused: another row already uses it, or
 * it has the shape of a site id other than this site's own (a site without a
 * custom id is published under its site id). Partners resolve a location_id
 * by either form, so either collision would let the lookup pick the wrong
 * site. Every site-id-shaped id is refused, whether that site exists or not,
 * so the answer never tells the caller which site ids exist.
 */
async function ocpiLocationIdTaken(ocpiLocationId: string, siteId: string): Promise<boolean> {
  if (ocpiLocationId !== siteId && ocpiLocationId.startsWith(`${ID_PREFIXES.site}_`)) return true;
  const [other] = await db
    .select({ id: ocpiLocationPublish.id })
    .from(ocpiLocationPublish)
    .where(
      and(
        eq(ocpiLocationPublish.ocpiLocationId, ocpiLocationId),
        ne(ocpiLocationPublish.siteId, siteId),
      ),
    )
    .limit(1);
  return other != null;
}

/** The given partner ids that do not exist (the FK would fail with a 500). */
async function unknownPartnerIds(partnerIds: string[]): Promise<string[]> {
  if (partnerIds.length === 0) return [];
  const rows = await db
    .select({ id: ocpiPartners.id })
    .from(ocpiPartners)
    .where(inArray(ocpiPartners.id, partnerIds));
  const known = new Set(rows.map((r) => r.id));
  return partnerIds.filter((id) => !known.has(id));
}

function isLocationIdUniqueViolation(err: unknown): boolean {
  return (
    pgErrorCode(err) === PG_UNIQUE_VIOLATION &&
    pgConstraintName(err) === 'uq_ocpi_location_publish_location_id'
  );
}

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
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) return [];
      const siteRows = await db
        .select({
          id: sites.id,
          name: sites.name,
          address: sites.address,
          city: sites.city,
          country: sites.country,
        })
        .from(sites)
        .where(siteIds != null ? inArray(sites.id, siteIds) : undefined)
        .orderBy(sites.name);

      const publishRows = await db
        .select()
        .from(ocpiLocationPublish)
        .where(siteIds != null ? inArray(ocpiLocationPublish.siteId, siteIds) : undefined);

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
        response: {
          200: itemResponse(locationPublishDetail),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { siteId } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await userCanAccessSite(userId, siteId))) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      // Roaming partners are company-wide (all-site users only), so a
      // site-restricted user does not get the partner ids.
      const allSiteUser = (await getUserSiteIds(userId)) == null;

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
      if (allSiteUser && publish != null && !publish.publishToAll) {
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
        ...(allSiteUser ? { partnerIds } : {}),
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
        response: {
          200: successResponse,
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
          500: errorWith('Internal server error', [ERROR_CODES.INTERNAL_ERROR]),
        },
      },
    },
    async (request, reply) => {
      const { siteId } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await userCanAccessSite(userId, siteId))) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
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

      // Validate everything before any write.
      if (body.ocpiLocationId != null && (await ocpiLocationIdTaken(body.ocpiLocationId, siteId))) {
        await sendValidationError(reply, LOCATION_ID_TAKEN, { ocpiLocationId: LOCATION_ID_TAKEN });
        return;
      }
      // Roaming partners are company-wide: a site-restricted user cannot see
      // them, so its partnerIds are ignored and the stored list is kept.
      // publishToAll is the same company-wide choice (every partner), so it is
      // ignored for a restricted user too and the stored value is kept.
      const allSites = (await getUserSiteIds(userId)) == null;
      const partnerIds = allSites ? body.partnerIds : undefined;
      const publishToAll = allSites ? body.publishToAll : undefined;
      if (partnerIds != null) {
        const unknown = await unknownPartnerIds(partnerIds);
        if (unknown.length > 0) {
          await sendValidationError(reply, 'Unknown partner id', {
            partnerIds: `Unknown partner id: ${unknown.join(', ')}`,
          });
          return;
        }
      }

      // One save per site at a time: the site row lock orders two saves, so the
      // second sees the first one's row (no duplicate insert, no 500) and its
      // audience. Partners that lose the location get its EVSEs as REMOVED
      // (OCPI 8.1, there is no DELETE).
      let saved: { audienceBefore: OcpiLocationAudience | null; existing: PublishRow | undefined };
      try {
        saved = await db.transaction(async (tx) => {
          await tx.select({ id: sites.id }).from(sites).where(eq(sites.id, siteId)).for('update');
          const audienceBefore = await ocpiLocationAudience(siteId);
          const [existing] = await tx
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
            if (publishToAll != null) updateData['publishToAll'] = publishToAll;
            if (body.ocpiLocationId != null) updateData['ocpiLocationId'] = body.ocpiLocationId;
            await tx
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
            if (publishToAll != null) insertValues.publishToAll = publishToAll;
            if (body.ocpiLocationId != null) insertValues.ocpiLocationId = body.ocpiLocationId;
            const [inserted] = await tx
              .insert(ocpiLocationPublish)
              .values(insertValues)
              .returning({ id: ocpiLocationPublish.id });
            if (inserted == null) throw new Error('OCPI location publish insert returned no row');
            publishId = inserted.id;
          }

          // Update partner visibility if not publish_to_all
          if (partnerIds != null) {
            await tx
              .delete(ocpiLocationPublishPartners)
              .where(eq(ocpiLocationPublishPartners.locationPublishId, publishId));
            if (partnerIds.length > 0) {
              await tx.insert(ocpiLocationPublishPartners).values(
                partnerIds.map((partnerId) => ({
                  locationPublishId: publishId,
                  partnerId,
                })),
              );
            }
          }
          return { audienceBefore, existing };
        });
      } catch (err) {
        // A concurrent write took the location id after the check above.
        if (isLocationIdUniqueViolation(err)) {
          await sendValidationError(reply, LOCATION_ID_TAKEN, {
            ocpiLocationId: LOCATION_ID_TAKEN,
          });
          return;
        }
        // A partner deleted after the check above: nothing was saved.
        if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
          await sendValidationError(reply, 'Unknown partner id', {
            partnerIds: 'Unknown partner id',
          });
          return;
        }
        throw err;
      }
      const { audienceBefore, existing } = saved;

      // Notify push service
      const audienceAfter = await ocpiLocationAudience(siteId);
      await publishOcpiLocationPush(
        siteId,
        lostLocationAudience(audienceBefore, audienceAfter),
        request.log,
      );
      await writeLocationPublishAudit(request, siteId, {
        before: {
          isPublished: existing?.isPublished ?? false,
          publishToAll: existing?.publishToAll ?? null,
          ocpiLocationId: existing?.ocpiLocationId ?? null,
        },
        after: {
          isPublished: body.isPublished,
          publishToAll: publishToAll ?? existing?.publishToAll ?? null,
          ocpiLocationId: body.ocpiLocationId ?? existing?.ocpiLocationId ?? null,
        },
        audienceBefore,
        audienceAfter,
      });

      return { success: true };
    },
  );
}
