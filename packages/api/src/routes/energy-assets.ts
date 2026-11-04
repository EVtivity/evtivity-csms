// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  db,
  energyAssetReadings,
  siteEnergyAssets,
  createEnergyAsset,
  updateEnergyAsset,
  deleteEnergyAsset,
} from '@evtivity/database';
import type { EnergyAssetChanges, EnergyAssetReadingRow, EnergyAssetRow } from '@evtivity/database';
import {
  ENERGY_ASSET_GRID_CHARGING,
  ENERGY_ASSET_RATING_RANGE,
  ENERGY_ASSET_READING_TTL_RANGE,
  ENERGY_ASSET_RESERVE_RANGE,
  ENERGY_ASSET_TELEMETRY,
  ENERGY_ASSET_TYPES,
  energyAssetSupply,
} from '@evtivity/lib';
import {
  buildSiteHierarchy,
  getSitePowerStatus,
  type EnergyAssetNodeSupply,
  type HierarchyNode,
} from '@evtivity/services/load-management.service';
import { parseZodRequest, zodSchema } from '../lib/zod-schema.js';
import { itemResponse, arrayResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { config as apiConfig } from '../lib/config.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { authorize } from '../middleware/rbac.js';
import { replanSiteAfterWrite } from '../lib/site-plan-stale.js';
import { siteInScope } from '../lib/site-scope.js';
import { siteExists } from '../lib/site-exists.js';
import { loadTreeContext } from '../lib/load-management-audit.js';
import { withTreeValidation } from '../lib/load-tree-validation.js';

// Batteries and solar of a site (features/load-management.md, "Transformers
// and energy assets"). They give load management supply only while connected at a
// transformer or a panel and while a fresh reading arrives: `api` readings
// come from an external EMS, BMS or gateway through the reading route below,
// `simulated` ones (development and demos, ENERGY_ASSETS_ALLOW_SIMULATED) are
// computed by the load management cycle. Written only through the energy
// asset writer (`@evtivity/database` site-energy-assets); the reading route
// lives in energy-asset-readings.ts.

// --- Schemas ---

const siteIdParam = z.object({
  siteId: z.string().describe('Site ID'),
});

const assetIdParam = z.object({
  siteId: z.string().describe('Site ID'),
  assetId: z.string().describe('Battery or solar array ID'),
});

const rating = (description: string) =>
  z
    .number()
    // At least 0.1 kW (the column takes any value above 0).
    .min(0.1)
    .max(ENERGY_ASSET_RATING_RANGE.max)
    .nullable()
    .describe(`${description}; null when unknown`);
const intRating = (description: string) =>
  z
    .number()
    .int()
    .min(ENERGY_ASSET_RATING_RANGE.min)
    .max(ENERGY_ASSET_RATING_RANGE.max)
    .nullable()
    .describe(`${description}; null when unknown`);

const typeField = z.enum(ENERGY_ASSET_TYPES).describe('battery or solar');
const nameField = z.string().trim().min(1).max(60).describe('Display name');
const capacityField = intRating('Battery energy capacity in kWh (battery only)');
const peakField = intRating('Solar DC peak power in kWp (solar only)');
const inverterField = rating('Inverter AC nameplate output in kW; caps every credit');
const dischargeField = rating('Battery maximum discharge power in kW (battery only)');
const chargeField = rating('Battery maximum charge power in kW (battery only)');
const phasesField = z
  .number()
  .int()
  .refine((v) => v === 1 || v === 3, { message: 'Phases must be 1 or 3' })
  .describe('Inverter phases (1 or 3); a single-phase asset gives no per-phase credit');
const connectionTransformerField = z
  .string()
  .nullable()
  .describe(
    'Transformer it connects at, supply-side (NEC 705.11): its credit counts on that transformer only. At most one connection point',
  );
const connectionPanelField = z
  .string()
  .nullable()
  .describe(
    'Panel it connects at, load-side (NEC 705.12): its credit counts on the panels and transformer above that panel. At most one connection point; with none the asset counts nowhere',
  );
const gridChargingField = z
  .enum(ENERGY_ASSET_GRID_CHARGING)
  .describe(
    'Battery: possible makes a battery without a fresh reading count as a load at its maximum charge power',
  );
const reserveField = z
  .number()
  .int()
  .min(ENERGY_ASSET_RESERVE_RANGE.min)
  .max(ENERGY_ASSET_RESERVE_RANGE.max)
  .describe('Battery: no discharge credit at or below this state of charge, percent');
const telemetryField = z
  .enum(ENERGY_ASSET_TELEMETRY)
  .describe(
    'Where readings come from: none, api (pushed to the reading route) or simulated (only where the installation allows simulated readings)',
  );
const ttlField = z
  .number()
  .int()
  .min(ENERGY_ASSET_READING_TTL_RANGE.min)
  .max(ENERGY_ASSET_READING_TTL_RANGE.max)
  .describe('Seconds a reading stays fresh; after that the asset gives no supply');

const createAssetBody = z.object({
  type: typeField,
  name: nameField,
  capacityKwh: capacityField.optional(),
  peakKwp: peakField.optional(),
  inverterKw: inverterField.optional(),
  maxDischargeKw: dischargeField.optional(),
  maxChargeKw: chargeField.optional(),
  phases: phasesField.optional().default(3),
  connectionTransformerId: connectionTransformerField.optional(),
  connectionPanelId: connectionPanelField.optional(),
  gridCharging: gridChargingField.optional(),
  reservePercent: reserveField.optional().default(ENERGY_ASSET_RESERVE_RANGE.default),
  telemetry: telemetryField.optional().default('none'),
  readingTtlSeconds: ttlField.optional().default(ENERGY_ASSET_READING_TTL_RANGE.default),
});

const updateAssetBody = z.object({
  type: typeField.optional(),
  name: nameField.optional(),
  capacityKwh: capacityField.optional(),
  peakKwp: peakField.optional(),
  inverterKw: inverterField.optional(),
  maxDischargeKw: dischargeField.optional(),
  maxChargeKw: chargeField.optional(),
  phases: phasesField.optional(),
  connectionTransformerId: connectionTransformerField.optional(),
  connectionPanelId: connectionPanelField.optional(),
  gridCharging: gridChargingField.optional(),
  reservePercent: reserveField.optional(),
  telemetry: telemetryField.optional(),
  readingTtlSeconds: ttlField.optional(),
});

const readingItem = z
  .object({
    reportedAt: z.coerce.date().describe('When the asset measured the values'),
    receivedAt: z.coerce.date().describe('When the CSMS received the reading'),
    powerKw: z.number().describe('AC power in kW: positive output or discharge, negative charging'),
    availableKw: z.number().nullable().describe('Power the controller says it can give, kW'),
    socPercent: z.number().nullable().describe('Battery state of charge, percent'),
    source: z.string().describe('api or simulated'),
  })
  .loose();

export const energyAssetItem = z
  .object({
    id: z.string().describe('Battery or solar array ID'),
    siteId: z.string().describe('Site it belongs to'),
    type: typeField,
    name: z.string().max(60).describe('Display name'),
    capacityKwh: z.number().int().nullable().describe('Battery energy capacity in kWh'),
    peakKwp: z.number().int().nullable().describe('Solar DC peak power in kWp'),
    inverterKw: z.number().nullable().describe('Inverter AC nameplate output in kW'),
    maxDischargeKw: z.number().nullable().describe('Battery maximum discharge power in kW'),
    maxChargeKw: z.number().nullable().describe('Battery maximum charge power in kW'),
    phases: z.number().int().describe('Inverter phases (1 or 3)'),
    connectionTransformerId: z.string().nullable().describe('Transformer it connects at'),
    connectionPanelId: z.string().nullable().describe('Panel it connects at'),
    gridCharging: z
      .enum(ENERGY_ASSET_GRID_CHARGING)
      .describe('Whether it may charge from the grid'),
    reservePercent: z.number().int().describe('Reserve state of charge, percent'),
    telemetry: z.enum(ENERGY_ASSET_TELEMETRY).describe('Where readings come from'),
    readingTtlSeconds: z.number().int().describe('Seconds a reading stays fresh'),
    reading: readingItem
      .nullable()
      .describe('The latest stored reading; null when none (simulated readings are not stored)'),
    supply: z
      .object({
        state: z
          .enum(['fresh', 'stale', 'none'])
          .describe('fresh: a reading inside its TTL; stale: an older one; none: no reading'),
        counted: z
          .boolean()
          .describe(
            'Whether load management counts the asset now: it connects at a transformer or panel in the tree',
          ),
        creditKw: z.number().describe('Supply credited above the connection point, kW'),
        loadKw: z.number().describe('Load it adds at its connection point, kW'),
      })
      .loose()
      .describe('What the asset gives load management now'),
    createdAt: z.coerce.date().describe('Timestamp when created'),
    updatedAt: z.coerce.date().describe('Timestamp when last modified'),
  })
  .loose();

export const assetValidationError = errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR], {
  field: z.string().optional().describe('The input to fix'),
});

