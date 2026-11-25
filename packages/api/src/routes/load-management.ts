// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, inArray, isNotNull } from 'drizzle-orm';
import {
  db,
  siteLoadManagement,
  chargingStations,
  connectors,
  evses,
  loadAllocationLog,
  loadAllocationEntries,
  isOperatorStation,
  isFleetChargingEnabled,
  isFleetEnabled,
  markSitePlanStale,
  client,
  clearEvseLimitsRefused,
  toIsoOrNull,
  circuits as circuitsTable,
  panels as panelsTable,
} from '@evtivity/database';
import { effectiveBalancingMode } from '@evtivity/services/evse-limits';
import { LOAD_ALLOCATION_STRATEGIES } from '@evtivity/lib';
import { zodSchema } from '../lib/zod-schema.js';
import { config as apiConfig } from '../lib/config.js';
import { itemResponse, arrayResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { computeSiteAllocation } from '@evtivity/services/load-management-site-allocation';
import { nodeCapacityKw } from '@evtivity/services/load-management-phases';
import { clearLoadManagementProfiles } from '@evtivity/services/load-management-send';
import { clearPlanProfilesOnDisable } from '@evtivity/services/load-management-plan-bridge';
import {
  entriesAfterConfigSave,
  parseAppliedAllocations,
} from '@evtivity/services/load-limit-entries';
import { stationConnectedKw } from '@evtivity/services/load-management-site-status';
import { type HierarchyNode } from '@evtivity/services/load-management-model';
import { getUserSiteIds, isAllSiteUser } from '../lib/site-access.js';
import { sitePlanItem, siteChargingPlanView } from '../lib/charging-plan-view.js';
import { authorize, requestHasPermission } from '../middleware/rbac.js';
import { recomputeSiteAfterWrite, replanSiteAfterWrite } from '../lib/site-plan-stale.js';
import { siteInScope } from '../lib/site-scope.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { changedFields } from '../lib/audit-diff.js';
import {
  writeSiteLoadManagementAudit,
  writeStationLoadAudit,
} from '../lib/load-management-audit.js';

/**
 * The stored plan entries name a departure, a vehicle and a session: they
 * follow the departure read rule, and the session also needs sessions:read.
 */
function planEntriesForReader(
  plan: unknown,
  access: { fleetIds: boolean; sessionIds: boolean },
): unknown {
  if (!Array.isArray(plan)) return plan ?? null;
  return plan.map((entry: unknown) => {
    if (entry == null || typeof entry !== 'object') return entry;
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>).filter(([key]) =>
        key === 'departureId' || key === 'vehicleId'
          ? access.fleetIds
          : key === 'sessionId'
            ? access.sessionIds
            : true,
      ),
    );
  });
}

const putBody = z.object({
  strategy: z
    .enum(LOAD_ALLOCATION_STRATEGIES)
    .describe(
      'Load distribution strategy. departure_aware plans charging by each fleet vehicle departure and needs the fleetCharging.enabled setting (400 FLEET_CHARGING_DISABLED while it is off)',
    ),
  isEnabled: z.boolean().describe('Whether load management is active for this site'),
  departureBufferMinutes: z
    .number()
    .int()
    .min(0)
    .max(180)
    .optional()
    .describe(
      'Minutes before a departure the depot plan aims to finish (0 to 180, default 30); omitted keeps the stored value',
    ),
});

const siteParams = z.object({ id: ID_PARAMS.siteId.describe('Site ID') });

const FLEET_CHARGING_DISABLED = {
  error: 'Fleet charging is turned off: turn on the fleetCharging.enabled setting first',
  code: 'FLEET_CHARGING_DISABLED',
} as const;

// The station is the CSMS station ID (sta_...), not the OCPP identifier: the pattern tells API
// clients and the AI assistant which one to send.
const siteStationParams = z.object({
  id: ID_PARAMS.siteId.describe('Site ID'),
  stationId: ID_PARAMS.stationId.describe('Station ID (not the OCPP station identifier)'),
});

const patchPriorityBody = z.object({
  loadPriority: z
    .number()
    .int()
    .min(1)
    .max(10)
    .describe('Load priority from 1 (lowest) to 10 (highest)'),
});

const patchMinPowerBody = z.object({
  loadMinPowerKw: z
    .number()
    .min(0)
    .max(1000)
    .nullable()
    .describe(
      'Lowest power in kW a charging session at this station gets before load management stops it; null for no minimum',
    ),
});

const patchBalancingModeBody = z.object({
  mode: z
    .enum(['station', 'evse'])
    .describe(
      'station: one limit for the whole station; evse: also a limit per charging EVSE (sessions with a tariff current limit are limited per EVSE in either mode). Setting it lets a station that refused per-EVSE limits take them again.',
    ),
});

const historyQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(50)
    .describe('Number of history entries to return, max 200'),
});

const hierarchyStationSchema = z
  .object({
    id: z.string().describe('Station database ID'),
    stationId: z.string().describe('Human-readable OCPP station ID'),
    currentDrawKw: z.number().describe('Current power draw in kW'),
    allocatedLimitKw: z.number().nullable().describe('Allocated power limit in kW'),
    maxPowerKw: z.number().describe('Maximum power capability in kW'),
    isOnline: z.boolean().describe('Whether the station is online'),
    hasActiveSession: z.boolean().describe('Whether the station has an active charging session'),
  })
  .loose();

