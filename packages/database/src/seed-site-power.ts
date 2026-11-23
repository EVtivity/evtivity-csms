// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The power equipment of every demo site outside the site layout demo (the
// base seed's sites, such as Airport Terminal with its 82 to 127 stations):
// a load management tree sized to the stations' connected load and as many
// transformers on the layout as the tree has groups (seed-site-power-plan.ts,
// owner decision 2026-11-01). The site layout demo sites keep their own plan
// (seed-demo-layout-plan.ts).
//
// Rerun-safe and guarded (P7): a site gets the tree only while it has no
// panels or still has the single panel with two circuits the base seed wrote
// before this plan (`isEarlierBaseTree`, deleted first through the tree
// writer); the layout settings and positions only while it has none stored.
// Every row goes through the one writer of its table (the load management
// tree writer, saveSiteLayout) and is audited; a station's circuit is set
// only while it has none.

import type postgres from 'postgres';
import {
  effectiveLayoutSettings,
  freeSlotsFor,
  layoutStationCountsOfKinds,
  layoutStationKind,
  lotExtentM,
  positionToBay,
  spotCenterM,
  TRANSFORMER_CLEARANCE_M,
  type LayoutPoint,
  type LayoutStationKind,
  type LayoutTransformer,
} from '@evtivity/lib/site-layout';
import { db } from './config.js';
import { writeAudit } from './lib/audit.js';
import { siteAuditLog, stationAuditLog } from './schema/audit.js';
import {
  createCircuit,
  createPanel,
  createTransformer,
  deletePanel,
  updatePanel,
} from './lib/load-management-tree.js';
import { layoutEquipmentRowId } from './lib/layout-equipment-id.js';
import type { PanelRow } from './lib/load-management-tree.js';
import { panels, transformers } from './schema/load-management.js';
import { and, eq, isNull } from 'drizzle-orm';
import {
  readSiteLayoutPositions,
  readStoredLayoutSettings,
  saveSiteLayout,
} from './lib/station-layout.js';
import { LAYOUT_DEMO } from './seed-demo-layout-plan.js';
import {
  MAX_OVERSUBSCRIPTION_RATIO,
  panelOversubscription,
  V208,
  V480,
  groupTransformerPoints,
  planSitePower,
  type PlannedGroup,
  type PowerStation,
} from './seed-site-power-plan.js';
import type { DemoFeatureContext } from './seed-demo-features.js';

/** The names, panel ratings and circuits the base seed wrote before this plan. */
const EARLIER_PANEL_NAME = /^Main Panel [A-H]$/;
const EARLIER_PANEL_AMPS = new Set([100, 150, 200]);
const EARLIER_CIRCUITS: ReadonlyArray<{ name: string; amps: number }> = [
  { name: 'Circuit 1', amps: 40 },
  { name: 'Circuit 2', amps: 50 },
];

/** Whether a site's tree is still the one panel and two circuits the earlier base seed wrote. */
export function isEarlierBaseTree(
  sitePanels: ReadonlyArray<{
    name: string;
    breakerRatingAmps: number;
    voltageV: number;
    parentPanelId: string | null;
  }>,
  siteCircuits: ReadonlyArray<{ name: string; breakerRatingAmps: number }>,
): boolean {
  const [panel] = sitePanels;
  if (sitePanels.length !== 1 || panel == null) return false;
  if (!EARLIER_PANEL_NAME.test(panel.name) || panel.parentPanelId != null) return false;
  if (!EARLIER_PANEL_AMPS.has(panel.breakerRatingAmps) || panel.voltageV !== 240) return false;
  return (
    siteCircuits.length <= EARLIER_CIRCUITS.length &&
    siteCircuits.every((c) =>
      EARLIER_CIRCUITS.some((e) => e.name === c.name && e.amps === c.breakerRatingAmps),
    )
  );
}

interface StationRow {
  id: string;
  station_id: string;
  model: string | null;
  evse_id: string | null;
  connector_type: string | null;
  max_power_kw: string | null;
  max_current_amps: number | null;
}