// --- Helpers ---

const num = (value: string | null): number | null => (value == null ? null : Number(value));

type Supply = {
  state: 'fresh' | 'stale' | 'none';
  counted: boolean;
  creditKw: number;
  loadKw: number;
};

function readingView(reading: EnergyAssetReadingRow | undefined): Record<string, unknown> | null {
  if (reading == null) return null;
  return {
    reportedAt: reading.reportedAt,
    receivedAt: reading.receivedAt,
    powerKw: Number(reading.powerKw),
    availableKw: num(reading.availableKw),
    socPercent: num(reading.socPercent),
    source: reading.source,
  };
}

/** The supply of an asset outside the tree: its reading state only, it counts nowhere. */
function uncountedSupply(
  asset: EnergyAssetRow,
  reading: EnergyAssetReadingRow | undefined,
  nowMs: number,
): Supply {
  const usable = asset.telemetry === 'api' && reading != null && reading.source === 'api';
  const { state } = energyAssetSupply(
    {
      type: asset.type,
      inverterKw: num(asset.inverterKw),
      peakKwp: asset.peakKwp,
      maxDischargeKw: num(asset.maxDischargeKw),
      maxChargeKw: num(asset.maxChargeKw),
      gridCharging: asset.gridCharging,
      reservePercent: asset.reservePercent,
      ttlSeconds: asset.readingTtlSeconds,
      reading: usable
        ? {
            receivedAtMs: reading.receivedAt.getTime(),
            reportedAtMs: reading.reportedAt.getTime(),
            powerKw: Number(reading.powerKw),
            availableKw: num(reading.availableKw),
            socPercent: num(reading.socPercent),
          }
        : null,
    },
    nowMs,
  );
  return { state, counted: false, creditKw: 0, loadKw: 0 };
}