const hierarchyCircuitSchema = z
  .object({
    id: z.string().describe('Circuit ID'),
    name: z.string().describe('Circuit name'),
    maxContinuousKw: z.number().describe('Maximum continuous power capacity in kW'),
    currentDrawKw: z.number().describe('Current power draw in kW'),
    availableKw: z.number().describe('Available power capacity in kW'),
    voltageV: z
      .number()
      .int()
      .nullable()
      .describe('Circuit voltage in volts; null uses the panel voltage'),
    phaseRotation: z
      .string()
      .nullable()
      .describe(
        'Wiring of the stations to the panel phases set by the operator (RST, RTS, SRT, STR, TRS, TSR); null uses the rotation the stations report',
      ),
    stations: z.array(hierarchyStationSchema).describe('Stations attached to this circuit'),
    unmanagedLoads: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Unmanaged loads on this circuit'),
  })
  .loose();

// Mirrors the shape annotateHierarchy() emits: panels carry `circuits` and
// `childPanels`, never `stations`/`children`. A mismatch here makes
// fast-json-stringify reject the response (500) for any site with panels.
// Route schemas are inlined JSON Schema without $ref, which cannot express
// recursion, so a sub-panel is an open object with the same fields.
const hierarchyNodeSchema = z
  .object({
    type: z
      .enum(['panel', 'circuit', 'transformer'])
      .describe(
        'Hierarchy node type: a transformer is a service transformer above the top-level panels that name it, or a step-down transformer between a panel and its sub-panels',
      ),
    id: z.string().describe('Node ID'),
    name: z.string().describe('Node name'),
    maxContinuousKw: z.number().describe('Maximum continuous power capacity in kW'),
    safetyMarginKw: z.number().describe('Safety margin reserved from capacity in kW'),
    unmanagedLoadKw: z.number().describe('Unmanaged load drawing from this node in kW'),
    currentDrawKw: z.number().describe('Current power draw in kW'),
    availableKw: z.number().describe('Available power capacity in kW'),
    utilization: z.number().describe('Utilization ratio (0 to 1)'),
    totalConnectedKw: z.number().describe('Sum of connected station capacity in kW'),
    phaseConnections: z
      .string()
      .nullable()
      .describe(
        'Phases of the three-phase parent panel that feed this single-phase sub-panel; null when unknown',
      ),
    circuits: z.array(hierarchyCircuitSchema).describe('Circuits on this panel'),
    childPanels: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Nested sub-panels, each with the fields of this node, its own childPanels included',
      ),
    unmanagedLoads: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Unmanaged loads on this panel'),
  })
  .loose();

const evseLimitItem = z
  .object({
    evseNumber: z.number().int().describe('OCPP EVSE number'),
    unitId: z.string().nullable().describe('Station unit of the EVSE, or null'),
    kind: z.enum(['ac', 'dc']).describe('Charging kind of the session'),
    limitA: z.number().nullable().describe('AC limit in A per phase (0.1 A steps); null for DC'),
    limitKw: z.number().describe('Limit in kW'),
    phases: z.number().int().nullable().describe('Phases the AC limit counts; null for DC'),
    reason: z
      .string()
      .describe('What set the limit: tariff_limit, connector_max, station_share or ac_min_pause'),
    paused: z.boolean().describe('True when the AC EVSE is paused at 0 A (below 6 A)'),
    phaseSwitchingSupported: z
      .boolean()
      .describe(
        'True when the EVSE reports SmartChargingCtrlr.ACPhaseSwitchingSupported true (OCPP 2.0.1 and 2.1 only): it can move a single-phase car to the phase load management names',
      ),
    phaseToUse: z
      .number()
      .int()
      .nullable()
      .describe(
        'The EVSE phase (1 to 3) the single-phase car is sent to charge on (phaseToUse of the TxProfile); null when none is sent',
      ),
    sessionId: z
      .string()
      .optional()
      .describe('Charging session of the EVSE; only with sessions:read'),
  })
  .loose();

const loadStationItem = z
  .object({
    id: z.string().describe('Station identifier'),
    stationId: z.string().describe('OCPP station ID'),
    currentDrawKw: z.number().describe('Current power draw in kW'),
    allocatedLimitKw: z
      .number()
      .nullable()
      .describe('Allocated power limit in kW (null when unmanaged)'),
    limitReserved: z
      .boolean()
      .describe(
        'True when allocatedLimitKw is power load management keeps for the station (offline with an active session, or its last limit not confirmed) as a fixed load, not a limit sent to it',
      ),
    loadPriority: z.number().describe('Load priority from 1 (lowest) to 10 (highest)'),
    loadMinPowerKw: z
      .number()
      .nullable()
      .describe('Minimum power in kW of a charging session, or null for none'),
    rateUnit: z
      .enum(['A', 'W'])
      .describe(
        'Unit of the limit sent to the station: A when it supports only A, or supports A on a circuit of two or three phases, else W',
      ),
    isOnline: z.boolean().describe('Whether the station is online'),
    hasActiveSession: z.boolean().describe('Whether a charging session is active'),
    balancingMode: z
      .enum(['station', 'evse'])
      .describe('The balancing mode the operator chose for the station'),
    effectiveBalancingMode: z
      .enum(['station', 'evse'])
      .describe(
        'How load management limits the station now: evse when the operator chose it or an AC session has a tariff current limit, station when the station refused per-EVSE limits',
      ),
    evseLimitsRefusedAt: z
      .string()
      .nullable()
      .describe(
        'When the station refused a per-EVSE limit (ISO 8601); it gets one station limit until the balancing mode is set again',
      ),
    evseLimits: z
      .array(evseLimitItem)
      .describe('The limit of each charging EVSE this cycle (empty in station mode)'),
    usesUnits: z
      .boolean()
      .describe(
        'True when the station groups its EVSEs in units, whose budgets GET /v1/sites/:id/stations/:stationId/unit-budgets lists',
      ),
    tariffLimitsNotEnforced: z
      .boolean()
      .optional()
      .describe(
        'True when an AC session at the station has a tariff current limit that load management does not enforce (load management off, or the station on no circuit). Only with pricing:read',
      ),
  })
  .loose();