/** A station's kind and connected load data from its in-service connectors. */
function powerStationOf(
  id: string,
  rows: readonly StationRow[],
): { kind: LayoutStationKind; station: Omit<PowerStation, 'spot'> } {
  const evseIds = new Set(rows.flatMap((r) => (r.evse_id != null ? [r.evse_id] : [])));
  const connectorRows = rows.filter((r) => r.evse_id != null);
  const kind = layoutStationKind(
    connectorRows.map((r) => ({ connectorType: r.connector_type, maxPowerKw: r.max_power_kw })),
    Math.max(1, evseIds.size),
  );
  const kw = Math.max(0, ...connectorRows.map((r) => Number(r.max_power_kw ?? 0)));
  // A port's current: the connector's rated current at 208 V, else its power at 208 V.
  const portAmps = Math.max(
    1,
    ...connectorRows.map((r) =>
      r.max_current_amps != null && r.max_current_amps > 0
        ? r.max_current_amps
        : Math.ceil((Number(r.max_power_kw ?? 0) * 1000) / 208),
    ),
  );
  // The circuit assignment check's nameplate: the highest connector of each
  // EVSE, summed; an EVSE without a rating makes the station count 0.
  const evseMax = new Map<string, number | null>();
  for (const r of connectorRows) {
    const rating = Number(r.max_power_kw ?? 0) > 0 ? Number(r.max_power_kw) : null;
    const current = evseMax.get(r.evse_id as string);
    if (current === undefined || (rating != null && (current == null || rating > current))) {
      evseMax.set(r.evse_id as string, rating ?? current ?? null);
    }
  }
  const ratings = [...evseMax.values()];
  const nameplateKw = ratings.some((v) => v == null)
    ? 0
    : ratings.reduce<number>((n, v) => n + (v ?? 0), 0);
  return {
    kind,
    station: {
      id,
      kind: kind.charging,
      model: rows[0]?.model ?? null,
      kw: kw > 0 ? kw : 50,
      ports: Math.max(1, evseIds.size),
      portAmps,
      nameplateKw,
    },
  };
}

const auditActor = (ctx: DemoFeatureContext) =>
  ctx.actorUserId != null
    ? { actor: 'operator' as const, actorUserId: ctx.actorUserId }
    : { actor: 'system' as const, actorLabel: 'seed' };

/** Panel and circuit ids of a site's plan, fixed so a rerun finds them. */
function ids(siteId: string) {
  const site = siteId.replace(/[^A-Za-z0-9]/g, '').slice(-16);
  return {
    switchboard: (g: number) => `pnl_pw${site}g${String(g + 1)}`,
    panelboard: (g: number, k: number) => `pnl_pw${site}g${String(g + 1)}p${String(k + 1)}`,
    circuit: (stationId: string) => `cir_pw${stationId.replace(/[^A-Za-z0-9]/g, '').slice(-20)}`,
  };
}

/** The names the plan gives its switchboards and panelboards. */
const PLAN_PANEL_NAME = /^(Main Switchboard \d+|Panelboard \d+[A-Z])$/;

/**
 * Every panel of the plan an earlier seed left without oversubscription (its
 * plan id and name, ratio 1) takes the ratio the circuit assignment check needs
 * for the stations now on its own circuits against its stored capacity
 * (`panelOversubscription`, at most 3). An operator's ratio or renamed panel
 * stays; the tree writer audits the one change.
 */