function collectTreeSupply(
  nodes: readonly HierarchyNode[],
  into: Map<string, EnergyAssetNodeSupply>,
): void {
  for (const node of nodes) {
    for (const asset of node.energyAssets ?? []) into.set(asset.id, asset);
    collectTreeSupply(node.children, into);
  }
}

function toItem(
  row: EnergyAssetRow,
  reading: EnergyAssetReadingRow | undefined,
  supply: Supply,
): Record<string, unknown> {
  return {
    ...row,
    inverterKw: num(row.inverterKw),
    maxDischargeKw: num(row.maxDischargeKw),
    maxChargeKw: num(row.maxChargeKw),
    reading: readingView(reading),
    supply,
  };
}

const NO_SUPPLY: Supply = { state: 'none', counted: false, creditKw: 0, loadKw: 0 };

export async function sendAssetNotFound(reply: FastifyReply): Promise<void> {
  await reply
    .status(404)
    .send({ error: 'Battery or solar array not found', code: 'ENERGY_ASSET_NOT_FOUND' });
}

export async function assetSiteAllowed(request: FastifyRequest, siteId: string): Promise<boolean> {
  const { userId } = request.user as { userId: string };
  return siteInScope(await getUserSiteIds(userId), siteId);
}

export async function readSiteAsset(
  siteId: string,
  assetId: string,
): Promise<EnergyAssetRow | undefined> {
  const [row] = await db
    .select()
    .from(siteEnergyAssets)
    .where(and(eq(siteEnergyAssets.id, assetId), eq(siteEnergyAssets.siteId, siteId)));
  return row;
}

