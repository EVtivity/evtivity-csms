// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { recordEnergyAssetReading } from '@evtivity/database';
import { ENERGY_ASSET_FUTURE_SKEW_MS, ENERGY_ASSET_READING_POWER_RANGE } from '@evtivity/lib';
import { parseZodRequest, zodSchema } from '../lib/zod-schema.js';
import { errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { authorize } from '../middleware/rbac.js';
import { sendFieldError } from '../lib/load-tree-validation.js';
import {
  assetSiteAllowed,
  assetValidationError,
  readSiteAsset,
  sendAssetNotFound,
} from './energy-assets.js';

// The reading an external EMS, BMS or gateway pushes for a battery or solar
// array of the site (owner decisions D6, D7): `loadManagement:write`, an API
// key scoped to it or a session. Only an asset with `api` telemetry takes it;
// the load management cycle credits it, capped at the asset nameplate, while
// it is fresh (`@evtivity/lib/energy-supply`). features/load-management.md,
// "Battery and solar readings".

const assetIdParam = z.object({
  siteId: z.string().describe('Site ID'),
  assetId: z.string().describe('Battery or solar array ID'),
});

const readingBody = z.object({
  reportedAt: z.iso
    .datetime({ offset: true })
    .describe(
      'When the asset measured the values (ISO 8601). Refused when more than 30 seconds in the future or older than the reading TTL',
    ),
  powerKw: z
    .number()
    .min(ENERGY_ASSET_READING_POWER_RANGE.min)
    .max(ENERGY_ASSET_READING_POWER_RANGE.max)
    .describe('AC power in kW: positive for output or discharge, negative while a battery charges'),
  availableKw: z
    .number()
    .min(0)
    .max(ENERGY_ASSET_READING_POWER_RANGE.max)
    .nullable()
    .optional()
    .describe('Power in kW the asset controller says it can give now; null when unknown'),
  socPercent: z
    .number()
    .min(0)
    .max(100)
    .nullable()
    .optional()
    .describe('Battery state of charge, percent; null when unknown'),
});

/** Rate limit of the reading route: 60 a minute per asset and caller (shared Redis store). */
const readingRateLimit = {
  max: 60,
  timeWindow: '1 minute',
  keyGenerator: (request: FastifyRequest): string => {
    const user = request.user as unknown as Record<string, unknown> | undefined;
    const params = request.params as { assetId?: unknown } | undefined;
    const assetId = typeof params?.assetId === 'string' ? params.assetId : '';
    if (user == null) return `energy-reading:ip:${request.ip}:${assetId}`;
    const actor = getAuditActor(request);
    const caller =
      actor.actorApiKeyId != null
        ? `api_key:${actor.actorApiKeyId}`
        : `user:${actor.actorUserId ?? 'unknown'}`;
    return `energy-reading:${caller}:${assetId}`;
  },
};

export function energyAssetReadingRoutes(app: FastifyInstance): void {
  app.put(
    '/sites/:siteId/energy-assets/:assetId/reading',
    {
      onRequest: [authorize('loadManagement:write')],
      config: { rateLimit: readingRateLimit },
      schema: {
        tags: ['Load Management'],
        summary: 'Report the latest reading of a battery or solar array',
        description:
          'For an external EMS, BMS or gateway, usually with an API key scoped to loadManagement:write, at most once a second per asset. The asset must use api telemetry. The latest reading replaces the stored one; one measured earlier than the stored one answers 409 ENERGY_ASSET_READING_OUTDATED. A reportedAt after the time the CSMS received the reading is stored as that time. The credit it gives is capped at the asset nameplate and ends when the reading is older than the asset reading TTL, counted from the earlier of reportedAt and its arrival. Answers 204.',
        operationId: 'reportEnergyAssetReading',
        security: [{ bearerAuth: [] }],
        params: zodSchema(assetIdParam),
        body: zodSchema(readingBody),
        response: {
          204: { type: 'null' as const },
          400: assetValidationError,
          404: errorWith('Battery or solar array not found', [ERROR_CODES.ENERGY_ASSET_NOT_FOUND]),
          409: errorWith(
            'A newer reading is already stored',
            [ERROR_CODES.ENERGY_ASSET_READING_OUTDATED],
            { field: z.literal('reportedAt').describe('The input to fix') },
          ),
        },
      },
    },
    async (request, reply) => {
      const { siteId, assetId } = request.params as z.infer<typeof assetIdParam>;
      const body = parseZodRequest(readingBody, request.body);
      if (!(await assetSiteAllowed(request, siteId))) {
        await sendAssetNotFound(reply);
        return;
      }
      const asset = await readSiteAsset(siteId, assetId);
      if (asset == null) {
        await sendAssetNotFound(reply);
        return;
      }
      if (asset.telemetry !== 'api') {
        await sendFieldError(
          reply,
          'telemetry',
          'This battery or solar array does not take readings from the API (set its telemetry to api)',
        );
        return;
      }
      const reportedAt = new Date(body.reportedAt);
      const nowMs = Date.now();
      if (reportedAt.getTime() - nowMs > ENERGY_ASSET_FUTURE_SKEW_MS) {
        await sendFieldError(
          reply,
          'reportedAt',
          'The reading is more than 30 seconds in the future',
        );
        return;
      }
      if (nowMs - reportedAt.getTime() > asset.readingTtlSeconds * 1000) {
        await sendFieldError(
          reply,
          'reportedAt',
          `The reading is older than the asset reading TTL (${String(asset.readingTtlSeconds)} seconds)`,
        );
        return;
      }

      const stored = await recordEnergyAssetReading({
        assetId,
        reportedAt,
        receivedAt: new Date(nowMs),
        powerKw: body.powerKw,
        availableKw: body.availableKw ?? null,
        socPercent: body.socPercent ?? null,
        source: 'api',
        apiKeyId: getAuditActor(request).actorApiKeyId,
      });
      if (!stored) {
        // A reading measured before the stored one never replaces it, and the
        // sender learns it instead of a silent 204 (security case 333).
        await reply.status(409).send({
          error: 'A newer reading of this battery or solar array is already stored',
          code: 'ENERGY_ASSET_READING_OUTDATED',
          field: 'reportedAt',
        });
        return;
      }
      // A reading arrives every few seconds: it bumps no response cache tag
      // (the site replies follow within their 5 second TTL).
      request.responseCacheUnchanged = true;
      await reply.status(204).send();
    },
  );
}
