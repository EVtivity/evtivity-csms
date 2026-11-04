// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import {
  db,
  panels,
  transformers,
  createTransformer,
  updateTransformer,
  deleteTransformer,
} from '@evtivity/database';
import type { TransformerChanges, TransformerRow } from '@evtivity/database';
import {
  PANEL_VOLTAGES,
  TRANSFORMER_KINDS,
  TRANSFORMER_LOADING_LIMIT_RANGE,
  TRANSFORMER_POWER_FACTOR_RANGE,
  TRANSFORMER_RATED_KVA_RANGE,
  isPanelVoltageAllowed,
} from '@evtivity/lib';
import { parseZodRequest, zodSchema } from '../lib/zod-schema.js';
import { itemResponse, arrayResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { authorize } from '../middleware/rbac.js';
import { replanSiteAfterWrite } from '../lib/site-plan-stale.js';
import { siteInScope } from '../lib/site-scope.js';
import { siteExists } from '../lib/site-exists.js';
import { loadTreeContext } from '../lib/load-management-audit.js';
import { sendFieldError, withTreeValidation } from '../lib/load-tree-validation.js';

// Transformers of a site's load management tree (features/load-management.md):
// a service transformer above the top-level panels that name it, a step-down
// transformer fed from a panel breaker above a sub-panel. Written only through
// the tree writer (`@evtivity/database` load-management-tree), which computes
// the capacity and refuses links that break the tree rules.

// --- Schemas ---

const siteIdParam = z.object({
  siteId: z.string().describe('Site ID'),
});

const transformerIdParam = z.object({
  siteId: z.string().describe('Site ID'),
  transformerId: z.string().describe('Transformer ID'),
});

const kindField = z
  .enum(TRANSFORMER_KINDS)
  .describe(
    'service: the transformer of the site service above its top-level panels (utility or customer owned); step_down: a dry-type unit fed from a panel breaker that feeds a sub-panel',
  );
const nameField = z.string().trim().min(1).max(60).describe('Display name');
const ratedKvaField = z
  .number()
  .min(TRANSFORMER_RATED_KVA_RANGE.min)
  .max(TRANSFORMER_RATED_KVA_RANGE.max)
  .nullable()
  .describe(
    'Nameplate rating in kVA; null when unknown (an unrated transformer cannot feed a panel and limits nothing)',
  );
const phasesField = z
  .number()
  .int()
  .refine((v) => v === 1 || v === 3, { message: 'Phases must be 1 or 3' })
  .describe('Number of phases (1 or 3)');
const secondaryVoltageField = z
  .number()
  .int()
  .refine((v) => (PANEL_VOLTAGES as readonly number[]).includes(v), {
    message: `Voltage must be one of: ${PANEL_VOLTAGES.join(', ')}`,
  })
  .nullable()
  .describe(
    'Secondary voltage in volts, phase to neutral for three-phase (120 for 208Y/120, 277 for 480Y/277); null when unknown',
  );
const powerFactorField = z
  .number()
  .min(TRANSFORMER_POWER_FACTOR_RANGE.min)
  .max(TRANSFORMER_POWER_FACTOR_RANGE.max)
  .describe('Power factor that turns kVA into kW, 0.80 to 1.00 (default 0.95)');
const loadingLimitField = z
  .number()
  .int()
  .min(TRANSFORMER_LOADING_LIMIT_RANGE.min)
  .max(TRANSFORMER_LOADING_LIMIT_RANGE.max)
  .describe('Share of the nameplate rating load management may use, 50 to 100 percent');
const safetyMarginField = z
  .number()
  .min(0)
  .max(10000)
  .describe('Capacity in kW kept free below the transformer limit');
const fedFromPanelField = z
  .string()
  .nullable()
  .describe(
    'Panel whose breaker feeds a step-down transformer; required for step_down, null for service',
  );
const sortOrderField = z.number().int().min(0).max(10000).describe('Display order within the site');

const createTransformerBody = z.object({
  kind: kindField,
  name: nameField,
  ratedKva: ratedKvaField.optional(),
  phases: phasesField.optional().default(3),
  secondaryVoltageV: secondaryVoltageField.optional(),
  powerFactor: powerFactorField.optional().default(TRANSFORMER_POWER_FACTOR_RANGE.default),
  loadingLimitPercent: loadingLimitField
    .optional()
    .default(TRANSFORMER_LOADING_LIMIT_RANGE.default),
  safetyMarginKw: safetyMarginField.optional().default(0),
  fedFromPanelId: fedFromPanelField.optional(),
  sortOrder: sortOrderField.optional(),
});

const updateTransformerBody = z.object({
  kind: kindField.optional(),
  name: nameField.optional(),
  ratedKva: ratedKvaField.optional(),
  phases: phasesField.optional(),
  secondaryVoltageV: secondaryVoltageField.optional(),
  powerFactor: powerFactorField.optional(),
  loadingLimitPercent: loadingLimitField.optional(),
  safetyMarginKw: safetyMarginField.optional(),
  fedFromPanelId: fedFromPanelField.optional(),
  sortOrder: sortOrderField.optional(),
});

export const transformerItem = z
  .object({
    id: z.string().describe('Transformer ID'),
    siteId: z.string().describe('Site the transformer belongs to'),
    kind: kindField,
    name: z.string().max(60).describe('Display name'),
    ratedKva: z.number().nullable().describe('Nameplate rating in kVA; null when unrated'),
    phases: z.number().int().describe('Number of phases (1 or 3)'),
    secondaryVoltageV: z
      .number()
      .int()
      .nullable()
      .describe('Secondary voltage in volts (phase to neutral for three-phase); null when unknown'),
    powerFactor: z.number().describe('Power factor that turns kVA into kW'),
    loadingLimitPercent: z
      .number()
      .int()
      .describe('Share of the nameplate rating load management may use, in percent'),
    safetyMarginKw: z.number().describe('Capacity in kW kept free below the limit'),
    fedFromPanelId: z
      .string()
      .nullable()
      .describe('Panel that feeds a step-down transformer; null for a service transformer'),
    maxContinuousKw: z
      .number()
      .nullable()
      .describe(
        'Capacity in kW: rated kVA x power factor x loading limit; null when unrated (limits nothing)',
      ),
    panelIds: z
      .array(z.string())
      .describe('Panels this transformer feeds (panels whose transformerId names it)'),
    sortOrder: z.number().int().describe('Display order within the site'),
    createdAt: z.coerce.date().describe('Timestamp when created'),
    updatedAt: z.coerce.date().describe('Timestamp when last modified'),
  })
  .loose();

const validationError = errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR], {
  field: z.string().optional().describe('The input to fix'),
});

