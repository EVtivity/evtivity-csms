// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The one writer of a site's batteries and solar (`site_energy_assets`) and
// of their latest readings (`energy_asset_readings`). Every asset write
// records the site `load_management_changed` audit row in the caller's name
// (fail-open, writeAudit); a reading writes no audit row (they arrive every
// few seconds), and the asset's audit notes when its telemetry changes.
//
// An asset connects at most at one point of the site's tree: a transformer
// (supply-side, NEC 705.11) or a panel (load-side, 705.12), both of its own
// site; without one it is informational and counts nowhere. A three-phase
// asset connects only at a three-phase point (its credit is split over the
// three phases above it), and a connected battery that may charge from the
// grid needs a charge or inverter rating (its load without data, D9).
// `simulated` telemetry is refused unless the caller allows it (the process
// reads ENERGY_ASSETS_ALLOW_SIMULATED). A reading never replaces a newer one.

import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../config.js';
import {
  energyAssetReadings,
  panels,
  siteEnergyAssets,
  transformers,
} from '../schema/load-management.js';
import {
  changedFields,
  LoadTreeValidationError,
  writeTreeAudit,
  type LoadTreeWriteContext,
} from './load-management-tree.js';

export type EnergyAssetRow = typeof siteEnergyAssets.$inferSelect;
export type EnergyAssetValues = typeof siteEnergyAssets.$inferInsert;
export type EnergyAssetChanges = Partial<Omit<EnergyAssetValues, 'id' | 'siteId' | 'createdAt'>>;
export type EnergyAssetReadingRow = typeof energyAssetReadings.$inferSelect;

/** Whether this process may store `simulated` telemetry (ENERGY_ASSETS_ALLOW_SIMULATED). */
export interface EnergyAssetWriteOptions {
  allowSimulated: boolean;
}

type AssetShape = Pick<
  EnergyAssetValues,
  | 'type'
  | 'capacityKwh'
  | 'peakKwp'
  | 'maxDischargeKw'
  | 'maxChargeKw'
  | 'inverterKw'
  | 'phases'
  | 'gridCharging'
  | 'telemetry'
  | 'connectionTransformerId'
  | 'connectionPanelId'
>;

/**
 * Refuses what the CHECKs would refuse with a field the caller can show, a
 * connection point that is not of the site, and simulated telemetry where
 * the process does not allow it. `checkConnection` reads the connection
 * point (skipped when neither it nor the asset's phases changed).
 *
 * A three-phase asset needs a three-phase connection point: on a
 * single-phase panel or transformer its power flows on that point's phases
 * only, so the per-phase credit the cycle gives a three-phase asset above it
 * would raise phases it does not feed. A connected battery that may charge
 * from the grid needs `maxChargeKw` or `inverterKw`: without data it counts
 * as a load at that rating (owner decision D9), and without one there is no
 * bound to count. An unconnected asset counts nowhere, so this does not
 * apply to it (the informational rows the 0.1.50 migration moved from the
 * layout have no connection).
 */