// --- Routes ---

export function energyAssetRoutes(app: FastifyInstance): void {
  app.get(
    '/sites/:siteId/energy-assets',
    {
      onRequest: [authorize('loadManagement:read')],
      schema: {
        tags: ['Load Management'],
        summary: 'List the batteries and solar arrays of a site',
        description:
          'Each asset with its latest stored reading and what it gives load management now (the computation of the load management cycle).',
        operationId: 'listEnergyAssets',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParam),
        response: {
          200: arrayResponse(energyAssetItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { siteId } = request.params as z.infer<typeof siteIdParam>;
      if (!(await assetSiteAllowed(request, siteId))) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const rows = await db
        .select()
        .from(siteEnergyAssets)
        .where(eq(siteEnergyAssets.siteId, siteId))
        .orderBy(asc(siteEnergyAssets.createdAt));
      if (rows.length === 0) return [];

      const readings: EnergyAssetReadingRow[] = await db
        .select()
        .from(energyAssetReadings)
        .where(
          inArray(
            energyAssetReadings.assetId,
            rows.map((r) => r.id),
          ),
        );
      const readingOf = new Map(readings.map((r) => [r.assetId, r]));

      // The same tree and supply as the load management cycle, so the list
      // shows the credit the stations get.
      const nowMs = Date.now();
      const status = await getSitePowerStatus(siteId);
      const hierarchy = await buildSiteHierarchy(siteId, status.stations, {
        nowMs,
        log: request.log,
        allowSimulatedEnergyAssets: apiConfig.ENERGY_ASSETS_ALLOW_SIMULATED,
      });
      const inTree = new Map<string, EnergyAssetNodeSupply>();
      collectTreeSupply(hierarchy, inTree);

      return rows.map((row) => {
        const reading = readingOf.get(row.id);
        const counted = inTree.get(row.id);
        const supply: Supply =
          counted != null
            ? {
                state: counted.state,
                counted: true,
                creditKw: counted.creditKw,
                loadKw: counted.loadKw,
              }
            : uncountedSupply(row, reading, nowMs);
        return toItem(row, reading, supply);
      });
    },
  );

  app.post(
    '/sites/:siteId/energy-assets',
    {
      onRequest: [authorize('loadManagement:write')],
      onResponse: [replanSiteAfterWrite('energy_asset_changed')],
      schema: {
        tags: ['Load Management'],
        summary: 'Create a battery or solar array',
        operationId: 'createEnergyAsset',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParam),
        body: zodSchema(createAssetBody),
        response: {
          201: itemResponse(energyAssetItem),
          400: assetValidationError,
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
          500: errorWith('Create failed', [ERROR_CODES.CREATE_FAILED]),
        },
      },
    },
    async (request, reply) => {
      const { siteId } = request.params as z.infer<typeof siteIdParam>;
      const body = parseZodRequest(createAssetBody, request.body);
      if (!(await assetSiteAllowed(request, siteId)) || !(await siteExists(siteId))) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const result = await withTreeValidation(reply, () =>
        createEnergyAsset(
          {
            siteId,
            type: body.type,
            name: body.name,
            capacityKwh: body.capacityKwh ?? null,
            peakKwp: body.peakKwp ?? null,
            inverterKw: body.inverterKw == null ? null : String(body.inverterKw),
            maxDischargeKw: body.maxDischargeKw == null ? null : String(body.maxDischargeKw),
            maxChargeKw: body.maxChargeKw == null ? null : String(body.maxChargeKw),
            phases: body.phases,
            connectionTransformerId: body.connectionTransformerId ?? null,
            connectionPanelId: body.connectionPanelId ?? null,
            ...(body.gridCharging != null ? { gridCharging: body.gridCharging } : {}),
            reservePercent: body.reservePercent,
            telemetry: body.telemetry,
            readingTtlSeconds: body.readingTtlSeconds,
          },
          loadTreeContext(request),
          { allowSimulated: apiConfig.ENERGY_ASSETS_ALLOW_SIMULATED },
        ),
      );
      if (result.refused) return;
      if (result.value == null) {
        await reply
          .status(500)
          .send({ error: 'Failed to create the energy asset', code: 'CREATE_FAILED' });
        return;
      }
      return reply.status(201).send(toItem(result.value, undefined, NO_SUPPLY));
    },
  );

  app.patch(
    '/sites/:siteId/energy-assets/:assetId',
    {
      onRequest: [authorize('loadManagement:write')],
      onResponse: [replanSiteAfterWrite('energy_asset_changed')],
      schema: {
        tags: ['Load Management'],
        summary: 'Update a battery or solar array',
        operationId: 'updateEnergyAsset',
        security: [{ bearerAuth: [] }],
        params: zodSchema(assetIdParam),
        body: zodSchema(updateAssetBody),
        response: {
          200: itemResponse(energyAssetItem),
          400: assetValidationError,
          404: errorWith('Battery or solar array not found', [ERROR_CODES.ENERGY_ASSET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { siteId, assetId } = request.params as z.infer<typeof assetIdParam>;
      const body = parseZodRequest(updateAssetBody, request.body);
      if (!(await assetSiteAllowed(request, siteId))) {
        await sendAssetNotFound(reply);
        return;
      }
      const existing = await readSiteAsset(siteId, assetId);
      if (existing == null) {
        await sendAssetNotFound(reply);
        return;
      }

      const set: EnergyAssetChanges = {};
      if (body.type != null) set.type = body.type;
      if (body.name != null) set.name = body.name;
      if (body.capacityKwh !== undefined) set.capacityKwh = body.capacityKwh;
      if (body.peakKwp !== undefined) set.peakKwp = body.peakKwp;
      for (const field of ['inverterKw', 'maxDischargeKw', 'maxChargeKw'] as const) {
        const value = body[field];
        if (value !== undefined) set[field] = value == null ? null : String(value);
      }
      if (body.phases != null) set.phases = body.phases;
      if (body.connectionTransformerId !== undefined) {
        set.connectionTransformerId = body.connectionTransformerId;
      }
      if (body.connectionPanelId !== undefined) set.connectionPanelId = body.connectionPanelId;
      if (body.gridCharging != null) set.gridCharging = body.gridCharging;
      if (body.reservePercent != null) set.reservePercent = body.reservePercent;
      if (body.telemetry != null) set.telemetry = body.telemetry;
      if (body.readingTtlSeconds != null) set.readingTtlSeconds = body.readingTtlSeconds;

      const result = await withTreeValidation(reply, () =>
        updateEnergyAsset({ siteId, assetId, existing, set }, loadTreeContext(request), {
          allowSimulated: apiConfig.ENERGY_ASSETS_ALLOW_SIMULATED,
        }),
      );
      if (result.refused) return;
      if (result.value == null) {
        await sendAssetNotFound(reply);
        return;
      }
      return toItem(result.value, undefined, NO_SUPPLY);
    },
  );

  app.delete(
    '/sites/:siteId/energy-assets/:assetId',
    {
      onRequest: [authorize('loadManagement:write')],
      onResponse: [replanSiteAfterWrite('energy_asset_changed')],
      schema: {
        tags: ['Load Management'],
        summary: 'Delete a battery or solar array',
        operationId: 'deleteEnergyAsset',
        security: [{ bearerAuth: [] }],
        params: zodSchema(assetIdParam),
        response: {
          200: itemResponse(z.object({ success: z.literal(true) }).loose()),
          404: errorWith('Battery or solar array not found', [ERROR_CODES.ENERGY_ASSET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { siteId, assetId } = request.params as z.infer<typeof assetIdParam>;
      if (!(await assetSiteAllowed(request, siteId))) {
        await sendAssetNotFound(reply);
        return;
      }
      const existing = await readSiteAsset(siteId, assetId);
      if (existing == null) {
        await sendAssetNotFound(reply);
        return;
      }
      await deleteEnergyAsset({ siteId, asset: existing }, loadTreeContext(request));
      return { success: true as const };
    },
  );
}