// --- Helpers ---

function toItem(row: TransformerRow, panelIds: string[]): Record<string, unknown> {
  return {
    ...row,
    ratedKva: row.ratedKva == null ? null : Number(row.ratedKva),
    powerFactor: Number(row.powerFactor),
    safetyMarginKw: Number(row.safetyMarginKw),
    maxContinuousKw: row.maxContinuousKw == null ? null : Number(row.maxContinuousKw),
    panelIds,
  };
}

async function linkedPanelIds(siteId: string, transformerId: string): Promise<string[]> {
  const rows = await db
    .select({ id: panels.id })
    .from(panels)
    .where(and(eq(panels.siteId, siteId), eq(panels.transformerId, transformerId)));
  return rows.map((r) => r.id);
}

async function notFound(reply: FastifyReply): Promise<void> {
  await reply.status(404).send({ error: 'Transformer not found', code: 'TRANSFORMER_NOT_FOUND' });
}

async function siteAllowed(request: { user: unknown }, siteId: string): Promise<boolean> {
  const { userId } = request.user as { userId: string };
  return siteInScope(await getUserSiteIds(userId), siteId);
}

const THREE_PHASE_VOLTAGE_ERROR =
  'A three-phase transformer takes its phase to neutral secondary voltage (120 for 208Y/120, 277 for 480Y/277)';

// --- Routes ---

