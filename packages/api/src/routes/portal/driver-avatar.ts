// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, drivers } from '@evtivity/database';
import { zodSchema } from '../../lib/zod-schema.js';
import { itemResponse, errorWith } from '../../lib/response-schemas.js';
import { ERROR_CODES } from '../../lib/error-codes.generated.js';
import { getAuditActor } from '../../lib/audit-actor.js';
import {
  avatarConfirmBody as confirmBody,
  avatarReply,
  avatarUploadUrlBody as uploadUrlBody,
  avatarUploadUrlResponse as uploadUrlResponse,
  generatedAvatarBody,
} from '../../lib/avatar-item.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';
import { getS3Config } from '../../services/s3.service.js';
import { AVATAR_MAX_BYTES, requestAvatarUpload } from '../../services/account-avatar-upload.js';
import { avatarView } from '../../services/account-avatar.js';
import type { AvatarView } from '../../services/account-avatar.js';
import {
  confirmUploadedAvatar,
  driverAvatarColumns,
  removeAvatar,
  setGeneratedAvatar,
} from '../../services/driver-avatar.service.js';

/** Rate limit per signed-in driver (the address before the driver is known). */
function perDriverRateLimit(max: number) {
  return {
    max,
    timeWindow: '1 minute',
    keyGenerator: (request: FastifyRequest) => {
      const driverId = (request.user as unknown as Record<string, unknown> | undefined)?.[
        'driverId'
      ];
      return typeof driverId === 'string' ? `driver-avatar:${driverId}` : request.ip;
    },
  };
}

/** 10 uploads a minute per driver: each one reads, decodes and re-encodes an image. */
const uploadRateLimit = {
  rateLimit: perDriverRateLimit(10),
  // Operator driver and fleet lists show the avatar.
  invalidatesCacheTags: ['drivers', 'fleets'],
};

/** 20 avatar sets or removals a minute per driver: each one writes the row and an audit entry. */
const writeRateLimit = {
  rateLimit: perDriverRateLimit(20),
  invalidatesCacheTags: ['drivers', 'fleets'],
};

const STORAGE_NOT_CONFIGURED = {
  error: 'File storage is not configured',
  code: 'STORAGE_NOT_CONFIGURED',
} as const;

async function currentAvatar(driverId: string): Promise<AvatarView | null> {
  const [row] = await db.select(driverAvatarColumns).from(drivers).where(eq(drivers.id, driverId));
  if (row == null) return null;
  return avatarView(row, row.avatarKind === 'image' ? await getS3Config() : null);
}

export function portalDriverAvatarRoutes(app: FastifyInstance): void {
  app.get(
    '/portal/driver/avatar',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Get the driver avatar',
        operationId: 'portalGetAvatar',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(avatarReply) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      return { avatar: await currentAvatar(driverId) };
    },
  );

  app.put(
    '/portal/driver/avatar',
    {
      onRequest: [app.authenticateDriver],
      config: writeRateLimit,
      schema: {
        tags: ['Portal Driver'],
        summary: 'Set a generated avatar',
        description:
          'Stores a DiceBear Avataaars avatar built from the allow-listed options. Replaces an uploaded image (its file is deleted). The same avatar again changes nothing. 20 a minute per driver.',
        operationId: 'portalSetAvatar',
        security: [{ bearerAuth: [] }],
        body: zodSchema(generatedAvatarBody),
        response: {
          200: itemResponse(avatarReply),
          400: errorWith('An option is not on the allow-list', [ERROR_CODES.VALIDATION_ERROR]),
        },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      const result = await setGeneratedAvatar(driverId, request.body, {
        actor: getAuditActor(request),
        log: request.log,
      });
      if (!result.changed) request.responseCacheUnchanged = true;
      return { avatar: await avatarView(result.avatar, null) };
    },
  );

  app.post(
    '/portal/driver/avatar/upload-url',
    {
      onRequest: [app.authenticateDriver],
      config: uploadRateLimit,
      schema: {
        tags: ['Portal Driver'],
        summary: 'Get a presigned upload for an avatar image',
        description:
          'Generates a 5-minute presigned POST (URL and form fields) into quarantine: S3 enforces the key, the type and a size of 1 to 1,048,575 bytes (smaller than 1 MB). JPEG, PNG or WebP only. Call POST /v1/portal/driver/avatar/image after the upload succeeds. 400 STORAGE_NOT_CONFIGURED when file storage is off (GET /v1/portal/features avatarUploadEnabled).',
        operationId: 'portalCreateAvatarUploadUrl',
        security: [{ bearerAuth: [] }],
        body: zodSchema(uploadUrlBody),
        response: {
          200: itemResponse(uploadUrlResponse),
          400: errorWith('Storage not configured, wrong type or too large', [
            ERROR_CODES.STORAGE_NOT_CONFIGURED,
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.AI_ATTACHMENT_TOO_LARGE,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof uploadUrlBody>;
      if (body.fileSize > AVATAR_MAX_BYTES) {
        await reply.status(400).send({
          error: 'The image must be smaller than 1 MB',
          code: 'AI_ATTACHMENT_TOO_LARGE',
        });
        return;
      }
      const s3 = await getS3Config();
      if (s3 == null) {
        await reply.status(400).send(STORAGE_NOT_CONFIGURED);
        return;
      }
      return requestAvatarUpload(s3, { kind: 'driver', driverId }, body.contentType);
    },
  );

  app.post(
    '/portal/driver/avatar/image',
    {
      onRequest: [app.authenticateDriver],
      config: uploadRateLimit,
      schema: {
        tags: ['Portal Driver'],
        summary: 'Confirm an uploaded avatar image',
        description:
          'Reads the quarantined upload, checks its bytes against its type and the 1 MB limit, crops it to a centered square of at most 512 x 512 px and re-encodes it (metadata dropped, JPEG or PNG). Replaces a generated avatar or an earlier image (its file is deleted). A retry of a confirmed key returns the current avatar.',
        operationId: 'portalConfirmAvatarImage',
        security: [{ bearerAuth: [] }],
        body: zodSchema(confirmBody),
        response: {
          200: itemResponse(avatarReply),
          400: errorWith('Storage not configured, foreign key or refused image', [
            ERROR_CODES.STORAGE_NOT_CONFIGURED,
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.AI_ATTACHMENT_TOO_LARGE,
            ERROR_CODES.AI_ATTACHMENT_REJECTED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof confirmBody>;
      const s3 = await getS3Config();
      if (s3 == null) {
        await reply.status(400).send(STORAGE_NOT_CONFIGURED);
        return;
      }
      const row = await confirmUploadedAvatar(driverId, s3, body, {
        actor: getAuditActor(request),
        log: request.log,
      });
      return { avatar: await avatarView(row, s3) };
    },
  );

  app.delete(
    '/portal/driver/avatar',
    {
      onRequest: [app.authenticateDriver],
      config: writeRateLimit,
      schema: {
        tags: ['Portal Driver'],
        summary: 'Remove the driver avatar',
        description:
          'Clears the avatar (initials are shown) and deletes an uploaded image. 20 a minute per driver.',
        operationId: 'portalRemoveAvatar',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(avatarReply) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      const removed = await removeAvatar(driverId, {
        actor: getAuditActor(request),
        log: request.log,
      });
      if (!removed) request.responseCacheUnchanged = true;
      return { avatar: null };
    },
  );
}
