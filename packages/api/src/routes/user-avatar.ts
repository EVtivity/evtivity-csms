// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authorize, selfService } from '../middleware/rbac.js';
import { zodSchema } from '../lib/zod-schema.js';
import { itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { operatorUploader, perOperatorAndTarget } from '../lib/avatar-operator.js';
import { canManageUser, getUserManagementActor } from '../lib/user-management-scope.js';
import {
  avatarConfirmBody,
  avatarReply,
  avatarUploadUrlBody,
  avatarUploadUrlResponse,
  generatedAvatarBody,
} from '../lib/avatar-item.js';
import { getS3Config } from '../services/s3.service.js';
import { AVATAR_MAX_BYTES, requestAvatarUpload } from '../services/account-avatar-upload.js';
import { avatarView } from '../services/account-avatar.js';
import {
  confirmUserUploadedAvatar,
  removeUserAvatar,
  setUserGeneratedAvatar,
  userAvatarRow,
} from '../services/user-avatar.service.js';

/**
 * CSMS user (operator) avatars.
 *
 * - The own avatar (`/users/me/avatar`): any signed-in user, no permission,
 *   like a driver. Sessions only: an API key gets 403 SESSION_REQUIRED, as on
 *   PATCH /users/me and as the driver self routes, which only a driver
 *   session reaches.
 * - Another user's avatar (`/users/:id/avatar`): `users:write`, sessions and
 *   API keys with it, under the profile field rules of PATCH /users/:id: the
 *   site scope (`canManageUser`, else 404 USER_NOT_FOUND) and not the own
 *   account (403 SELF_EDIT_FORBIDDEN: the own avatar keeps its session-only
 *   routes). An avatar grants no access and receives no link or code, so
 *   neither the permission subset (`canAdministerUser`) nor a fresh proof
 *   applies.
 *
 * Every write goes through `user-avatar.service.ts` and is audited
 * (`user.updated`, in the caller's name).
 */

/** Rate limit per signed-in user. */
function perUser(max: number) {
  return {
    max,
    timeWindow: '1 minute',
    keyGenerator: (request: FastifyRequest) => {
      const userId = (request.user as unknown as Record<string, unknown> | undefined)?.['userId'];
      return typeof userId === 'string' ? `user-avatar:${userId}` : request.ip;
    },
  };
}

/** 20 sets or removals a minute per user: each writes the row and an audit entry. */
const writeConfig = { rateLimit: perUser(20) };

/** 10 uploads a minute per user: each reads, decodes and re-encodes an image. */
const uploadConfig = { rateLimit: perUser(10) };

const STORAGE_NOT_CONFIGURED = {
  error: 'File storage is not configured',
  code: 'STORAGE_NOT_CONFIGURED',
} as const;

const notFound = errorWith('User not found', [ERROR_CODES.USER_NOT_FOUND]);
const selfEdit = errorWith('Your own account: use /v1/users/me/avatar', [
  ERROR_CODES.SELF_EDIT_FORBIDDEN,
]);

const userParams = z.object({
  id: ID_PARAMS.userId.describe('User ID'),
});

/** 20 sets or removals a minute per caller and user. */
const operatorWriteConfig = { rateLimit: perOperatorAndTarget('user', 20) };

/** 10 uploads a minute per caller and user. */
const operatorUploadConfig = { rateLimit: perOperatorAndTarget('user', 10) };
const sessionRequired = errorWith('API keys cannot change the own avatar', [
  ERROR_CODES.SESSION_REQUIRED,
]);

function ownUserId(request: FastifyRequest): string {
  return (request.user as { userId: string }).userId;
}

function context(request: FastifyRequest, note: string) {
  return { actor: getAuditActor(request), log: request.log, note };
}

/**
 * Whether the caller may edit the avatar of user `id`: refuses the own
 * account (403 SELF_EDIT_FORBIDDEN) and a user outside the caller's site
 * scope (404 USER_NOT_FOUND, like a missing one). Sends the reply and returns
 * false when refused.
 */
async function otherUserAllowed(
  request: FastifyRequest,
  reply: FastifyReply,
  id: string,
): Promise<boolean> {
  if (ownUserId(request) === id) {
    await reply.status(403).send({
      error: 'Change your own avatar on your profile (/v1/users/me/avatar)',
      code: 'SELF_EDIT_FORBIDDEN',
    });
    return false;
  }
  if (!(await canManageUser(await getUserManagementActor(request), id))) {
    await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
    return false;
  }
  return true;
}

const SET_DESCRIPTION =
  'Stores a DiceBear Avataaars avatar built from the allow-listed options. Replaces an uploaded image (its file is deleted). The same avatar again changes nothing. 20 a minute per user.';
const UPLOAD_URL_DESCRIPTION =
  'Generates a 5-minute presigned POST (URL and form fields) into quarantine: S3 enforces the key, the type and a size of 1 to 1,048,575 bytes (smaller than 1 MB). JPEG, PNG or WebP only. Confirmed with POST /v1/users/me/avatar/image. 10 a minute per user.';
const CONFIRM_DESCRIPTION =
  'Reads the quarantined upload, checks its bytes against its type and the 1 MB limit, crops it to a centered square of at most 512 x 512 px and re-encodes it (metadata dropped, JPEG or PNG). Replaces a generated avatar or an earlier image (its file is deleted). A key issued for another user answers 400 VALIDATION_ERROR. A retry of a confirmed key returns the current avatar.';
const REMOVE_DESCRIPTION =
  'Removes the avatar (a generated avatar or an uploaded photo, whose file is deleted); initials are shown. Removing no avatar changes nothing. 20 a minute per user.';

export function userAvatarRoutes(app: FastifyInstance): void {
  app.put(
    '/users/me/avatar',
    {
      onRequest: [selfService()],
      config: writeConfig,
      schema: {
        tags: ['Users'],
        summary: 'Set the own generated avatar',
        description: SET_DESCRIPTION,
        operationId: 'setCurrentUserAvatar',
        security: [{ bearerAuth: [] }],
        body: zodSchema(generatedAvatarBody),
        response: {
          200: itemResponse(avatarReply),
          400: errorWith('An option is not on the allow-list', [ERROR_CODES.VALIDATION_ERROR]),
          403: sessionRequired,
          404: notFound,
        },
      },
    },
    async (request) => {
      const result = await setUserGeneratedAvatar(
        ownUserId(request),
        request.body,
        context(request, 'Avatar changed by the user'),
      );
      if (!result.changed) request.responseCacheUnchanged = true;
      return { avatar: await avatarView(result.avatar, null) };
    },
  );

  app.post(
    '/users/me/avatar/upload-url',
    {
      onRequest: [selfService()],
      config: uploadConfig,
      schema: {
        tags: ['Users'],
        summary: 'Get a presigned upload for the own avatar image',
        description: UPLOAD_URL_DESCRIPTION,
        operationId: 'createCurrentUserAvatarUploadUrl',
        security: [{ bearerAuth: [] }],
        body: zodSchema(avatarUploadUrlBody),
        response: {
          200: itemResponse(avatarUploadUrlResponse),
          400: errorWith('Storage not configured, wrong type or too large', [
            ERROR_CODES.STORAGE_NOT_CONFIGURED,
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.AI_ATTACHMENT_TOO_LARGE,
          ]),
          403: sessionRequired,
          404: notFound,
        },
      },
    },
    async (request, reply) => {
      const userId = ownUserId(request);
      const body = request.body as z.infer<typeof avatarUploadUrlBody>;
      if (body.fileSize > AVATAR_MAX_BYTES) {
        await reply.status(400).send({
          error: 'The image must be smaller than 1 MB',
          code: 'AI_ATTACHMENT_TOO_LARGE',
        });
        return;
      }
      await userAvatarRow(userId);
      const s3 = await getS3Config();
      if (s3 == null) {
        await reply.status(400).send(STORAGE_NOT_CONFIGURED);
        return;
      }
      return requestAvatarUpload(s3, { kind: 'user', userId }, body.contentType);
    },
  );

  app.post(
    '/users/me/avatar/image',
    {
      onRequest: [selfService()],
      config: uploadConfig,
      schema: {
        tags: ['Users'],
        summary: 'Confirm the own uploaded avatar image',
        description: CONFIRM_DESCRIPTION,
        operationId: 'confirmCurrentUserAvatarImage',
        security: [{ bearerAuth: [] }],
        body: zodSchema(avatarConfirmBody),
        response: {
          200: itemResponse(avatarReply),
          400: errorWith('Storage not configured, foreign key or refused image', [
            ERROR_CODES.STORAGE_NOT_CONFIGURED,
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.AI_ATTACHMENT_TOO_LARGE,
            ERROR_CODES.AI_ATTACHMENT_REJECTED,
          ]),
          403: sessionRequired,
          404: notFound,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof avatarConfirmBody>;
      const s3 = await getS3Config();
      if (s3 == null) {
        await reply.status(400).send(STORAGE_NOT_CONFIGURED);
        return;
      }
      const row = await confirmUserUploadedAvatar(
        ownUserId(request),
        s3,
        body,
        context(request, 'Avatar changed by the user'),
      );
      return { avatar: await avatarView(row, s3) };
    },
  );

  app.delete(
    '/users/me/avatar',
    {
      onRequest: [selfService()],
      config: writeConfig,
      schema: {
        tags: ['Users'],
        summary: 'Remove the own avatar',
        description: REMOVE_DESCRIPTION,
        operationId: 'removeCurrentUserAvatar',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(avatarReply), 403: sessionRequired, 404: notFound },
      },
    },
    async (request) => {
      const removed = await removeUserAvatar(
        ownUserId(request),
        context(request, 'Avatar removed by the user'),
      );
      if (!removed) request.responseCacheUnchanged = true;
      return { avatar: null };
    },
  );

  app.put(
    '/users/:id/avatar',
    {
      onRequest: [authorize('users:write')],
      config: operatorWriteConfig,
      schema: {
        tags: ['Users'],
        summary: 'Set the generated avatar of another user',
        description:
          'Stores a DiceBear Avataaars avatar built from the allow-listed options for another user within your site scope. Replaces an uploaded image (its file is deleted). The same avatar again changes nothing. Audited in the caller name. Your own account answers 403 SELF_EDIT_FORBIDDEN: use PUT /v1/users/me/avatar. 20 a minute per caller and user.',
        operationId: 'setUserAvatar',
        security: [{ bearerAuth: [] }],
        params: zodSchema(userParams),
        body: zodSchema(generatedAvatarBody),
        response: {
          200: itemResponse(avatarReply),
          400: errorWith('An option is not on the allow-list', [ERROR_CODES.VALIDATION_ERROR]),
          403: selfEdit,
          404: notFound,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof userParams>;
      if (!(await otherUserAllowed(request, reply, id))) return;
      const result = await setUserGeneratedAvatar(
        id,
        request.body,
        context(request, 'Avatar changed by an operator'),
      );
      if (!result.changed) request.responseCacheUnchanged = true;
      return { avatar: await avatarView(result.avatar, null) };
    },
  );

  app.post(
    '/users/:id/avatar/upload-url',
    {
      onRequest: [authorize('users:write')],
      config: operatorUploadConfig,
      schema: {
        tags: ['Users'],
        summary: 'Get a presigned upload for the avatar image of another user',
        description:
          'Generates a 5-minute presigned POST (URL and form fields) into quarantine under the user: S3 enforces the key, the type and a size of 1 to 1,048,575 bytes (smaller than 1 MB). JPEG, PNG or WebP only. Only the caller that asked for it can confirm the key (POST /v1/users/:id/avatar/image). Your own account answers 403 SELF_EDIT_FORBIDDEN. 10 a minute per caller and user.',
        operationId: 'createUserAvatarUploadUrl',
        security: [{ bearerAuth: [] }],
        params: zodSchema(userParams),
        body: zodSchema(avatarUploadUrlBody),
        response: {
          200: itemResponse(avatarUploadUrlResponse),
          400: errorWith('Storage not configured, wrong type or too large', [
            ERROR_CODES.STORAGE_NOT_CONFIGURED,
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.AI_ATTACHMENT_TOO_LARGE,
          ]),
          403: selfEdit,
          404: notFound,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof userParams>;
      const body = request.body as z.infer<typeof avatarUploadUrlBody>;
      if (!(await otherUserAllowed(request, reply, id))) return;
      await userAvatarRow(id);
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
      return requestAvatarUpload(
        s3,
        { kind: 'user', userId: id },
        body.contentType,
        operatorUploader(request),
      );
    },
  );

  app.post(
    '/users/:id/avatar/image',
    {
      onRequest: [authorize('users:write')],
      config: operatorUploadConfig,
      schema: {
        tags: ['Users'],
        summary: 'Confirm the uploaded avatar image of another user',
        description:
          'Reads the quarantined upload the caller asked for, checks its bytes against its type and the 1 MB limit, crops it to a centered square of at most 512 x 512 px and re-encodes it (metadata dropped, JPEG or PNG). Replaces a generated avatar or an earlier image (its file is deleted). A key issued for another user or to another caller answers 400 VALIDATION_ERROR. A retry of a confirmed key returns the current avatar. Your own account answers 403 SELF_EDIT_FORBIDDEN.',
        operationId: 'confirmUserAvatarImage',
        security: [{ bearerAuth: [] }],
        params: zodSchema(userParams),
        body: zodSchema(avatarConfirmBody),
        response: {
          200: itemResponse(avatarReply),
          400: errorWith('Storage not configured, foreign key or refused image', [
            ERROR_CODES.STORAGE_NOT_CONFIGURED,
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.AI_ATTACHMENT_TOO_LARGE,
            ERROR_CODES.AI_ATTACHMENT_REJECTED,
          ]),
          403: selfEdit,
          404: notFound,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof userParams>;
      const body = request.body as z.infer<typeof avatarConfirmBody>;
      if (!(await otherUserAllowed(request, reply, id))) return;
      await userAvatarRow(id);
      const s3 = await getS3Config();
      if (s3 == null) {
        await reply.status(400).send(STORAGE_NOT_CONFIGURED);
        return;
      }
      const row = await confirmUserUploadedAvatar(id, s3, body, {
        ...context(request, 'Avatar changed by an operator'),
        uploader: operatorUploader(request),
      });
      return { avatar: await avatarView(row, s3) };
    },
  );

  app.delete(
    '/users/:id/avatar',
    {
      onRequest: [authorize('users:write')],
      config: operatorWriteConfig,
      schema: {
        tags: ['Users'],
        summary: 'Remove the avatar of another user',
        description:
          'Removes the avatar of another user within your site scope (a generated avatar or an uploaded photo, whose file is deleted); initials are shown. Removing no avatar changes nothing. Audited in the caller name. Your own account answers 403 SELF_EDIT_FORBIDDEN: use DELETE /v1/users/me/avatar. 20 a minute per caller and user.',
        operationId: 'removeUserAvatar',
        security: [{ bearerAuth: [] }],
        params: zodSchema(userParams),
        response: { 200: itemResponse(avatarReply), 403: selfEdit, 404: notFound },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof userParams>;
      if (!(await otherUserAllowed(request, reply, id))) return;
      const removed = await removeUserAvatar(id, context(request, 'Avatar removed by an operator'));
      if (!removed) request.responseCacheUnchanged = true;
      return { avatar: null };
    },
  );
}