async function assertAssetShape(
  siteId: string,
  asset: AssetShape,
  options: EnergyAssetWriteOptions,
  checkConnection: boolean,
): Promise<void> {
  if (asset.telemetry === 'simulated' && !options.allowSimulated) {
    throw new LoadTreeValidationError(
      'Simulated readings are not allowed on this installation',
      'telemetry',
    );
  }
  if (asset.type === 'battery' && asset.peakKwp != null) {
    throw new LoadTreeValidationError('A battery has no peak power in kWp', 'peakKwp');
  }
  if (asset.type === 'solar') {
    for (const field of ['capacityKwh', 'maxDischargeKw', 'maxChargeKw'] as const) {
      if (asset[field] != null) {
        throw new LoadTreeValidationError(`Solar has no ${field}`, field);
      }
    }
  }
  const transformerId = asset.connectionTransformerId ?? null;
  const panelId = asset.connectionPanelId ?? null;
  if (transformerId != null && panelId != null) {
    throw new LoadTreeValidationError(
      'An energy asset connects at a transformer or a panel, not both',
      'connectionPanelId',
    );
  }
  const connected = transformerId != null || panelId != null;
  if (
    connected &&
    asset.type === 'battery' &&
    (asset.gridCharging ?? 'possible') === 'possible' &&
    asset.maxChargeKw == null &&
    asset.inverterKw == null
  ) {
    throw new LoadTreeValidationError(
      'A connected battery that may charge from the grid needs a maximum charge power or an inverter rating',
      'maxChargeKw',
    );
  }
  if (!checkConnection) return;
  const threePhase = (asset.phases ?? 3) === 3;
  const singlePhasePoint = (): LoadTreeValidationError =>
    new LoadTreeValidationError(
      'A three-phase energy asset connects only at a three-phase panel or transformer',
      'phases',
    );
  if (transformerId != null) {
    const [row] = await db
      .select({ id: transformers.id, phases: transformers.phases })
      .from(transformers)
      .where(and(eq(transformers.id, transformerId), eq(transformers.siteId, siteId)));
    if (row == null) {
      throw new LoadTreeValidationError(
        'Transformer not found on this site',
        'connectionTransformerId',
      );
    }
    if (threePhase && row.phases !== 3) throw singlePhasePoint();
  }
  if (panelId != null) {
    const [row] = await db
      .select({ id: panels.id, phases: panels.phases })
      .from(panels)
      .where(and(eq(panels.id, panelId), eq(panels.siteId, siteId)));
    if (row == null) {
      throw new LoadTreeValidationError('Panel not found on this site', 'connectionPanelId');
    }
    if (threePhase && row.phases !== 3) throw singlePhasePoint();
  }
}

/**
 * Inserts a battery or solar asset of `values.siteId`. Solar never charges
 * from the grid, so it stores `grid_charging = 'never'` unless given. Returns
 * the new row, or null when none was written (`ifMissing` and the id
 * exists): then nothing is audited.
 */
export async function createEnergyAsset(
  values: EnergyAssetValues,
  ctx: LoadTreeWriteContext,
  options: EnergyAssetWriteOptions & { ifMissing?: boolean },
): Promise<EnergyAssetRow | null> {
  await assertAssetShape(values.siteId, values, options, true);
  const insert = db.insert(siteEnergyAssets).values({
    ...values,
    gridCharging: values.gridCharging ?? (values.type === 'solar' ? 'never' : 'possible'),
  });
  const rows =
    options.ifMissing === true
      ? await insert.onConflictDoNothing({ target: siteEnergyAssets.id }).returning()
      : await insert.returning();
  const created = rows[0];
  if (created == null) return null;
  await writeTreeAudit(created.siteId, ctx, {
    before: null,
    after: { energyAsset: created },
    notes: `energy asset created: ${created.name}`,
  });
  return created;
}

/**
 * Updates an energy asset of the site. `existing` is the row the caller read
 * (read here when absent); `onlyIf` narrows the update to a row still in a
 * given state. Returns the updated row, or null when no row changed (nothing
 * audited).
 */