const loadManagementItem = z
  .object({
    config: z
      .object({
        strategy: z.enum(LOAD_ALLOCATION_STRATEGIES).describe('Load distribution strategy'),
        isEnabled: z.boolean().describe('Whether load management is active'),
        departureBufferMinutes: z
          .number()
          .int()
          .describe('Minutes before a departure the depot plan aims to finish'),
      })
      .nullable()
      .describe('Site load management configuration, or null when not configured'),
    hierarchy: z
      .array(hierarchyNodeSchema)
      .describe('Electrical hierarchy of panels and circuits at the site'),
    stations: z.array(loadStationItem).describe('Stations and their current allocation state'),
    simulatedEnergyAssetsAllowed: z
      .boolean()
      .describe(
        'Whether this installation accepts simulated battery and solar readings (telemetry simulated, development and demos only)',
      ),
  })
  .loose();

const siteLoadManagementRecord = z
  .object({
    id: z.number().describe('Site load management config row ID'),
    siteId: z.string().describe('Site ID'),
    strategy: z.enum(LOAD_ALLOCATION_STRATEGIES).describe('Load distribution strategy'),
    isEnabled: z.boolean().describe('Whether load management is active for this site'),
    departureBufferMinutes: z
      .number()
      .int()
      .describe('Minutes before a departure the depot plan aims to finish'),
    createdAt: z.string().describe('Created timestamp (ISO 8601)'),
    updatedAt: z.string().describe('Updated timestamp (ISO 8601)'),
  })
  .loose();

const loadPriorityItem = z
  .object({
    id: z.string().describe('Station identifier'),
    stationId: z.string().describe('OCPP station ID'),
    loadPriority: z.number().describe('Load priority from 1 (lowest) to 10 (highest)'),
  })
  .loose();

const loadMinPowerItem = z
  .object({
    id: z.string().describe('Station identifier'),
    stationId: z.string().describe('OCPP station ID'),
    loadMinPowerKw: z
      .number()
      .nullable()
      .describe('Minimum power in kW of a charging session, or null for none'),
  })
  .loose();

const loadBalancingModeItem = z
  .object({
    id: z.string().describe('Station identifier'),
    stationId: z.string().describe('OCPP station ID'),
    loadBalancingMode: z.enum(['station', 'evse']).describe('The balancing mode now stored'),
    evseLimitsRefusedAt: z
      .string()
      .nullable()
      .describe('Always null after the change: the station takes per-EVSE limits again'),
  })
  .loose();

const historyItem = z
  .object({
    id: z.string().describe('Allocation log entry identifier'),
    siteLimitKw: z.number().describe('Site power limit at the time of allocation, in kW'),
    totalDrawKw: z.number().describe('Total measured power draw in kW'),
    availableKw: z.number().describe('Power capacity available for distribution in kW'),
    strategy: z
      .enum(LOAD_ALLOCATION_STRATEGIES)
      .describe('Strategy used for this allocation cycle'),
    allocations: z
      .array(
        z
          .object({
            stationId: z.string().describe('OCPP station identifier'),
            stationDbId: z.string().nullable().describe('Station database ID'),
            allocatedKw: z.number().describe('Station limit sent, in kW'),
          })
          .loose(),
      )
      .describe('The station limits of this allocation, from the allocation log entries'),
    createdAt: z.string().describe('Timestamp of the allocation cycle'),
  })
  .loose();