export function transformerRoutes(app: FastifyInstance): void {
  app.get(
    '/sites/:siteId/transformers',
    {
      onRequest: [authorize('loadManagement:read')],
      schema: {
        tags: ['Load Management'],
        summary: 'List the transformers of a site',
        operationId: 'listTransformers',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParam),
        response: {
          200: arrayResponse(transformerItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { siteId } = request.params as z.infer<typeof siteIdParam>;
      if (!(await siteAllowed(request, siteId))) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const rows = await db
        .select()
        .from(transformers)
        .where(eq(transformers.siteId, siteId))
        .orderBy(asc(transformers.sortOrder), asc(transformers.createdAt));
      const links = await db
        .select({ id: panels.id, transformerId: panels.transformerId })
        .from(panels)
        .where(and(eq(panels.siteId, siteId), isNotNull(panels.transformerId)));
      return rows.map((row) =>
        toItem(
          row,
          links.filter((l) => l.transformerId === row.id).map((l) => l.id),
        ),
      );
    },
  );

  app.post(
    '/sites/:siteId/transformers',
    {
      onRequest: [authorize('loadManagement:write')],
      onResponse: [replanSiteAfterWrite('transformer_changed')],
      schema: {
        tags: ['Load Management'],
        summary: 'Create a transformer',
        operationId: 'createTransformer',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParam),
        body: zodSchema(createTransformerBody),
        response: {
          201: itemResponse(transformerItem),
          400: validationError,
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
          500: errorWith('Create failed', [ERROR_CODES.CREATE_FAILED]),
        },
      },
    },
    async (request, reply) => {
      const { siteId } = request.params as z.infer<typeof siteIdParam>;
      const body = parseZodRequest(createTransformerBody, request.body);
      if (!(await siteAllowed(request, siteId)) || !(await siteExists(siteId))) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      if (
        body.secondaryVoltageV != null &&
        !isPanelVoltageAllowed(body.secondaryVoltageV, body.phases)
      ) {
        await sendFieldError(reply, 'secondaryVoltageV', THREE_PHASE_VOLTAGE_ERROR);
        return;
      }
      const result = await withTreeValidation(reply, () =>
        createTransformer(
          {
            siteId,
            kind: body.kind,
            name: body.name,
            ratedKva: body.ratedKva == null ? null : String(body.ratedKva),
            phases: body.phases,
            secondaryVoltageV: body.secondaryVoltageV ?? null,
            powerFactor: body.powerFactor.toFixed(2),
            loadingLimitPercent: body.loadingLimitPercent,
            safetyMarginKw: String(body.safetyMarginKw),
            fedFromPanelId: body.fedFromPanelId ?? null,
            sortOrder: body.sortOrder ?? 0,
          },
          loadTreeContext(request),
        ),
      );
      if (result.refused) return;
      if (result.value == null) {
        await reply
          .status(500)
          .send({ error: 'Failed to create transformer', code: 'CREATE_FAILED' });
        return;
      }
      return reply.status(201).send(toItem(result.value, []));
    },
  );

  app.patch(
    '/sites/:siteId/transformers/:transformerId',
    {
      onRequest: [authorize('loadManagement:write')],
      onResponse: [replanSiteAfterWrite('transformer_changed')],
      schema: {
        tags: ['Load Management'],
        summary: 'Update a transformer',
        description:
          'Changes the rating, power factor or loading limit recompute the capacity. A change that would break a panel it feeds (an unrated transformer, a kind or feeding panel the panel cannot take) answers 400.',
        operationId: 'updateTransformer',
        security: [{ bearerAuth: [] }],
        params: zodSchema(transformerIdParam),
        body: zodSchema(updateTransformerBody),
        response: {
          200: itemResponse(transformerItem),
          400: validationError,
          404: errorWith('Transformer not found', [ERROR_CODES.TRANSFORMER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { siteId, transformerId } = request.params as z.infer<typeof transformerIdParam>;
      const body = parseZodRequest(updateTransformerBody, request.body);
      if (!(await siteAllowed(request, siteId))) {
        await notFound(reply);
        return;
      }
      const [existing] = await db
        .select()
        .from(transformers)
        .where(and(eq(transformers.id, transformerId), eq(transformers.siteId, siteId)));
      if (existing == null) {
        await notFound(reply);
        return;
      }

      const phases = body.phases ?? existing.phases;
      const voltage =
        body.secondaryVoltageV !== undefined ? body.secondaryVoltageV : existing.secondaryVoltageV;
      if (voltage != null && !isPanelVoltageAllowed(voltage, phases)) {
        await sendFieldError(reply, 'secondaryVoltageV', THREE_PHASE_VOLTAGE_ERROR);
        return;
      }

      const set: TransformerChanges = {};
      if (body.kind != null) set.kind = body.kind;
      if (body.name != null) set.name = body.name;
      if (body.ratedKva !== undefined) {
        set.ratedKva = body.ratedKva == null ? null : String(body.ratedKva);
      }
      if (body.phases != null) set.phases = body.phases;
      if (body.secondaryVoltageV !== undefined) set.secondaryVoltageV = body.secondaryVoltageV;
      if (body.powerFactor != null) set.powerFactor = body.powerFactor.toFixed(2);
      if (body.loadingLimitPercent != null) set.loadingLimitPercent = body.loadingLimitPercent;
      if (body.safetyMarginKw != null) set.safetyMarginKw = String(body.safetyMarginKw);
      if (body.fedFromPanelId !== undefined) set.fedFromPanelId = body.fedFromPanelId;
      if (body.sortOrder != null) set.sortOrder = body.sortOrder;

      const result = await withTreeValidation(reply, () =>
        updateTransformer({ siteId, transformerId, existing, set }, loadTreeContext(request)),
      );
      if (result.refused) return;
      if (result.value == null) {
        await notFound(reply);
        return;
      }
      return toItem(result.value, await linkedPanelIds(siteId, transformerId));
    },
  );

  app.delete(
    '/sites/:siteId/transformers/:transformerId',
    {
      onRequest: [authorize('loadManagement:write')],
      onResponse: [replanSiteAfterWrite('transformer_changed')],
      schema: {
        tags: ['Load Management'],
        summary: 'Delete a transformer',
        description:
          'Unlinks the panels it feeds (they become roots again) and leaves a battery or solar array connected to it without a connection point.',
        operationId: 'deleteTransformer',
        security: [{ bearerAuth: [] }],
        params: zodSchema(transformerIdParam),
        response: {
          200: itemResponse(z.object({ success: z.literal(true) }).loose()),
          404: errorWith('Transformer not found', [ERROR_CODES.TRANSFORMER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { siteId, transformerId } = request.params as z.infer<typeof transformerIdParam>;
      if (!(await siteAllowed(request, siteId))) {
        await notFound(reply);
        return;
      }
      const [existing] = await db
        .select()
        .from(transformers)
        .where(and(eq(transformers.id, transformerId), eq(transformers.siteId, siteId)));
      if (existing == null) {
        await notFound(reply);
        return;
      }
      await deleteTransformer({ siteId, transformer: existing }, loadTreeContext(request));
      return { success: true as const };
    },
  );
}