export async function updateEnergyAsset(
  input: {
    siteId: string;
    assetId: string;
    existing?: EnergyAssetRow;
    set: EnergyAssetChanges;
    onlyIf?: SQL | undefined;
  },
  ctx: LoadTreeWriteContext,
  options: EnergyAssetWriteOptions,
): Promise<EnergyAssetRow | null> {
  const { siteId, assetId } = input;
  let existing = input.existing;
  if (existing == null) {
    [existing] = await db
      .select()
      .from(siteEnergyAssets)
      .where(and(eq(siteEnergyAssets.id, assetId), eq(siteEnergyAssets.siteId, siteId)));
    if (existing == null) return null;
  }

  const merged = { ...existing, ...input.set };
  const connectionChanged =
    (merged.connectionTransformerId ?? null) !== existing.connectionTransformerId ||
    (merged.connectionPanelId ?? null) !== existing.connectionPanelId;
  const phasesChanged = merged.phases !== existing.phases;
  // Existing simulated telemetry stays while the process does not allow it:
  // the read side ignores it, and an edit of the name must not fail.
  const telemetryChanged = merged.telemetry !== existing.telemetry;
  await assertAssetShape(
    siteId,
    merged,
    { allowSimulated: options.allowSimulated || !telemetryChanged },
    connectionChanged || phasesChanged,
  );

  const rows = await db
    .update(siteEnergyAssets)
    .set({ ...input.set, updatedAt: input.set.updatedAt ?? new Date() })
    .where(
      input.onlyIf == null
        ? eq(siteEnergyAssets.id, assetId)
        : and(eq(siteEnergyAssets.id, assetId), input.onlyIf),
    )
    .returning();
  const updated = rows[0];
  if (updated == null) return null;

  const change = changedFields(existing, updated);
  await writeTreeAudit(siteId, ctx, {
    before: { energyAssetId: assetId, ...change.before },
    after: { energyAssetId: assetId, ...change.after },
    notes:
      updated.telemetry !== existing.telemetry
        ? `energy asset updated: ${updated.name} (telemetry ${existing.telemetry} to ${updated.telemetry})`
        : `energy asset updated: ${updated.name}`,
  });
  return updated;
}

/**
 * Deletes an energy asset of the site (the database cascades its reading).
 * `asset` is the row the caller read; it is stored as the audit `before`.
 */
export async function deleteEnergyAsset(
  input: { siteId: string; asset: EnergyAssetRow },
  ctx: LoadTreeWriteContext,
): Promise<void> {
  const { siteId, asset } = input;
  await db.delete(siteEnergyAssets).where(eq(siteEnergyAssets.id, asset.id));
  await writeTreeAudit(siteId, ctx, {
    before: { energyAsset: asset },
    after: null,
    notes: `energy asset deleted: ${asset.name}`,
  });
}

export interface EnergyAssetReadingInput {
  assetId: string;
  reportedAt: Date;
  /**
   * When the CSMS received it; now when absent. A `reportedAt` after it is
   * stored as it, so a future-dated reading cannot hold off later ones.
   */
  receivedAt?: Date;
  powerKw: number;
  availableKw: number | null;
  socPercent: number | null;
  source: EnergyAssetReadingRow['source'];
  /** The API key that sent it; null for a session or the simulation. */
  apiKeyId: string | null;
}

/**
 * Stores the latest reading of an asset: one row per asset, replaced only by
 * a reading reported at the same time or later, so a delayed older one never
 * replaces a newer one. `reported_at` is clamped to the receive time: a reading
 * dated in the future (the route allows 30 s of clock skew) is stored as
 * measured when it arrived, so an honest reading sent after it still replaces
 * it (security case 333). No audit row. Returns whether the reading was stored
 * (false: a newer one is stored).
 */
export async function recordEnergyAssetReading(input: EnergyAssetReadingInput): Promise<boolean> {
  const receivedAt = input.receivedAt ?? new Date();
  const reportedAt =
    input.reportedAt.getTime() > receivedAt.getTime() ? receivedAt : input.reportedAt;
  const values = {
    assetId: input.assetId,
    reportedAt,
    receivedAt,
    powerKw: String(input.powerKw),
    availableKw: input.availableKw == null ? null : String(input.availableKw),
    socPercent: input.socPercent == null ? null : String(input.socPercent),
    source: input.source,
    apiKeyId: input.apiKeyId,
  };
  const rows = await db
    .insert(energyAssetReadings)
    .values(values)
    .onConflictDoUpdate({
      target: energyAssetReadings.assetId,
      set: {
        reportedAt: sql`excluded.reported_at`,
        receivedAt: sql`excluded.received_at`,
        powerKw: sql`excluded.power_kw`,
        availableKw: sql`excluded.available_kw`,
        socPercent: sql`excluded.soc_percent`,
        source: sql`excluded.source`,
        apiKeyId: sql`excluded.api_key_id`,
      },
      setWhere: sql`excluded.reported_at >= ${energyAssetReadings.reportedAt}`,
    })
    .returning({ assetId: energyAssetReadings.assetId });
  return rows.length > 0;
}
