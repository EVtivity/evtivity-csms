// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, asc, desc } from 'drizzle-orm';
import { db, writeAudit, stationImageAuditLog } from '@evtivity/database';
import { stationImages } from '@evtivity/database';
import { getAuditActor } from '../lib/audit-actor.js';
import { zodSchema } from '../lib/zod-schema.js';
import {
  successResponse,
  itemResponse,
  arrayResponse,
  errorWith,
} from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { checkStationSiteAccess } from '../lib/site-access.js';
import { authorize } from '../middleware/rbac.js';
import {
  getS3Config,
  generateUploadUrl,
  generateDownloadUrl,
  deleteObject,
  buildStationImageS3Key,
} from '../services/s3.service.js';

const stationIdParams = z.object({
  id: z.string().min(1).describe('Station ID'),
});

const imageIdParams = z.object({
  id: z.string().min(1).describe('Station ID'),
  imageId: z.coerce.number().int().min(1).describe('Image ID'),
});

// Restrict uploads to image MIME types so the bucket can't be used as
// a dumping ground for executables/documents. The frontend only sends
// images; this is a server-side guard against a hostile caller.
const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
] as const;

const uploadUrlBody = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z
    .enum(ALLOWED_IMAGE_MIME_TYPES)
    .describe(
      'MIME type of the file (image/jpeg, image/png, image/gif, image/webp, image/svg+xml)',
    ),
  fileSize: z
    .number()
    .int()
    .min(1)
    .max(10 * 1024 * 1024)
    .describe('File size in bytes, max 10 MB'),
});

const uploadUrlResponse = z
  .object({
    uploadUrl: z
      .string()
      .describe('Presigned S3 PUT URL the client uses to upload the file directly'),
    s3Key: z.string().describe('S3 object key under which the file will be stored'),
    s3Bucket: z.string().describe('S3 bucket the file is uploaded to'),
  })
  .passthrough();

const confirmUploadBody = z.object({
  fileName: z.string().min(1).max(255),
  fileSize: z.number().int().min(1),
  contentType: z.string().min(1).max(100),
  s3Key: z.string().min(1),
  s3Bucket: z.string().min(1),
  caption: z.string().max(1000).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  isDriverVisible: z.boolean().optional(),
  isMainImage: z.boolean().optional(),
});