async function raiseTreeOversubscription(
  sql: postgres.Sql,
  siteId: string,
  ctx: DemoFeatureContext,
): Promise<void> {
  const prefix = ids(siteId).switchboard(0).replace(/g1$/, 'g');
  const candidates = await sql<Array<{ id: string; name: string; cap: string }>>`
    SELECT id, name, max_continuous_kw::text AS cap FROM panels
    WHERE site_id = ${siteId} AND starts_with(id, ${prefix}) AND oversubscription_ratio = 1
  `;
  for (const panel of candidates) {
    if (!PLAN_PANEL_NAME.test(panel.name)) continue;
    // The check's nameplate: the highest connector of each EVSE, an EVSE without a rating 0.
    const rows = await sql<Array<{ kw: string | null }>>`
      SELECT max(c.max_power_kw)::text AS kw
      FROM circuits ci
      JOIN charging_stations cs ON cs.circuit_id = ci.id AND cs.site_id = ${siteId}
        AND NOT cs.is_conformance
      JOIN evses e ON e.station_id = cs.id
      JOIN connectors c ON c.evse_id = e.id
      WHERE ci.panel_id = ${panel.id}
      GROUP BY e.id
    `;
    const nameplateKw = rows.reduce((n, r) => n + Number(r.kw ?? 0), 0);
    const { ratio } = panelOversubscription(
      [
        {
          stationId: '',
          breakerAmps: 0,
          maxContinuousKw: 0,
          loadKw: 0,
          phaseConnections: null,
          nameplateKw,
        },
      ],
      Number(panel.cap),
    );
    if (ratio <= 1) continue;
    await updatePanel(
      {
        siteId,
        panelId: panel.id,
        set: { oversubscriptionRatio: String(ratio) },
        onlyIf: and(
          eq(panels.siteId, siteId),
          eq(panels.name, panel.name),
          eq(panels.oversubscriptionRatio, '1'),
        ),
      },
      {
        ...auditActor(ctx),
        notes: 'Demo site power equipment: panel oversubscription for its managed load',
      },
    );
  }
}

/** Writes a site's tree through the tree writer and hangs each station on its circuit. */
async function writeTree(
  sql: postgres.Sql,
  siteId: string,
  groups: readonly PlannedGroup[],
  stationIds: ReadonlyMap<string, string>,
  ctx: DemoFeatureContext,
): Promise<{ panels: number; circuits: number }> {
  const treeCtx = { ...auditActor(ctx), notes: 'Demo site power equipment' };
  const id = ids(siteId);
  let panelCount = 0;
  let circuitCount = 0;
  const assign = async (circuitId: string, stationUuid: string): Promise<void> => {
    const rows = await sql<Array<{ id: string }>>`
      UPDATE charging_stations SET circuit_id = ${circuitId}, updated_at = now()
      WHERE id = ${stationUuid} AND site_id = ${siteId} AND circuit_id IS NULL
      RETURNING id
    `;
    if (rows.length === 0) return;
    await writeAudit(
      { table: stationAuditLog, idColumn: 'station_id' },
      {
        entityId: stationUuid,
        entityIdSnapshot: stationIds.get(stationUuid) ?? stationUuid,
        action: 'updated',
        ...auditActor(ctx),
        before: { circuitId: null },
        after: { circuitId },
        notes: 'Demo site power equipment: on its own circuit',
      },
    );
  };
  for (const [g, group] of groups.entries()) {
    const switchboardId = id.switchboard(g);
    if (
      await createPanel(
        {
          id: switchboardId,
          siteId,
          parentPanelId: null,
          name: `Main Switchboard ${String(g + 1)}`,
          breakerRatingAmps: group.switchboardAmps,
          voltageV: V480,
          phases: 3,
          maxContinuousKw: String(group.switchboardMaxContinuousKw),
          safetyMarginKw: '0',
          oversubscriptionRatio: String(group.switchboardOversubscription.ratio),
          sortOrder: g,
        },
        treeCtx,
        { ifMissing: true },
      )
    ) {
      panelCount++;
    }
    for (const [order, circuit] of group.dc.entries()) {
      const circuitId = id.circuit(circuit.stationId);
      if (
        await createCircuit(
          siteId,
          {
            id: circuitId,
            panelId: switchboardId,
            name: `Charger ${stationIds.get(circuit.stationId) ?? circuit.stationId}`,
            breakerRatingAmps: circuit.breakerAmps,
            maxContinuousKw: String(circuit.maxContinuousKw),
            phaseConnections: null,
            sortOrder: order,
          },
          treeCtx,
          { ifMissing: true },
        )
      ) {
        circuitCount++;
      }
      await assign(circuitId, circuit.stationId);
    }
    for (const [k, board] of group.panelboards.entries()) {
      const boardId = id.panelboard(g, k);
      if (
        await createPanel(
          {
            id: boardId,
            siteId,
            parentPanelId: switchboardId,
            name: `Panelboard ${String(g + 1)}${String.fromCharCode(65 + (k % 26))}`,
            breakerRatingAmps: board.amps,
            voltageV: V208,
            phases: 3,
            maxContinuousKw: String(board.maxContinuousKw),
            safetyMarginKw: '0',
            oversubscriptionRatio: String(board.oversubscription.ratio),
            sortOrder: group.dc.length + k,
          },
          treeCtx,
          { ifMissing: true },
        )
      ) {
        panelCount++;
      }
      for (const [order, circuit] of board.circuits.entries()) {
        const circuitId = id.circuit(circuit.stationId);
        if (
          await createCircuit(
            siteId,
            {
              id: circuitId,
              panelId: boardId,
              name: `Charger ${stationIds.get(circuit.stationId) ?? circuit.stationId}`,
              breakerRatingAmps: circuit.breakerAmps,
              maxContinuousKw: String(circuit.maxContinuousKw),
              phaseConnections: circuit.phaseConnections,
              sortOrder: order,
            },
            treeCtx,
            { ifMissing: true },
          )
        ) {
          circuitCount++;
        }
        await assign(circuitId, circuit.stationId);
      }
    }
  }
  return { panels: panelCount, circuits: circuitCount };
}