function toConfigRecord(
  row: typeof siteLoadManagement.$inferSelect | undefined,
): Record<string, unknown> | undefined {
  if (row == null) return undefined;
  return {
    id: row.id,
    siteId: row.siteId,
    strategy: row.strategy,
    isEnabled: row.isEnabled,
    departureBufferMinutes: row.departureBufferMinutes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type HierarchyStation = HierarchyNode['stations'][number];

function hierarchyStations(nodes: readonly HierarchyNode[]): HierarchyStation[] {
  return nodes.flatMap((node) => [...node.stations, ...hierarchyStations(node.children)]);
}

/** Connected kW of each station of the tree, its Station Units held to their budgets. */
async function connectedKwByStation(nodes: readonly HierarchyNode[]): Promise<Map<string, number>> {
  const stations = new Map(hierarchyStations(nodes).map((s) => [s.id, s]));
  const result = new Map<string, number>();
  if (stations.size === 0) return result;
  const rows = await db
    .select({
      stationId: evses.stationId,
      evseDbId: evses.id,
      unitId: evses.unitId,
      maxPowerKw: connectors.maxPowerKw,
    })
    .from(connectors)
    .innerJoin(evses, eq(connectors.evseId, evses.id))
    .where(inArray(evses.stationId, [...stations.keys()]));
  for (const [id, station] of stations) {
    const stationRows = rows.filter((r) => r.stationId === id);
    if (stationRows.length === 0) continue;
    result.set(
      id,
      stationConnectedKw(
        stationRows,
        station.unitBudgets ?? [],
        station.circuitVoltageV,
        station.circuitPhases ?? 1,
      ),
    );
  }
  return result;
}

/**
 * Annotate hierarchy nodes with computed availableKw and utilization.
 */
/** The operator phase rotation of each circuit of the site, by circuit id. */
async function circuitRotations(siteId: string): Promise<Map<string, string | null>> {
  const rows = await db
    .select({ id: circuitsTable.id, phaseRotation: circuitsTable.phaseRotation })
    .from(circuitsTable)
    .innerJoin(panelsTable, eq(panelsTable.id, circuitsTable.panelId))
    .where(eq(panelsTable.siteId, siteId));
  return new Map(rows.map((r) => [r.id, r.phaseRotation]));
}

function annotateHierarchy(
  nodes: HierarchyNode[],
  connectedKw: ReadonlyMap<string, number>,
  rotations: ReadonlyMap<string, string | null> = new Map(),
): unknown[] {
  return nodes.map((node) => {
    // currentDrawKw already holds the unmanaged loads of the node and of every
    // node below it, so they are not subtracted from the capacity again.
    // A battery or solar credit raises what the node can carry
    // (nodeCapacityKw, the allocation's rule).
    const effectiveCapacity = nodeCapacityKw(node);
    const availableKw = Math.max(0, effectiveCapacity - node.currentDrawKw);
    const utilization =
      effectiveCapacity > 0 ? Math.min(1, node.currentDrawKw / effectiveCapacity) : 0;

    // Separate children into circuits and child panels (or the step-down
    // transformers between a panel and its sub-panels) for the frontend
    const circuitChildren = node.children.filter((c) => c.type === 'circuit');
    const panelChildren = node.children.filter((c) => c.type !== 'circuit');

    let totalConnectedKw = 0;
    for (const child of node.children) {
      if (child.type === 'circuit') {
        for (const s of child.stations) {
          totalConnectedKw += connectedKw.get(s.id) ?? s.maxPowerKw;
        }
      }
    }

    return {
      type: node.type,
      id: node.id,
      name: node.name,
      maxContinuousKw: node.maxContinuousKw,
      safetyMarginKw: node.safetyMarginKw,
      unmanagedLoadKw: node.unmanagedLoadKw,
      currentDrawKw: node.currentDrawKw,
      availableKw,
      utilization,
      totalConnectedKw,
      phases: node.phases,
      breakerRatingAmps: node.breakerRatingAmps,
      voltageV: node.voltageV,
      oversubscriptionRatio: node.oversubscriptionRatio,
      phaseConnections: node.phaseConnections,
      phaseLoad: node.phaseLoad,
      perPhaseCapacityKw: node.perPhaseCapacityKw,
      ...(node.transformerKind != null ? { transformerKind: node.transformerKind } : {}),
      supplyCreditKw: node.supplyCreditKw ?? 0,
      supplyLoadKw: node.supplyLoadKw ?? 0,
      energyAssets: (node.energyAssets ?? []).map((asset) => ({
        id: asset.id,
        name: asset.name,
        type: asset.type,
        connection: asset.connection,
        supply: {
          state: asset.state,
          creditKw: asset.creditKw,
          loadKw: asset.loadKw,
          creditApplied: asset.creditApplied,
          readingReceivedAt: asset.readingReceivedAt?.toISOString() ?? null,
          socPercent: asset.socPercent,
        },
      })),
      circuits: circuitChildren.map((circuit) => {
        return {
          id: circuit.id,
          name: circuit.name,
          breakerRatingAmps: circuit.breakerRatingAmps,
          maxContinuousKw: circuit.maxContinuousKw,
          currentDrawKw: circuit.currentDrawKw,
          availableKw: Math.max(0, circuit.maxContinuousKw - circuit.currentDrawKw),
          phaseConnections: circuit.phaseConnections,
          voltageV: circuit.ownVoltageV ?? null,
          phaseRotation: rotations.get(circuit.id) ?? null,
          stations: circuit.stations.map((s) => ({
            id: s.id,
            stationId: s.stationId,
            currentDrawKw: s.currentDrawKw,
            allocatedLimitKw: null,
            maxPowerKw: s.maxPowerKw,
            isOnline: s.isOnline,
            hasActiveSession: s.hasActiveSession,
          })),
          unmanagedLoads: [],
        };
      }),
      childPanels: annotateHierarchy(panelChildren, connectedKw, rotations),
      unmanagedLoads: [],
    };
  });
}

const chargingPlanQuery = z.object({
  departureStatus: z
    .enum(['scheduled', 'cancelled'])
    .default('scheduled')
    .describe(
      'Which departures to list: scheduled (from 2 hours ago to the plan horizon, ad hoc always) or cancelled (the last 7 days to the horizon, with their cancel reason)',
    ),
});

export function loadManagementRoutes(app: FastifyInstance): void {
  // GET /sites/:id/load-management
  app.get(
    '/sites/:id/load-management',
    {
      onRequest: [authorize('loadManagement:read')],
      schema: {
        tags: ['Load Management'],
        summary: 'Get load management config, hierarchy, and station status for a site',
        operationId: 'getSiteLoadManagement',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(loadManagementItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const [config] = await db
        .select()
        .from(siteLoadManagement)
        .where(eq(siteLoadManagement.siteId, id));

      const strategy = config?.strategy ?? 'equal_share';
      // The same computation as the control loop, with the power it keeps
      // for offline stations, so the UI shows the limits the stations get.
      const { status, hierarchy, managed, reservedKw, allocations, evseLimits } =
        await computeSiteAllocation(
          id,
          strategy,
          parseAppliedAllocations(config?.appliedAllocations),
          { allowSimulatedEnergyAssets: apiConfig.ENERGY_ASSETS_ALLOW_SIMULATED },
        );

      // Compute current allocations for the UI
      let allocationMap = new Map<string, number>();
      const reservedIds = new Set<string>();
      if (config != null && config.isEnabled && hierarchy.length > 0) {
        allocationMap = new Map([
          ...reservedKw,
          ...allocations.map((a): [string, number] => [a.stationDbId, a.allocatedKw]),
        ]);
        const allocated = new Set(allocations.map((a) => a.stationDbId));
        for (const stationDbId of reservedKw.keys()) {
          if (!allocated.has(stationDbId)) reservedIds.add(stationDbId);
        }
      }

      const enabled = config != null && config.isEnabled && hierarchy.length > 0;
      const managedIds = new Set(enabled ? managed.map((s) => s.id) : []);
      const showSessions = await requestHasPermission(request, 'sessions:read');
      const showPricing = await requestHasPermission(request, 'pricing:read');
      return {
        config:
          config != null
            ? {
                strategy,
                isEnabled: config.isEnabled,
                departureBufferMinutes: config.departureBufferMinutes,
              }
            : null,
        hierarchy: annotateHierarchy(
          hierarchy,
          await connectedKwByStation(hierarchy),
          await circuitRotations(id),
        ),
        stations: status.stations.map((s) => ({
          id: s.id,
          stationId: s.stationId,
          currentDrawKw: s.currentDrawKw,
          maxPowerKw: s.maxPowerKw,
          allocatedLimitKw: allocationMap.get(s.id) ?? null,
          limitReserved: reservedIds.has(s.id),
          loadPriority: s.loadPriority,
          loadMinPowerKw: s.minPowerKw > 0 ? s.minPowerKw : null,
          rateUnit: s.rateUnit,
          isOnline: s.isOnline,
          hasActiveSession: s.hasActiveSession,
          balancingMode: s.balancingMode ?? 'station',
          effectiveBalancingMode: effectiveBalancingMode(s),
          evseLimitsRefusedAt: toIsoOrNull(s.evseLimitsRefusedAt ?? null),
          usesUnits: s.usesUnits === true,
          evseLimits: (enabled ? (evseLimits.get(s.id) ?? []) : []).map((l) => ({
            evseNumber: l.evseNumber,
            unitId: l.unitId,
            kind: l.kind,
            limitA: l.limitA,
            limitKw: l.limitKw,
            phases: l.phases,
            reason: l.reason,
            paused: l.paused,
            phaseSwitchingSupported:
              (s.sessions ?? []).find((x) => x.sessionId === l.sessionId)?.phaseSwitching === true,
            phaseToUse: l.phaseToUse ?? null,
            ...(showSessions ? { sessionId: l.sessionId } : {}),
          })),
          ...(showPricing
            ? {
                tariffLimitsNotEnforced:
                  !managedIds.has(s.id) &&
                  (s.sessions ?? []).some((x) => x.kind === 'ac' && x.tariffMaxCurrentA != null),
              }
            : {}),
        })),
        simulatedEnergyAssetsAllowed: apiConfig.ENERGY_ASSETS_ALLOW_SIMULATED,
      };
    },
  );

  // PUT /sites/:id/load-management
  app.put(
    '/sites/:id/load-management',
    {
      onRequest: [authorize('loadManagement:write')],
      onResponse: [replanSiteAfterWrite('load_management_changed', 'id')],
      schema: {
        tags: ['Load Management'],
        summary: 'Create or update load management config for a site',
        description:
          'Upserts the site-level load management config (strategy, isEnabled, departureBufferMinutes). Toggling isEnabled=true causes the 10-second control loop to start dispatching SetChargingProfile to stations on the next tick. Power limits live on panels and circuits, not on this row. Switching to departure_aware while the fleetCharging.enabled setting is off answers 400 FLEET_CHARGING_DISABLED; a site already on it keeps it.',
        operationId: 'upsertSiteLoadManagement',
        security: [{ bearerAuth: [] }],
        body: zodSchema(putBody),
        response: {
          200: itemResponse(siteLoadManagementRecord),
          201: itemResponse(siteLoadManagementRecord),
          400: errorWith('Validation error or fleet charging off', [
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.FLEET_CHARGING_DISABLED,
          ]),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as z.infer<typeof putBody>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const [existing] = await db
        .select()
        .from(siteLoadManagement)
        .where(eq(siteLoadManagement.siteId, id));

      // Only the switch to Departure Aware waits for the setting: a site already
      // on it keeps saving its other fields.
      if (
        body.strategy === 'departure_aware' &&
        existing?.strategy !== 'departure_aware' &&
        !(await isFleetChargingEnabled())
      ) {
        await reply.status(400).send(FLEET_CHARGING_DISABLED);
        return;
      }

      if (existing != null) {
        // A config change makes the next cycle send every limit again. The
        // station records stay (what a station may hold does not change with a
        // save), written under the site row lock so a reply or a cycle claim
        // in between is kept. Turned off, the limits are removed from the
        // site's stations (a profile stays on a station until cleared and would
        // cap it forever) and every record becomes unknown.
        const turnsOff = existing.isEnabled && !body.isEnabled;
        const updated = await db.transaction(async (tx) => {
          const [locked] = await tx
            .select({ appliedAllocations: siteLoadManagement.appliedAllocations })
            .from(siteLoadManagement)
            .where(eq(siteLoadManagement.siteId, id))
            .for('update');
          const [row] = await tx
            .update(siteLoadManagement)
            .set({
              strategy: body.strategy,
              isEnabled: body.isEnabled,
              ...(body.departureBufferMinutes !== undefined
                ? { departureBufferMinutes: body.departureBufferMinutes }
                : {}),
              appliedAllocations: entriesAfterConfigSave(locked?.appliedAllocations ?? null, {
                turnsOff,
              }),
              appliedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(siteLoadManagement.siteId, id))
            .returning();
          return row;
        });
        if (turnsOff) {
          const assigned = await db
            .select({ stationId: chargingStations.stationId })
            .from(chargingStations)
            .where(
              and(
                eq(chargingStations.siteId, id),
                isNotNull(chargingStations.circuitId),
                // Load management never manages a conformance test station.
                isOperatorStation(),
              ),
            );
          const previous = parseAppliedAllocations(existing.appliedAllocations) ?? [];
          await clearLoadManagementProfiles(
            [...assigned.map((s) => s.stationId), ...previous.map((a) => a.stationId)],
            request.log,
          );
          // The depot plan TxProfiles go too: no cycle runs for the site any more.
          await clearPlanProfilesOnDisable(id, request.log);
        }
        const change = changedFields(
          {
            strategy: existing.strategy,
            isEnabled: existing.isEnabled,
            departureBufferMinutes: existing.departureBufferMinutes,
          },
          {
            strategy: body.strategy,
            isEnabled: body.isEnabled,
            departureBufferMinutes: body.departureBufferMinutes ?? existing.departureBufferMinutes,
          },
        );
        if (Object.keys(change.after).length > 0) {
          await writeSiteLoadManagementAudit(request, id, {
            ...change,
            notes: 'load management configuration updated',
          });
        }
        return toConfigRecord(updated);
      }

      const [created] = await db
        .insert(siteLoadManagement)
        .values({
          siteId: id,
          strategy: body.strategy,
          isEnabled: body.isEnabled,
          ...(body.departureBufferMinutes !== undefined
            ? { departureBufferMinutes: body.departureBufferMinutes }
            : {}),
        })
        .returning();

      await writeSiteLoadManagementAudit(request, id, {
        before: null,
        after: {
          strategy: body.strategy,
          isEnabled: body.isEnabled,
          departureBufferMinutes: created?.departureBufferMinutes ?? null,
        },
        notes: 'load management configuration created',
      });

      return reply.status(201).send(toConfigRecord(created));
    },
  );

  // The depot charging plan (route-aware charging): the plan the load
  // management cycle stored, the departures with their readiness and the
  // sessions no vehicle is bound to. Departures show also while the planner
  // is off.
  app.get(
    '/sites/:id/charging-plan',
    {
      onRequest: [authorize('loadManagement:read')],
      schema: {
        tags: ['Load Management'],
        summary: 'Get the depot charging plan of a site',
        description:
          "The plan the load management cycle computed for the site's departures, the scheduled departures with their readiness, and the active sessions without a vehicle. While the fleetCharging.enabled setting is off or the site uses another strategy, planning is false and the plan fields are null; the departures and sessions still show. The departures and their vehicles come only with fleets:read while the Fleet feature is on; vehicle driver ids only with drivers:read, and session driver ids only with sessions:read and drivers:read.",
        operationId: 'getSiteChargingPlan',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        querystring: zodSchema(chargingPlanQuery),
        response: {
          200: itemResponse(sitePlanItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as { userId: string };
      if (!siteInScope(await getUserSiteIds(userId), id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      // The plan needs loadManagement:read only; the departures and driver
      // ids follow the departure and driver read rules.
      const [fleetsRead, fleetOn, driversRead, sessionsRead] = await Promise.all([
        requestHasPermission(request, 'fleets:read'),
        isFleetEnabled(),
        requestHasPermission(request, 'drivers:read'),
        requestHasPermission(request, 'sessions:read'),
      ]);
      const departures = fleetsRead && fleetOn;
      const { departureStatus } = request.query as z.infer<typeof chargingPlanQuery>;
      const [integrationsRead, allSites] = await Promise.all([
        requestHasPermission(request, 'settings.integrations:read'),
        isAllSiteUser(userId),
      ]);
      const view = await siteChargingPlanView(
        id,
        {
          departures,
          driverIds: driversRead,
          sessionIds: sessionsRead,
          sessionDriverIds: sessionsRead && driversRead,
          depotSystemNames: integrationsRead && allSites,
        },
        new Date(),
        departureStatus,
      );
      return {
        ...view,
        plan: planEntriesForReader(view.plan, {
          fleetIds: departures,
          sessionIds: departures && sessionsRead,
        }),
      };
    },
  );

  app.post(
    '/sites/:id/charging-plan/recalculate',
    {
      onRequest: [authorize('loadManagement:write')],
      config: {
        rateLimit: {
          max: 6,
          timeWindow: '1 minute',
          keyGenerator: (request: FastifyRequest) => {
            const user = request.user as { userId?: string } | undefined;
            return `charging-plan-recalculate:${user?.userId ?? request.ip}`;
          },
        },
      },
      schema: {
        tags: ['Load Management'],
        summary: 'Recalculate the depot charging plan of a site',
        description:
          'Marks the plan stale, so the next load management cycle (every 10 seconds) computes it again. Answers 202 at once. Limited to 6 a minute per user; each request writes a site audit row. Refused with 400 FLEET_CHARGING_DISABLED while the fleetCharging.enabled setting is off; a site that does not use the Departure Aware strategy gets no plan.',
        operationId: 'recalculateSiteChargingPlan',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        response: {
          202: itemResponse(
            z
              .object({
                accepted: z.literal(true).describe('The plan is marked for recalculation'),
              })
              .loose(),
          ),
          400: errorWith('Fleet charging off', [ERROR_CODES.FLEET_CHARGING_DISABLED]),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as { userId: string };
      if (!siteInScope(await getUserSiteIds(userId), id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      if (!(await isFleetChargingEnabled())) {
        await reply.status(400).send(FLEET_CHARGING_DISABLED);
        return;
      }
      await markSitePlanStale(id, 'manual_recalculate', request.log, { departureAwareOnly: true });
      await writeSiteLoadManagementAudit(request, id, {
        before: null,
        after: { chargingPlan: 'recalculate_requested' },
        notes: 'depot charging plan recalculation requested',
      });
      await reply.status(202).send({ accepted: true });
    },
  );

  // PATCH /sites/:id/stations/:stationId/load-priority
  app.patch(
    '/sites/:id/stations/:stationId/load-priority',
    {
      onRequest: [authorize('loadManagement:write')],
      onResponse: [recomputeSiteAfterWrite('load_priority_changed', 'id')],
      schema: {
        tags: ['Load Management'],
        summary: 'Update load priority for a station',
        operationId: 'updateStationLoadPriority',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteStationParams),
        body: zodSchema(patchPriorityBody),
        response: {
          200: itemResponse(loadPriorityItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, stationId } = request.params as { id: string; stationId: string };
      const body = request.body as z.infer<typeof patchPriorityBody>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        return reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      }

      // Bind the station to the URL site so an operator with access to
      // siteA can't bump load-priority on a station that lives at siteB
      // by passing PATCH /sites/<siteA>/stations/<stationB>/load-priority.
      const [previous] = await db
        .select({ loadPriority: chargingStations.loadPriority })
        .from(chargingStations)
        .where(and(eq(chargingStations.id, stationId), eq(chargingStations.siteId, id)));
      const [updated] = await db
        .update(chargingStations)
        .set({
          loadPriority: body.loadPriority,
          updatedAt: new Date(),
        })
        .where(and(eq(chargingStations.id, stationId), eq(chargingStations.siteId, id)))
        .returning();

      if (updated == null) {
        return reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      }

      if (previous?.loadPriority !== updated.loadPriority) {
        await writeStationLoadAudit(request, updated.id, {
          before: { loadPriority: previous?.loadPriority ?? null },
          after: { loadPriority: updated.loadPriority },
          notes: 'load priority changed',
        });
      }

      return { id: updated.id, stationId: updated.stationId, loadPriority: updated.loadPriority };
    },
  );

  // PATCH /sites/:id/stations/:stationId/load-balancing-mode
  app.patch(
    '/sites/:id/stations/:stationId/load-balancing-mode',
    {
      onRequest: [authorize('loadManagement:write')],
      onResponse: [replanSiteAfterWrite('load_management_changed', 'id')],
      schema: {
        tags: ['Load Management'],
        summary: 'Choose how load management limits a station: one station limit, or per EVSE',
        description:
          'evse sends each charging EVSE its own limit (a TxProfile per transaction) besides the station limit. Sessions with a tariff current limit are limited per EVSE in either mode. Setting the mode clears a stored refusal of per-EVSE limits, and the site sends its limits again on the next cycle.',
        operationId: 'updateStationLoadBalancingMode',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteStationParams),
        body: zodSchema(patchBalancingModeBody),
        response: {
          200: itemResponse(loadBalancingModeItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, stationId } = request.params as { id: string; stationId: string };
      const body = request.body as z.infer<typeof patchBalancingModeBody>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        return reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      }

      // Bound to the URL site, like the load priority.
      const [previous] = await db
        .select({
          loadBalancingMode: chargingStations.loadBalancingMode,
          evseLimitsRefusedAt: chargingStations.evseLimitsRefusedAt,
        })
        .from(chargingStations)
        .where(and(eq(chargingStations.id, stationId), eq(chargingStations.siteId, id)));
      const [updated] = await db
        .update(chargingStations)
        .set({ loadBalancingMode: body.mode, updatedAt: new Date() })
        .where(and(eq(chargingStations.id, stationId), eq(chargingStations.siteId, id)))
        .returning({ id: chargingStations.id, stationId: chargingStations.stationId });

      if (updated == null || previous == null) {
        return reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      }

      const refusalCleared = await clearEvseLimitsRefused(client, updated.id);
      // The next cycle sends the limits in the mode chosen, not at the refresh interval.
      await db
        .update(siteLoadManagement)
        .set({ appliedAt: null })
        .where(eq(siteLoadManagement.siteId, id));

      if (previous.loadBalancingMode !== body.mode || refusalCleared) {
        await writeStationLoadAudit(request, updated.id, {
          before: {
            loadBalancingMode: previous.loadBalancingMode,
            evseLimitsRefusedAt: toIsoOrNull(previous.evseLimitsRefusedAt),
          },
          after: { loadBalancingMode: body.mode, evseLimitsRefusedAt: null },
          notes: refusalCleared
            ? 'load balancing mode set, per-EVSE limit refusal cleared'
            : 'load balancing mode changed',
        });
      }

      return {
        id: updated.id,
        stationId: updated.stationId,
        loadBalancingMode: body.mode,
        evseLimitsRefusedAt: null,
      };
    },
  );

  // PATCH /sites/:id/stations/:stationId/load-min-power
  app.patch(
    '/sites/:id/stations/:stationId/load-min-power',
    {
      onRequest: [authorize('loadManagement:write')],
      onResponse: [replanSiteAfterWrite('load_management_changed', 'id')],
      schema: {
        tags: ['Load Management'],
        summary: 'Update the minimum power of a station under load management',
        description:
          'Load management never gives a charging session at this station less than this power. When the minimums do not fit, the lowest priority sessions stop (limit 0) first.',
        operationId: 'updateStationLoadMinPower',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteStationParams),
        body: zodSchema(patchMinPowerBody),
        response: {
          200: itemResponse(loadMinPowerItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, stationId } = request.params as { id: string; stationId: string };
      const body = request.body as z.infer<typeof patchMinPowerBody>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        return reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      }

      // Bound to the URL site, like the load priority.
      const [previous] = await db
        .select({ loadMinPowerKw: chargingStations.loadMinPowerKw })
        .from(chargingStations)
        .where(and(eq(chargingStations.id, stationId), eq(chargingStations.siteId, id)));
      const [updated] = await db
        .update(chargingStations)
        .set({
          loadMinPowerKw: body.loadMinPowerKw != null ? String(body.loadMinPowerKw) : null,
          updatedAt: new Date(),
        })
        .where(and(eq(chargingStations.id, stationId), eq(chargingStations.siteId, id)))
        .returning();

      if (updated == null) {
        return reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      }

      const beforeKw = previous?.loadMinPowerKw != null ? Number(previous.loadMinPowerKw) : null;
      const afterKw = updated.loadMinPowerKw != null ? Number(updated.loadMinPowerKw) : null;
      if (beforeKw !== afterKw) {
        await writeStationLoadAudit(request, updated.id, {
          before: { loadMinPowerKw: beforeKw },
          after: { loadMinPowerKw: afterKw },
          notes: 'load minimum power changed',
        });
      }

      return {
        id: updated.id,
        stationId: updated.stationId,
        loadMinPowerKw: afterKw,
      };
    },
  );

  // GET /sites/:id/load-management/history
  app.get(
    '/sites/:id/load-management/history',
    {
      onRequest: [authorize('loadManagement:read')],
      schema: {
        tags: ['Load Management'],
        summary: 'Get load allocation history for a site',
        description:
          'The allocation changes of the site, newest first (the periodic resends and credit profile resends are left out), each with its station limits read from the allocation log entries.',
        operationId: 'getSiteLoadManagementHistory',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(historyQuery),
        response: {
          200: arrayResponse(historyItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { limit } = request.query as z.infer<typeof historyQuery>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const rows = await db
        .select()
        .from(loadAllocationLog)
        .where(and(eq(loadAllocationLog.siteId, id), eq(loadAllocationLog.kind, 'change')))
        .orderBy(desc(loadAllocationLog.createdAt), desc(loadAllocationLog.id))
        .limit(limit);
      // A header without entries (written by an earlier release's worker) has no per-station detail.
      const stationRows =
        rows.length === 0
          ? []
          : await db
              .select({
                logId: loadAllocationEntries.logId,
                stationOcppId: loadAllocationEntries.stationOcppId,
                stationDbId: loadAllocationEntries.stationId,
                limitKw: loadAllocationEntries.limitKw,
              })
              .from(loadAllocationEntries)
              .where(
                and(
                  inArray(
                    loadAllocationEntries.logId,
                    rows.map((row) => row.id),
                  ),
                  eq(loadAllocationEntries.scope, 'station'),
                ),
              )
              .orderBy(loadAllocationEntries.id);
      const byLog = new Map<
        number,
        { stationId: string; stationDbId: string | null; allocatedKw: number }[]
      >();
      for (const entry of stationRows) {
        byLog.set(entry.logId, [
          ...(byLog.get(entry.logId) ?? []),
          {
            stationId: entry.stationOcppId,
            stationDbId: entry.stationDbId,
            allocatedKw: Number(entry.limitKw),
          },
        ]);
      }

      return rows.map((row) => ({
        id: row.id,
        siteLimitKw: Number(row.siteLimitKw),
        totalDrawKw: Number(row.totalDrawKw),
        availableKw: Number(row.availableKw),
        strategy: row.strategy,
        allocations: byLog.get(row.id) ?? [],
        createdAt: row.createdAt.toISOString(),
      }));
    },
  );
}