const updateImageBody = z.object({
  caption: z.string().max(1000).nullish(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  isDriverVisible: z.boolean().optional(),
  isMainImage: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

const reorderBody = z.object({
  imageIds: z.array(z.number().int().min(1)).min(1),
});

const imageItem = z
  .object({
    id: z.number().int().min(1).describe('Image ID'),
    stationId: z.string().describe('Station ID'),
    fileName: z.string().max(255).describe('Original file name'),
    fileSize: z.number().int().min(0).describe('File size in bytes'),
    contentType: z.string().max(100).describe('MIME type of the file'),
    s3Key: z.string().max(1024).describe('S3 object key'),
    s3Bucket: z.string().max(255).describe('S3 bucket name'),
    caption: z.string().max(1000).nullable().describe('Optional caption text'),
    tags: z.array(z.string().max(50)).max(20).describe('Tags for filtering and grouping'),
    isDriverVisible: z.boolean().describe('Whether the image is shown to drivers in the portal'),
    isMainImage: z.boolean().describe('Whether this is the primary image for the station'),
    sortOrder: z.number().int().min(0).describe('Display order within the station image gallery'),
    uploadedBy: z.string().nullable().describe('User ID of the operator who uploaded the image'),
    createdAt: z.string().describe('Timestamp when the image was uploaded'),
    updatedAt: z.string().describe('Timestamp when the image was last updated'),
  })
  .passthrough();

export function stationImageRoutes(app: FastifyInstance): void {
  // List all images for a station
  app.get(
    '/stations/:id/images',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List all images for a station',
        operationId: 'listStationImages',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        response: { 200: arrayResponse(imageItem) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof stationIdParams>;
      const { userId } = request.user as { userId: string };
      if (!(await checkStationSiteAccess(id, userId))) {
        return [];
      }
      return db
        .select()
        .from(stationImages)
        .where(eq(stationImages.stationId, id))
        .orderBy(asc(stationImages.sortOrder), asc(stationImages.id));
    },
  );

  // Get presigned upload URL
  app.post(
    '/stations/:id/images/upload-url',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Get a presigned S3 upload URL for a station image',
        description:
          'Generates a 5-minute presigned PUT URL for uploading a station image to S3 (max 10MB). The S3 key is built under stations/{stationId}/. Call the confirm endpoint after the PUT succeeds to register the image in the database. Returns 400 if S3 is not configured.',
        operationId: 'getStationImageUploadUrl',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        body: zodSchema(uploadUrlBody),
        response: {
          200: itemResponse(uploadUrlResponse),
          400: errorWith('S3 not configured', [ERROR_CODES.STORAGE_NOT_CONFIGURED]),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationIdParams>;
      const body = request.body as z.infer<typeof uploadUrlBody>;

      const { userId } = request.user as { userId: string };
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const s3 = await getS3Config();
      if (s3 == null) {
        await reply
          .status(400)
          .send({ error: 'S3 not configured', code: 'STORAGE_NOT_CONFIGURED' });
        return;
      }

      const fileId = randomUUID();
      const key = buildStationImageS3Key(id, fileId, body.fileName);
      const url = await generateUploadUrl(s3, key, body.contentType);

      return { uploadUrl: url, s3Key: key, s3Bucket: s3.bucket };
    },
  );

  // Confirm upload
  app.post(
    '/stations/:id/images',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Confirm a station image upload after S3 PUT',
        description:
          'Inserts a station_images row with the S3 metadata supplied by the client after a successful PUT. Computes the next sortOrder. When isMainImage=true, clears the previous main image on this station so only one main image exists at a time.',
        operationId: 'confirmStationImageUpload',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        body: zodSchema(confirmUploadBody),
        response: {
          201: itemResponse(imageItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationIdParams>;
      const body = request.body as z.infer<typeof confirmUploadBody>;
      const userId = (request.user as { userId: string }).userId;

      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // If setting as main, clear existing main image
      if (body.isMainImage === true) {
        await db
          .update(stationImages)
          .set({ isMainImage: false })
          .where(and(eq(stationImages.stationId, id), eq(stationImages.isMainImage, true)));
      }

      // Get next sort order - asc() was returning the MINIMUM existing
      // sort order, so every new image landed on the same low value
      // instead of being appended to the end of the list.
      const [maxSort] = await db
        .select({ maxOrder: stationImages.sortOrder })
        .from(stationImages)
        .where(eq(stationImages.stationId, id))
        .orderBy(desc(stationImages.sortOrder))
        .limit(1);

      const [image] = await db
        .insert(stationImages)
        .values({
          stationId: id,
          fileName: body.fileName,
          fileSize: body.fileSize,
          contentType: body.contentType,
          s3Key: body.s3Key,
          s3Bucket: body.s3Bucket,
          caption: body.caption ?? null,
          tags: body.tags ?? [],
          isDriverVisible: body.isDriverVisible ?? false,
          isMainImage: body.isMainImage ?? false,
          sortOrder: (maxSort?.maxOrder ?? 0) + 1,
          uploadedBy: userId,
        })
        .returning();

      if (image != null) {
        const actor = getAuditActor(request);
        await writeAudit(
          { table: stationImageAuditLog, idColumn: 'station_image_id' },
          {
            entityId: String(image.id),
            entityIdSnapshot: String(image.id),
            action: 'uploaded',
            ...actor,
            after: image,
          },
          db,
          request.log,
        );
      }

      await reply.status(201).send(image);
    },
  );

  // Update image metadata
  app.patch(
    '/stations/:id/images/:imageId',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Update station image metadata',
        operationId: 'updateStationImage',
        security: [{ bearerAuth: [] }],
        params: zodSchema(imageIdParams),
        body: zodSchema(updateImageBody),
        response: {
          200: itemResponse(imageItem),
          404: errorWith('Resource not found', [
            ERROR_CODES.IMAGE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id, imageId } = request.params as z.infer<typeof imageIdParams>;
      const body = request.body as z.infer<typeof updateImageBody>;

      const { userId } = request.user as { userId: string };
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // If setting as main, clear existing main image
      if (body.isMainImage === true) {
        await db
          .update(stationImages)
          .set({ isMainImage: false })
          .where(and(eq(stationImages.stationId, id), eq(stationImages.isMainImage, true)));
      }

      const updates: Record<string, unknown> = {};
      if (body.caption !== undefined) updates['caption'] = body.caption ?? null;
      if (body.tags !== undefined) updates['tags'] = body.tags;
      if (body.isDriverVisible !== undefined) updates['isDriverVisible'] = body.isDriverVisible;
      if (body.isMainImage !== undefined) updates['isMainImage'] = body.isMainImage;
      if (body.sortOrder !== undefined) updates['sortOrder'] = body.sortOrder;

      if (Object.keys(updates).length === 0) {
        const [existing] = await db
          .select()
          .from(stationImages)
          .where(and(eq(stationImages.id, imageId), eq(stationImages.stationId, id)));
        if (existing == null) {
          await reply.status(404).send({ error: 'Image not found', code: 'IMAGE_NOT_FOUND' });
          return;
        }
        return existing;
      }

      const [before] = await db
        .select()
        .from(stationImages)
        .where(and(eq(stationImages.id, imageId), eq(stationImages.stationId, id)));
      const [updated] = await db
        .update(stationImages)
        .set(updates)
        .where(and(eq(stationImages.id, imageId), eq(stationImages.stationId, id)))
        .returning();

      if (updated == null) {
        await reply.status(404).send({ error: 'Image not found', code: 'IMAGE_NOT_FOUND' });
        return;
      }

      const actor = getAuditActor(request);
      await writeAudit(
        { table: stationImageAuditLog, idColumn: 'station_image_id' },
        {
          entityId: String(updated.id),
          entityIdSnapshot: String(updated.id),
          action: 'updated',
          ...actor,
          before: before ?? null,
          after: updated,
        },
        db,
        request.log,
      );

      return updated;
    },
  );

  // Delete image
  app.delete(
    '/stations/:id/images/:imageId',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Delete a station image',
        operationId: 'deleteStationImage',
        security: [{ bearerAuth: [] }],
        params: zodSchema(imageIdParams),
        response: {
          200: successResponse,
          404: errorWith('Resource not found', [
            ERROR_CODES.IMAGE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id, imageId } = request.params as z.infer<typeof imageIdParams>;

      const { userId } = request.user as { userId: string };
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const [image] = await db
        .select()
        .from(stationImages)
        .where(and(eq(stationImages.id, imageId), eq(stationImages.stationId, id)));

      if (image == null) {
        await reply.status(404).send({ error: 'Image not found', code: 'IMAGE_NOT_FOUND' });
        return;
      }

      // Delete from S3
      const s3 = await getS3Config();
      if (s3 != null) {
        await deleteObject(s3, image.s3Bucket, image.s3Key);
      }

      await db.delete(stationImages).where(eq(stationImages.id, imageId));

      const actor = getAuditActor(request);
      await writeAudit(
        { table: stationImageAuditLog, idColumn: 'station_image_id' },
        {
          entityId: null,
          entityIdSnapshot: String(image.id),
          action: 'deleted',
          ...actor,
          before: image,
        },
        db,
        request.log,
      );

      return { success: true as const };
    },
  );

  // Download URL
  app.get(
    '/stations/:id/images/:imageId/download-url',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get a presigned download URL for a station image',
        operationId: 'getStationImageDownloadUrl',
        security: [{ bearerAuth: [] }],
        params: zodSchema(imageIdParams),
        response: {
          200: itemResponse(
            z
              .object({
                downloadUrl: z.string().describe('Presigned S3 GET URL for downloading the image'),
              })
              .passthrough(),
          ),
          400: errorWith('S3 not configured', [ERROR_CODES.STORAGE_NOT_CONFIGURED]),
          404: errorWith('Resource not found', [
            ERROR_CODES.IMAGE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id, imageId } = request.params as z.infer<typeof imageIdParams>;

      const { userId } = request.user as { userId: string };
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const [image] = await db
        .select()
        .from(stationImages)
        .where(and(eq(stationImages.id, imageId), eq(stationImages.stationId, id)));

      if (image == null) {
        await reply.status(404).send({ error: 'Image not found', code: 'IMAGE_NOT_FOUND' });
        return;
      }

      const s3 = await getS3Config();
      if (s3 == null) {
        await reply
          .status(400)
          .send({ error: 'S3 not configured', code: 'STORAGE_NOT_CONFIGURED' });
        return;
      }

      const downloadUrl = await generateDownloadUrl(s3, image.s3Bucket, image.s3Key);
      return { downloadUrl };
    },
  );

  // Reorder images
  app.patch(
    '/stations/:id/images/reorder',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Reorder station images',
        operationId: 'reorderStationImages',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        body: zodSchema(reorderBody),
        response: {
          200: successResponse,
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationIdParams>;
      const { imageIds } = request.body as z.infer<typeof reorderBody>;

      const { userId } = request.user as { userId: string };
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      for (let i = 0; i < imageIds.length; i++) {
        await db
          .update(stationImages)
          .set({ sortOrder: i })
          .where(and(eq(stationImages.id, imageIds[i] as number), eq(stationImages.stationId, id)));
      }

      return { success: true as const };
    },
  );

  // Set main image
  app.post(
    '/stations/:id/images/:imageId/set-main',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Set an image as the main station image',
        description:
          'Marks the supplied image as the main station image and clears isMainImage on every other image for the same station. The main image is rendered in the station header and used as the default visual on listings.',
        operationId: 'setMainStationImage',
        security: [{ bearerAuth: [] }],
        params: zodSchema(imageIdParams),
        response: {
          200: successResponse,
          404: errorWith('Resource not found', [
            ERROR_CODES.IMAGE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id, imageId } = request.params as z.infer<typeof imageIdParams>;

      const { userId } = request.user as { userId: string };
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const [image] = await db
        .select()
        .from(stationImages)
        .where(and(eq(stationImages.id, imageId), eq(stationImages.stationId, id)));

      if (image == null) {
        await reply.status(404).send({ error: 'Image not found', code: 'IMAGE_NOT_FOUND' });
        return;
      }

      // Clear existing main
      await db
        .update(stationImages)
        .set({ isMainImage: false })
        .where(and(eq(stationImages.stationId, id), eq(stationImages.isMainImage, true)));

      // Set new main
      await db
        .update(stationImages)
        .set({ isMainImage: true })
        .where(eq(stationImages.id, imageId));

      const actor = getAuditActor(request);
      await writeAudit(
        { table: stationImageAuditLog, idColumn: 'station_image_id' },
        {
          entityId: String(image.id),
          entityIdSnapshot: String(image.id),
          action: 'set_main',
          ...actor,
        },
        db,
        request.log,
      );

      return { success: true as const };
    },
  );
}