/** The service transformer row of group `g` (the id an earlier layout's `tx-<g+1>` moved to). */
const groupTransformerId = (siteId: string, g: number): string =>
  layoutEquipmentRowId('tfm', siteId, `tx-${String(g + 1)}`);

/**
 * The supply of a site's tree, while the tree is this plan's: one service
 * transformer per group (inserted while its id is free) linked to the
 * group's switchboard, and one step-down transformer per panelboard linked
 * to it, each link only while the panel has none and still hangs where the
 * plan put it. Through the tree writer, audited; a rerun writes nothing.
 */
async function writeSupply(
  siteId: string,
  groups: readonly PlannedGroup[],
  ctx: DemoFeatureContext,
  /** The layout about to be written places every group's transformer: insert them all (unlinked where the tree is not this plan's). */
  forLayout: boolean,
): Promise<void> {
  const treeCtx = { ...auditActor(ctx), notes: 'Demo site power equipment: transformer' };
  const id = ids(siteId);
  const sitePanels = await db.select().from(panels).where(eq(panels.siteId, siteId));
  const panelById = new Map(sitePanels.map((p) => [p.id, p]));
  const siteTransformers = await db
    .select()
    .from(transformers)
    .where(eq(transformers.siteId, siteId));
  const transformerById = new Map(siteTransformers.map((t) => [t.id, t]));
  const link = async (
    panelId: string,
    parentPanelId: string | null,
    transformerId: string,
    kind: 'service' | 'step_down',
  ): Promise<void> => {
    const panel = panelById.get(panelId);
    const transformer = transformerById.get(transformerId);
    if (panel == null || panel.transformerId != null || panel.parentPanelId !== parentPanelId) {
      return;
    }
    if (transformer?.kind !== kind || transformer.ratedKva == null) return;
    if (kind === 'step_down' && transformer.fedFromPanelId !== parentPanelId) return;
    await updatePanel(
      {
        siteId,
        panelId,
        existing: panel,
        set: { transformerId },
        onlyIf: and(
          isNull(panels.transformerId),
          parentPanelId == null
            ? isNull(panels.parentPanelId)
            : eq(panels.parentPanelId, parentPanelId),
        ),
      },
      treeCtx,
    );
  };
  for (const [g, group] of groups.entries()) {
    const switchboardId = id.switchboard(g);
    const ours = panelById.has(switchboardId);
    if (!ours && !forLayout) continue;
    const txId = groupTransformerId(siteId, g);
    const created = await createTransformer(
      {
        id: txId,
        siteId,
        kind: 'service',
        name: groups.length > 1 ? `Utility Transformer ${String(g + 1)}` : 'Utility Transformer',
        ratedKva: String(group.transformerKva),
        sortOrder: g,
      },
      treeCtx,
      { ifMissing: true },
    );
    if (created != null) transformerById.set(created.id, created);
    if (!ours) continue;
    await link(switchboardId, null, txId, 'service');
    for (const [k, board] of group.panelboards.entries()) {
      const boardId = id.panelboard(g, k);
      const panel = panelById.get(boardId);
      if (panel == null || panel.parentPanelId !== switchboardId || panel.transformerId != null) {
        continue;
      }
      const sdId = layoutEquipmentRowId('tfm', siteId, `sd-${boardId}`);
      const sd = await createTransformer(
        {
          id: sdId,
          siteId,
          kind: 'step_down',
          name: `Step-Down Transformer ${String(g + 1)}${String.fromCharCode(65 + (k % 26))}`,
          ratedKva: String(board.stepDownKva),
          phases: 3,
          secondaryVoltageV: V208,
          fedFromPanelId: switchboardId,
          sortOrder: groups.length + k,
        },
        treeCtx,
        { ifMissing: true },
      );
      if (sd != null) transformerById.set(sd.id, sd);
      await link(boardId, switchboardId, sdId, 'step_down');
    }
  }
}

