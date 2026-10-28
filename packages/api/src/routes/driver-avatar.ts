// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authorize } from '../middleware/rbac.js';
import { zodSchema } from '../lib/zod-schema.js';
import { itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { operatorUploader, perOperatorAndTarget } from '../lib/avatar-operator.js';
import {
  avatarConfirmBody,
  avatarReply,
  avatarUploadUrlBody,
  avatarUploadUrlResponse,
  generatedAvatarBody,
} from '../lib/avatar-item.js';
import { getObjectStorage } from '../services/storage.service.js';
import { AVATAR_MAX_BYTES, requestAvatarUpload } from '../services/account-avatar-upload.js';
import { avatarView } from '../services/account-avatar.js';
import {
  confirmUploadedAvatar,
  removeAvatar,
  setGeneratedAvatar,
  writableAvatarRow,
} from '../services/driver-avatar.service.js';

/**
 * Operator writes of a driver avatar (`drivers:write`). Drivers are
 * company-wide records, like every other `/drivers/:id` route, so an operator
 * with `drivers:write` may change any driver's avatar, a site-restricted one
 * included. API keys with `drivers:write` may call them, as every other
 * operator driver write. An avatar grants no access and receives no link or
 * code, so no fresh proof is asked. Every write goes through
 * `driver-avatar.service.ts` and is audited in the caller's name
 * (`driver.updated`). The driver keeps its own routes (`/portal/driver/avatar`).
 */

const driverParams = z.object({
  id: ID_PARAMS.driverId.describe('Driver ID'),
});

/** 20 sets or removals a minute per caller and driver: each writes the row and an audit entry. */
const writeConfig = {
  rateLimit: perOperatorAndTarget('driver', 20),
  // Fleet member rows show the avatar too.
  invalidatesCacheTags: ['fleets'],
};

/** 10 uploads a minute per caller and driver: each reads, decodes and re-encodes an image. */
const uploadConfig = {
  rateLimit: perOperatorAndTarget('driver', 10),
  invalidatesCacheTags: ['fleets'],
};

const STORAGE_NOT_CONFIGURED = {
  error: 'File storage is not configured',
  code: 'STORAGE_NOT_CONFIGURED',
} as const;

const notFound = errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]);
const erased = errorWith('The driver was erased', [ERROR_CODES.DRIVER_ERASED]);

function context(request: FastifyRequest, note: string) {
  return { actor: getAuditActor(request), log: request.log, note };
}

export function driverAvatarRoutes(app: FastifyInstance): void {
  app.put(
    '/drivers/:id/avatar',
    {
      onRequest: [authorize('drivers:write')],
      config: writeConfig,
      schema: {
        tags: ['Drivers'],
        summary: 'Set a generated driver avatar',
        description:
          'Stores a DiceBear Avataaars avatar built from the allow-listed options for the driver. Replaces an uploaded image (its file is deleted). The same avatar again changes nothing. Audited in the caller name. 20 a minute per caller and driver.',
        operationId: 'setDriverAvatar',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        body: zodSchema(generatedAvatarBody),
        response: {
          200: itemResponse(avatarReply),
          400: errorWith('An option is not on the allow-list', [ERROR_CODES.VALIDATION_ERROR]),
          404: notFound,
          409: erased,
        },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof driverParams>;
      const result = await setGeneratedAvatar(
        id,
        request.body,
        context(request, 'Avatar changed by an operator'),
      );
      if (!result.changed) request.responseCacheUnchanged = true;
      return { avatar: await avatarView(result.avatar, null) };
    },
  );

  app.post(
    '/drivers/:id/avatar/upload-url',
    {
      onRequest: [authorize('drivers:write')],
      config: uploadConfig,
      schema: {
        tags: ['Drivers'],
        summary: 'Get a presigned upload for a driver avatar image',
        description:
          'Generates a 5-minute presigned POST (URL and form fields) into quarantine under the driver: S3 enforces the key, the type and a size of 1 to 1,048,575 bytes (smaller than 1 MB). JPEG, PNG or WebP only. Only the caller that asked for it can confirm the key (POST /v1/drivers/:id/avatar/image). 10 a minute per caller and driver.',
        operationId: 'createDriverAvatarUploadUrl',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        body: zodSchema(avatarUploadUrlBody),
        response: {
          200: itemResponse(avatarUploadUrlResponse),
          400: errorWith('Storage not configured, wrong type or too large', [
            ERROR_CODES.STORAGE_NOT_CONFIGURED,
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.AI_ATTACHMENT_TOO_LARGE,
          ]),
          404: notFound,
          409: erased,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof driverParams>;
      const body = request.body as z.infer<typeof avatarUploadUrlBody>;
      await writableAvatarRow(id);
      if (body.fileSize > AVATAR_MAX_BYTES) {
        await reply.status(400).send({
          error: 'The image must be smaller than 1 MB',
          code: 'AI_ATTACHMENT_TOO_LARGE',
        });
        return;
      }
      const storage = await getObjectStorage();
      if (storage == null) {
        await reply.status(400).send(STORAGE_NOT_CONFIGURED);
        return;
      }
      return requestAvatarUpload(
        storage,
        { kind: 'driver', driverId: id },
        body.contentType,
        operatorUploader(request),
      );
    },
  );

  app.post(
    '/drivers/:id/avatar/image',
    {
      onRequest: [authorize('drivers:write')],
      config: uploadConfig,
      schema: {
        tags: ['Drivers'],
        summary: 'Confirm an uploaded driver avatar image',
        description:
          'Reads the quarantined upload the caller asked for, checks its bytes against its type and the 1 MB limit, crops it to a centered square of at most 512 x 512 px and re-encodes it (metadata dropped, JPEG or PNG). Replaces a generated avatar or an earlier image (its file is deleted). A key issued for another driver or to another caller answers 400 VALIDATION_ERROR. A retry of a confirmed key returns the current avatar.',
        operationId: 'confirmDriverAvatarImage',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        body: zodSchema(avatarConfirmBody),
        response: {
          200: itemResponse(avatarReply),
          400: errorWith('Storage not configured, foreign key or refused image', [
            ERROR_CODES.STORAGE_NOT_CONFIGURED,
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.AI_ATTACHMENT_TOO_LARGE,
            ERROR_CODES.AI_ATTACHMENT_REJECTED,
          ]),
          404: notFound,
          409: erased,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof driverParams>;
      const body = request.body as z.infer<typeof avatarConfirmBody>;
      await writableAvatarRow(id);
      const storage = await getObjectStorage();
      if (storage == null) {
        await reply.status(400).send(STORAGE_NOT_CONFIGURED);
        return;
      }
      const row = await confirmUploadedAvatar(id, storage, body, {
        ...context(request, 'Avatar changed by an operator'),
        uploader: operatorUploader(request),
      });
      return { avatar: await avatarView(row, storage) };
    },
  );

  app.delete(
    '/drivers/:id/avatar',
    {
      onRequest: [authorize('drivers:write')],
      config: writeConfig,
      schema: {
        tags: ['Drivers'],
        summary: 'Remove a driver avatar',
        description:
          'Removes the avatar (a generated avatar or an uploaded photo, whose file is deleted); the driver then shows initials. The driver can set a new one. Removing no avatar changes nothing. Audited in the caller name. 20 a minute per caller and driver.',
        operationId: 'removeDriverAvatar',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        response: { 200: itemResponse(avatarReply), 404: notFound, 409: erased },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof driverParams>;
      const removed = await removeAvatar(id, context(request, 'Avatar removed by an operator'));
      if (!removed) request.responseCacheUnchanged = true;
      return { avatar: null };
    },
  );
}
