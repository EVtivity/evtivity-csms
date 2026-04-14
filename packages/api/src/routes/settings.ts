// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, like, or } from 'drizzle-orm';
import { db, isReservationEnabled, isSupportEnabled } from '@evtivity/database';
import { settings } from '@evtivity/database';
import { encryptString } from '@evtivity/lib';
import { zodSchema } from '../lib/zod-schema.js';
import { errorResponse, successResponse, itemResponse } from '../lib/response-schemas.js';
import { clearS3ConfigCache } from '../services/s3.service.js';
import { DEFAULT_CONTENT } from './default-content.js';
import { authorize } from '../middleware/rbac.js';
import { config as apiConfig } from '../lib/config.js';

const settingParams = z.object({
  key: z.string().min(1).describe('Setting key'),
});

const updateSettingBody = z.object({
  value: z.unknown(),
});

const settingItem = z.object({ key: z.string(), value: z.unknown() }).passthrough();

const s3StatusResponse = z.object({ configured: z.boolean() }).passthrough();

export function settingsRoutes(app: FastifyInstance): void {
  // Public endpoint for portal branding (no auth required)
  app.get(
    '/portal/branding',
    {
      schema: {
        tags: ['Settings'],
        summary: 'Get portal branding settings',
        operationId: 'getPortalBranding',
        security: [],
        response: { 200: itemResponse(z.record(z.string())) },
      },
    },
    async () => {
      const rows = await db
        .select()
        .from(settings)
        .where(or(like(settings.key, 'company.%'), like(settings.key, 'marketing.%')));
      const result: Record<string, string> = {};
      for (const row of rows) {
        const shortKey = row.key.replace(/^(company|marketing)\./, '');
        result[shortKey] = typeof row.value === 'string' ? row.value : '';
      }
      return result;
    },
  );

  app.get(
    '/portal/features',
    {
      schema: {
        tags: ['Settings'],
        summary: 'Get public feature flags',
        operationId: 'getPortalFeatures',
        security: [],
        response: {
          200: itemResponse(
            z
              .object({ reservationEnabled: z.boolean(), supportEnabled: z.boolean() })
              .passthrough(),
          ),
        },
      },
    },
    async () => {
      const reservationEnabled = await isReservationEnabled();
      const supportEnabled = await isSupportEnabled();
      return { reservationEnabled, supportEnabled };
    },
  );

  const contentParams = z.object({
    type: z.enum(['privacy-policy', 'terms-of-service']).describe('Content type'),
  });
  const contentQuery = z.object({
    lang: z.enum(['en', 'es', 'zh']).default('en').describe('Language code'),
  });
  const contentItem = z.object({ html: z.string() }).passthrough();

  app.get(
    '/portal/content/:type',
    {
      schema: {
        tags: ['Settings'],
        summary: 'Get public legal content',
        operationId: 'getPortalContent',
        security: [],
        params: zodSchema(contentParams),
        querystring: zodSchema(contentQuery),
        response: { 200: itemResponse(contentItem) },
      },
    },
    async (request) => {
      const { type } = request.params as z.infer<typeof contentParams>;
      const { lang } = request.query as z.infer<typeof contentQuery>;
      const settingKey =
        type === 'privacy-policy'
          ? `content.privacyPolicy.${lang}`
          : `content.termsOfService.${lang}`;
      const row = await db.select().from(settings).where(eq(settings.key, settingKey)).limit(1);
      const html = (row[0]?.value as string | undefined) ?? DEFAULT_CONTENT[lang][type];
      return { html };
    },
  );

  app.get(
    '/settings',
    {
      onRequest: [authorize('settings.system:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Get all settings',
        operationId: 'listSettings',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(z.record(z.unknown())) },
      },
    },
    async () => {
      const rows = await db.select().from(settings);
      const result: Record<string, unknown> = {};
      for (const row of rows) {
        result[row.key] = row.value;
      }
      return result;
    },
  );

  app.get(
    '/settings/:key',
    {
      onRequest: [authorize('settings.system:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Get a setting by key',
        operationId: 'getSetting',
        security: [{ bearerAuth: [] }],
        params: zodSchema(settingParams),
        response: { 200: itemResponse(settingItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { key } = request.params as z.infer<typeof settingParams>;
      const [row] = await db.select().from(settings).where(eq(settings.key, key));
      if (row == null) {
        await reply.status(404).send({ error: 'Setting not found', code: 'SETTING_NOT_FOUND' });
        return;
      }
      return { key: row.key, value: row.value };
    },
  );

  app.patch(
    '/settings/:key',
    {
      onRequest: [authorize('settings.system:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Update a setting by key',
        operationId: 'updateSetting',
        security: [{ bearerAuth: [] }],
        params: zodSchema(settingParams),
        body: zodSchema(updateSettingBody),
        response: { 200: itemResponse(settingItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { key } = request.params as z.infer<typeof settingParams>;
      const { value } = request.body as z.infer<typeof updateSettingBody>;
      const [row] = await db
        .update(settings)
        .set({ value, updatedAt: new Date() })
        .where(eq(settings.key, key))
        .returning();
      if (row == null) {
        await reply.status(404).send({ error: 'Setting not found', code: 'SETTING_NOT_FOUND' });
        return;
      }
      return { key: row.key, value: row.value };
    },
  );

  app.put(
    '/settings/:key',
    {
      onRequest: [authorize('settings.system:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Create or update a setting by key',
        operationId: 'upsertSetting',
        security: [{ bearerAuth: [] }],
        params: zodSchema(settingParams),
        body: zodSchema(updateSettingBody),
        response: { 200: itemResponse(settingItem) },
      },
    },
    async (request) => {
      const { key } = request.params as z.infer<typeof settingParams>;
      const { value } = request.body as z.infer<typeof updateSettingBody>;
      const rows = await db
        .insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedAt: new Date() },
        })
        .returning();
      const row = rows[0];
      if (row == null) {
        throw new Error('Insert with onConflictDoUpdate returned no rows');
      }
      return { key: row.key, value: row.value };
    },
  );

  app.delete(
    '/settings/:key',
    {
      onRequest: [authorize('settings.system:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Delete a setting by key',
        operationId: 'deleteSetting',
        security: [{ bearerAuth: [] }],
        params: zodSchema(settingParams),
        response: { 200: itemResponse(settingItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { key } = request.params as z.infer<typeof settingParams>;
      const [row] = await db.delete(settings).where(eq(settings.key, key)).returning();
      if (row == null) {
        await reply.status(404).send({ error: 'Setting not found', code: 'SETTING_NOT_FOUND' });
        return;
      }
      return { key: row.key, value: row.value };
    },
  );

  // S3 storage status (is it configured?)
  app.get(
    '/settings/s3/status',
    {
      onRequest: [authorize('settings.system:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Get S3 storage configuration status',
        operationId: 'getS3Status',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(s3StatusResponse) },
      },
    },
    async () => {
      const rows = await db.select().from(settings);
      const map = new Map<string, unknown>();
      for (const row of rows) {
        if (row.key.startsWith('s3.')) {
          map.set(row.key, row.value);
        }
      }
      const bucket = map.get('s3.bucket') as string | undefined;
      const region = map.get('s3.region') as string | undefined;
      const accessKeyIdEnc = map.get('s3.accessKeyIdEnc') as string | undefined;
      const secretAccessKeyEnc = map.get('s3.secretAccessKeyEnc') as string | undefined;
      const configured =
        bucket != null &&
        bucket !== '' &&
        region != null &&
        region !== '' &&
        accessKeyIdEnc != null &&
        accessKeyIdEnc !== '' &&
        secretAccessKeyEnc != null &&
        secretAccessKeyEnc !== '';
      return { configured };
    },
  );

  const s3SettingsBody = z.object({
    bucket: z.string().min(1),
    region: z.string().min(1),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
  });

  // Save S3 storage settings (encrypts credentials)
  app.put(
    '/settings/s3',
    {
      onRequest: [authorize('settings.system:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Save S3 storage settings',
        operationId: 'updateS3Settings',
        security: [{ bearerAuth: [] }],
        body: zodSchema(s3SettingsBody),
        response: { 200: successResponse, 500: errorResponse },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof s3SettingsBody>;
      const encryptionKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
      if (encryptionKey === '') {
        await reply.status(500).send({
          error: 'SETTINGS_ENCRYPTION_KEY not configured on server',
          code: 'ENCRYPTION_KEY_MISSING',
        });
        return;
      }

      const upsert = (key: string, value: unknown) =>
        db
          .insert(settings)
          .values({ key, value })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value, updatedAt: new Date() },
          });

      await Promise.all([
        upsert('s3.bucket', body.bucket),
        upsert('s3.region', body.region),
        upsert('s3.accessKeyIdEnc', encryptString(body.accessKeyId, encryptionKey)),
        upsert('s3.secretAccessKeyEnc', encryptString(body.secretAccessKey, encryptionKey)),
      ]);

      clearS3ConfigCache();
      return { success: true };
    },
  );

  // Test S3 connection by listing objects (max 1)
  app.post(
    '/settings/s3/test',
    {
      onRequest: [authorize('settings.system:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Test S3 connection',
        operationId: 'testS3Connection',
        security: [{ bearerAuth: [] }],
        response: { 200: successResponse, 400: errorResponse },
      },
    },
    async (_request, reply) => {
      const { getS3Config: getConfig } = await import('../services/s3.service.js');
      const s3 = await getConfig();
      if (s3 == null) {
        await reply.status(400).send({ error: 'S3 not configured', code: 'S3_NOT_CONFIGURED' });
        return;
      }

      try {
        const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
        await s3.client.send(new ListObjectsV2Command({ Bucket: s3.bucket, MaxKeys: 1 }));
        return { success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        await reply.status(400).send({ error: message, code: 'S3_CONNECTION_FAILED' });
        return;
      }
    },
  );
}