export interface SitePowerSummary {
  siteId: string;
  name: string;
  stations: number;
  loadKw: number;
  transformersKva: number[];
  switchboards: number;
  panelboards: number;
  treeWritten: boolean;
  layoutWritten: boolean;
  /** Panels whose stations need more oversubscription than the panel routes allow (kept at 3). */
  panelsAboveMaxRatio: number;
}

/**
 * Sizes and writes the power equipment of every site with operator stations
 * outside the site layout demo. Returns one summary per site it planned.
 */
export async function seedSitePower(
  sql: postgres.Sql,
  ctx: DemoFeatureContext,
): Promise<SitePowerSummary[]> {
  const demoSites = LAYOUT_DEMO.sites.map((s) => s.id);
  const sites = await sql<Array<{ id: string; name: string }>>`
    SELECT s.id, s.name FROM sites s
    WHERE s.id <> ALL(${demoSites})
      AND EXISTS (
        SELECT 1 FROM charging_stations cs
        WHERE cs.site_id = s.id AND NOT cs.is_conformance
      )
    ORDER BY s.created_at, s.id
  `;
  const out: SitePowerSummary[] = [];
  for (const site of sites) {
    const rows = await sql<StationRow[]>`
      SELECT cs.id, cs.station_id, cs.model, e.id AS evse_id, c.connector_type,
        c.max_power_kw::text AS max_power_kw, c.max_current_amps
      FROM charging_stations cs
      LEFT JOIN evses e ON e.station_id = cs.id AND e.retired_at IS NULL
      LEFT JOIN connectors c ON c.evse_id = e.id AND c.retired_at IS NULL
      WHERE cs.site_id = ${site.id} AND NOT cs.is_conformance
      ORDER BY cs.created_at, cs.id, e.evse_id, c.connector_id
    `;
    const order: string[] = [];
    const byStation = new Map<string, StationRow[]>();
    const stationIds = new Map<string, string>();
    for (const r of rows) {
      if (!byStation.has(r.id)) order.push(r.id);
      byStation.set(r.id, [...(byStation.get(r.id) ?? []), r]);
      stationIds.set(r.id, r.station_id);
    }
    const parsed = order.map((id) => powerStationOf(id, byStation.get(id) ?? []));

    // The spots: stored positions, else the slots automatic placement gives
    // them (the API's order, `freeSlotsFor`), on the stored or default lot.
    const stored = await readStoredLayoutSettings(site.id);
    const storedPositions = await readSiteLayoutPositions(site.id);
    const counts = layoutStationCountsOfKinds(parsed.map((p) => p.kind));
    const settings = effectiveLayoutSettings(
      stored,
      storedPositions.map((p) => positionToBay({ x: p.positionX, y: p.positionY })),
      counts,
    );
    const storedAt = new Map(
      storedPositions.map((p) => [p.stationId, { x: p.positionX, y: p.positionY }]),
    );
    const unplaced = order.filter((id) => !storedAt.has(id));
    const slots = freeSlotsFor(
      unplaced.map((id) => parsed[order.indexOf(id)]?.kind),
      storedPositions.map((p) => ({ x: p.positionX, y: p.positionY })),
      settings,
    );
    const positionOf = new Map<string, LayoutPoint>(storedAt);
    unplaced.forEach((id, i) => {
      const slot = slots[i];
      if (slot != null) positionOf.set(id, slot);
    });
    const spots = new Map(
      order.map((id) => [
        id,
        spotCenterM(positionToBay(positionOf.get(id) ?? { x: 20, y: 20 }), settings),
      ]),
    );
    const groups = planSitePower(
      parsed.map((p) => ({ ...p.station, spot: spots.get(p.station.id) ?? { x: 0, z: 0 } })),
    );

    // The tree, while the site has none or still has the earlier base seed's.
    const sitePanels = await db.select().from(panels).where(eq(panels.siteId, site.id));
    const siteCircuits =
      sitePanels.length === 1 && sitePanels[0] != null
        ? await sql<Array<{ name: string; breaker_rating_amps: number }>>`
            SELECT name, breaker_rating_amps FROM circuits WHERE panel_id = ${sitePanels[0].id}
          `
        : [];
    let treeWritten = false;
    const earlier = isEarlierBaseTree(
      sitePanels,
      siteCircuits.map((c) => ({ name: c.name, breakerRatingAmps: c.breaker_rating_amps })),
    );
    if (sitePanels.length === 0 || earlier) {
      if (earlier) {
        await deletePanel(
          { siteId: site.id, panel: sitePanels[0] as PanelRow },
          { ...auditActor(ctx), notes: 'Demo site power equipment: earlier seed panel replaced' },
        );
      }
      await sql`
        INSERT INTO site_load_management (site_id, strategy, is_enabled)
        VALUES (${site.id}, 'equal_share', false)
        ON CONFLICT (site_id) DO NOTHING
      `;
      await writeTree(sql, site.id, groups, stationIds, ctx);
      treeWritten = true;
    }
    await raiseTreeOversubscription(sql, site.id, ctx);
    // The transformers and their links, while the tree is this plan's (and
    // the transformers the layout below places).
    const writesLayout =
      stored == null && storedPositions.length === 0 && settings.siteType === 'parking_lot';
    await writeSupply(site.id, groups, ctx, writesLayout);

    // The layout: one transformer per group next to its stations, while the
    // site has no stored settings or positions.
    let layoutWritten = false;
    if (writesLayout) {
      const lot = lotExtentM(settings);
      const points = groupTransformerPoints(groups, spots, lot, TRANSFORMER_CLEARANCE_M);
      // Each group's service transformer row (`writeSupply`) at its position, by id.
      const layoutTransformers: LayoutTransformer[] = groups.map((_g, i) => ({
        id: groupTransformerId(site.id, i),
        x: points[i]?.x ?? lot.width + TRANSFORMER_CLEARANCE_M,
        z: points[i]?.z ?? 0,
      }));
      const positions = order.map((id) => {
        const p = positionOf.get(id) ?? { x: 20, y: 20 };
        return { stationId: id, positionX: p.x, positionY: p.y };
      });
      const saved = await db.transaction((tx) =>
        saveSiteLayout(tx, site.id, positions, {
          ...settings,
          transformers: layoutTransformers,
          energyAssets: [],
        }),
      );
      await writeAudit(
        { table: siteAuditLog, idColumn: 'site_id' },
        {
          entityId: site.id,
          entityIdSnapshot: site.id,
          action: 'updated',
          ...auditActor(ctx),
          before: { layoutSettings: null },
          after: { layoutPositions: positions, layoutSettings: saved.settingsAfter },
          notes: 'Demo site power equipment: one transformer per group of stations',
        },
      );
      layoutWritten = true;
    }
    out.push({
      siteId: site.id,
      name: site.name,
      stations: order.length,
      loadKw: Math.round(groups.reduce((n, g) => n + g.loadKw, 0)),
      transformersKva: groups.map((g) => g.transformerKva),
      switchboards: groups.length,
      panelboards: groups.reduce((n, g) => n + g.panelboards.length, 0),
      treeWritten,
      layoutWritten,
      panelsAboveMaxRatio: groups.reduce(
        (n, g) =>
          n +
          (g.switchboardOversubscription.needed > MAX_OVERSUBSCRIPTION_RATIO ? 1 : 0) +
          g.panelboards.filter((b) => b.oversubscription.needed > MAX_OVERSUBSCRIPTION_RATIO)
            .length,
        0,
      ),
    });
  }
  return out;
}
