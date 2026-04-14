// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, asc } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { stationImages } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import {
  errorResponse,
  successResponse,
  itemResponse,
  arrayResponse,
} from '../lib/response-schemas.js';
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

const uploadUrlBody = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100).describe('MIME type of the file'),
  fileSize: z
    .number()
    .int()
    .min(1)
    .max(10 * 1024 * 1024)
    .describe('File size in bytes, max 10 MB'),
});

const uploadUrlResponse = z
  .object({ uploadUrl: z.string(), s3Key: z.string(), s3Bucket: z.string() })
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

const imageItem = z.object({}).passthrough();

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
        operationId: 'getStationImageUploadUrl',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        body: zodSchema(uploadUrlBody),
        response: { 200: itemResponse(uploadUrlResponse), 400: errorResponse, 404: errorResponse },
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
        await reply.status(400).send({ error: 'S3 not configured', code: 'S3_NOT_CONFIGURED' });
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
        operationId: 'confirmStationImageUpload',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        body: zodSchema(confirmUploadBody),
        response: { 201: itemResponse(imageItem), 400: errorResponse, 404: errorResponse },
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

      // Get next sort order
      const [maxSort] = await db
        .select({ maxOrder: stationImages.sortOrder })
        .from(stationImages)
        .where(eq(stationImages.stationId, id))
        .orderBy(asc(stationImages.sortOrder))
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
        response: { 200: itemResponse(imageItem), 404: errorResponse },
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

      const [updated] = await db
        .update(stationImages)
        .set(updates)
        .where(and(eq(stationImages.id, imageId), eq(stationImages.stationId, id)))
        .returning();

      if (updated == null) {
        await reply.status(404).send({ error: 'Image not found', code: 'IMAGE_NOT_FOUND' });
        return;
      }

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
        response: { 200: successResponse, 404: errorResponse },
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
          200: itemResponse(z.object({ downloadUrl: z.string() }).passthrough()),
          400: errorResponse,
          404: errorResponse,
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
        await reply.status(400).send({ error: 'S3 not configured', code: 'S3_NOT_CONFIGURED' });
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
        response: { 200: successResponse, 404: errorResponse },
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
        operationId: 'setMainStationImage',
        security: [{ bearerAuth: [] }],
        params: zodSchema(imageIdParams),
        response: { 200: successResponse, 404: errorResponse },
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

      return { success: true as const };
    },
  );
}
