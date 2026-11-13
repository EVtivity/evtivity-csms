// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LoadAllocationStrategy } from '@evtivity/lib/load-allocation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2, Zap, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CreateButton } from '@/components/create-button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { PowerBar } from './PowerBar';
import { PanelForm } from './PanelForm';
import { CircuitForm } from './CircuitForm';
import { UnmanagedLoadForm } from './UnmanagedLoadForm';
import { AssignStationDialog } from './AssignStationDialog';
import { CircuitStationTable, type CircuitStationStatus } from './CircuitStationTable';
import { formatNumber } from '@/lib/formatting';
import { TransformerForm } from './TransformerForm';
import { getErrorMessage } from '@/lib/error-message';
import {
  formatKva,
  isTransformerNode,
  supplyStateKey,
  supplyStateVariant,
  type NodeEnergyAsset,
  type TransformerItem,
} from './load-management-types';

interface UnmanagedLoad {
  id: number;
  name: string;
  estimatedDrawKw: number;
}

interface CircuitStation {
  id: string;
  stationId: string;
  currentDrawKw: number;
  allocatedLimitKw: number | null;
  maxPowerKw: number;
  isOnline: boolean;
  hasActiveSession: boolean;
}

interface CircuitStatus {
  id: string;
  name: string;
  breakerRatingAmps: number;
  maxContinuousKw: number;
  currentDrawKw: number;
  availableKw: number;
  phaseConnections?: string | null;
  voltageV?: number | null;
  stations: CircuitStation[];
  unmanagedLoads: UnmanagedLoad[];
}

interface PhaseLoadData {
  L1: number;
  L2: number;
  L3: number;
}

interface PanelStatus {
  /** `transformer`: a service transformer above top-level panels, or a step-down one between a panel and its sub-panels. */
  type?: 'panel' | 'circuit' | 'transformer';
  transformerKind?: 'service' | 'step_down';
  id: string;
  name: string;
  breakerRatingAmps: number;
  voltageV: number;
  phases: number;
  maxContinuousKw: number;
  safetyMarginKw: number;
  oversubscriptionRatio: number;
  phaseConnections?: string | null;
  currentDrawKw: number;
  availableKw: number;
  utilization: number;
  totalConnectedKw: number;
  phaseLoad: PhaseLoadData | null;
  perPhaseCapacityKw: number | null;
  /** Battery and solar supply credited on top of the capacity, kW. */
  supplyCreditKw?: number;
  /** Load of the assets connected here (a charging battery), kW. */
  supplyLoadKw?: number;
  /** The batteries and solar arrays connected at this node. */
  energyAssets?: NodeEnergyAsset[];
  circuits: CircuitStatus[];
  childPanels: PanelStatus[];
  unmanagedLoads: UnmanagedLoad[];
}

interface StationStatus {
  id: string;
  stationId: string;
  currentDrawKw: number;
  allocatedLimitKw: number | null;
  maxPowerKw: number;
  loadPriority: number;
  isOnline: boolean;
  hasActiveSession: boolean;
  loadMinPowerKw?: number | null;
  rateUnit?: 'A' | 'W';
  limitReserved?: boolean;
}

interface PanelTreeProps {
  siteId: string;
  hierarchy: PanelStatus[];
  stations: StationStatus[];
  /** The site's transformers (`GET /v1/sites/:siteId/transformers`). */
  transformers?: TransformerItem[];
  /** loadManagement:write: without it the tree is read only. */
  canWrite?: boolean;
  /** The saved allocation strategy: station priorities are set only for Priority Based. */
  strategy?: LoadAllocationStrategy | undefined;
  onRefresh: () => void;
}

/** Ids of the transformer nodes in the tree (rated and linked). */
function treeTransformerIds(nodes: PanelStatus[], ids = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (isTransformerNode(node)) ids.add(node.id);
    treeTransformerIds(node.childPanels, ids);
  }
  return ids;
}

function getAssignedStationIds(panels: PanelStatus[]): Set<string> {
  const ids = new Set<string>();
  for (const panel of panels) {
    for (const circuit of panel.circuits) {
      for (const station of circuit.stations) {
        ids.add(station.id);
      }
    }
    if (panel.childPanels.length > 0) {
      for (const id of getAssignedStationIds(panel.childPanels)) {
        ids.add(id);
      }
    }
  }
  return ids;
}

export function PanelTree({
  siteId,
  hierarchy,
  stations,
  transformers = [],
  canWrite = false,
  strategy,
  onRefresh,
}: PanelTreeProps): React.JSX.Element {
  const { t } = useTranslation();

  const assignedIds = getAssignedStationIds(hierarchy);
  const stationsNotOnCircuit = stations.filter((s) => !assignedIds.has(s.id));
  const inTree = treeTransformerIds(hierarchy);
  const unlinkedTransformers = transformers.filter((tx) => !inTree.has(tx.id));
  const ctx: TreeContext = {
    siteId,
    allPanels: hierarchy,
    stations,
    transformers,
    canWrite,
    strategy,
    onRefresh,
  };

  return (
    <div className="space-y-4">
      {stationsNotOnCircuit.length > 0 && (
        <Alert variant="warning" className="items-start" data-testid="stations-not-on-circuit">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <div className="min-w-0 flex-1">
            <AlertTitle>{t('loadManagement.stationsNotOnCircuit')}</AlertTitle>
            <AlertDescription>
              <p>{t('loadManagement.stationsNotOnCircuitWarning')}</p>
              <div className="mt-3 max-h-48 overflow-y-auto space-y-1 text-foreground">
                {stationsNotOnCircuit.map((station) => (
                  <div key={station.id} className="flex items-center gap-2 text-sm">
                    <Zap className="h-3 w-3 text-muted-foreground" />
                    <span>{station.stationId}</span>
                    <Badge variant={station.isOnline ? 'success' : 'outline'} className="text-xs">
                      {station.isOnline ? t('status.online') : t('status.offline')}
                    </Badge>
                  </div>
                ))}
              </div>
            </AlertDescription>
          </div>
        </Alert>
      )}

      {hierarchy.length > 0 && (
        // The tree keeps its desktop layout on phones and scrolls sideways in its own
        // container: nested panels and circuits indent at every level.
        <div className="overflow-x-auto" data-testid="panel-tree-scroll">
          <div className="min-w-[64rem] space-y-4">
            {hierarchy.map((node) => (
              <TreeNodeView key={node.id} ctx={ctx} node={node} depth={0} />
            ))}
          </div>
        </div>
      )}

      {hierarchy.length === 0 && (
        <p className="text-sm text-muted-foreground py-4 text-center">
          {t('loadManagement.noPanels')}
        </p>
      )}

      {unlinkedTransformers.length > 0 && (
        <div className="rounded-lg border border-dashed p-4" data-testid="unlinked-transformers">
          <p className="text-sm font-medium">{t('loadManagement.unlinkedTransformers')}</p>
          <p className="mt-1 mb-3 text-xs text-muted-foreground">
            {t('loadManagement.unlinkedTransformersHint')}
          </p>
          <div className="space-y-2">
            {unlinkedTransformers.map((tx) => (
              <UnlinkedTransformer key={tx.id} ctx={ctx} transformer={tx} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface TreeContext {
  siteId: string;
  allPanels: PanelStatus[];
  stations: StationStatus[];
  transformers: TransformerItem[];
  canWrite: boolean;
  strategy: LoadAllocationStrategy | undefined;
  onRefresh: () => void;
}

function TreeNodeView({
  ctx,
  node,
  depth,
}: {
  ctx: TreeContext;
  node: PanelStatus;
  depth: number;
}): React.JSX.Element {
  if (isTransformerNode(node)) return <TransformerNode ctx={ctx} node={node} depth={depth} />;
  return <PanelNode ctx={ctx} panel={node} depth={depth} />;
}

/**
 * The load bar of a panel or transformer: one bar per phase for three-phase
 * (with the total and its local supply segment above them when a battery or
 * solar credit applies), else one bar.
 */
function NodeLoadBars({ node }: { node: PanelStatus }): React.JSX.Element {
  const { t } = useTranslation();
  const creditKw = node.supplyCreditKw ?? 0;
  const total = (
    <PowerBar
      currentKw={node.currentDrawKw}
      limitKw={node.maxContinuousKw - node.safetyMarginKw}
      maxKw={node.maxContinuousKw}
      creditKw={creditKw}
    />
  );
  const phaseLoad = node.phaseLoad;
  const perPhase = node.perPhaseCapacityKw;
  if (node.phases === 3 && phaseLoad != null && perPhase != null) {
    return (
      <div className="space-y-1">
        {creditKw > 0 && total}
        <p className="text-xs text-muted-foreground">{t('loadManagement.perPhaseUtilization')}</p>
        {(['L1', 'L2', 'L3'] as const).map((phase) => (
          <PowerBar
            key={phase}
            currentKw={phaseLoad[phase]}
            limitKw={perPhase}
            maxKw={perPhase}
            label={phase}
          />
        ))}
      </div>
    );
  }
  return total;
}

/** The batteries and solar arrays connected at a node, with their supply state. */
function NodeAssets({ assets }: { assets: NodeEnergyAsset[] }): React.JSX.Element | null {
  const { t } = useTranslation();
  if (assets.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2" data-testid="node-energy-assets">
      {assets.map((asset) => (
        <span key={asset.id} className="inline-flex items-center gap-1.5 text-xs">
          <span className="font-medium">{asset.name}</span>
          <Badge variant={supplyStateVariant(asset.supply.state)} className="text-xs px-1.5 py-0">
            {t(supplyStateKey(asset.supply.state))}
          </Badge>
          {asset.supply.creditKw > 0 && (
            <span className="text-info">
              {t('loadManagement.assetCreditValue', { kw: formatNumber(asset.supply.creditKw, 1) })}
            </span>
          )}
          {asset.supply.loadKw > 0 && (
            <span className="text-muted-foreground">
              {t('loadManagement.assetLoadValue', { kw: formatNumber(asset.supply.loadKw, 1) })}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

/** The facts of a transformer: kind, rating, power factor, loading limit and capacity. */
function TransformerFacts({
  transformer,
  capacityKw,
}: {
  transformer: TransformerItem | undefined;
  capacityKw: number | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      {transformer != null && (
        <>
          <Badge variant="outline" className="text-xs px-1.5 py-0">
            {transformer.kind === 'step_down'
              ? t('loadManagement.kindStepDown')
              : t('loadManagement.kindService')}
          </Badge>
          {transformer.ratedKva != null ? (
            <span className="text-xs text-muted-foreground">{formatKva(transformer.ratedKva)}</span>
          ) : (
            <Badge variant="warning" className="text-xs px-1.5 py-0">
              {t('loadManagement.ratedKvaUnknown')}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            {t('loadManagement.powerFactorValue', {
              value: formatNumber(transformer.powerFactor, 2),
            })}
          </span>
          <span className="text-xs text-muted-foreground">
            {t('loadManagement.loadingLimitValue', {
              percent: String(transformer.loadingLimitPercent),
            })}
          </span>
          <span className="text-xs text-muted-foreground">{transformer.phases}ph</span>
        </>
      )}
      {capacityKw != null && (
        <span className="text-xs text-muted-foreground">
          {t('loadManagement.kwMax', { kw: formatNumber(capacityKw, 1) })}
        </span>
      )}
    </>
  );
}

/** Edit and delete of a transformer, with its form and the delete confirmation. */
function TransformerActions({
  ctx,
  transformer,
}: {
  ctx: TreeContext;
  transformer: TransformerItem;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/v1/sites/${ctx.siteId}/transformers/${transformer.id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sites', ctx.siteId] });
      setDeleteOpen(false);
      ctx.onRefresh();
    },
  });

  return (
    <>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('loadManagement.editTransformerNamed', { name: transformer.name })}
          onClick={() => {
            setEditOpen(true);
          }}
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('loadManagement.deleteTransformerNamed', { name: transformer.name })}
          onClick={() => {
            deleteMutation.reset();
            setDeleteOpen(true);
          }}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <TransformerForm
        siteId={ctx.siteId}
        transformer={transformer}
        panels={ctx.allPanels}
        open={editOpen}
        onClose={() => {
          setEditOpen(false);
        }}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: ['sites', ctx.siteId] });
          ctx.onRefresh();
        }}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('loadManagement.deleteTransformer')}
        description={t('loadManagement.confirmDeleteTransformer')}
        confirmLabel={t('common.delete')}
        confirmIcon={<Trash2 className="h-4 w-4" />}
        onConfirm={() => {
          deleteMutation.mutate();
          return false;
        }}
        isPending={deleteMutation.isPending}
      >
        {deleteMutation.isError && (
          <p className="text-sm text-destructive">
            {getErrorMessage(deleteMutation.error, t, 'loadManagement.saveFailed')}
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}

function TransformerNode({
  ctx,
  node,
  depth,
}: {
  ctx: TreeContext;
  node: PanelStatus;
  depth: number;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const transformer = ctx.transformers.find((tx) => tx.id === node.id);
  const capacityKw = node.maxContinuousKw;
  const percent = capacityKw > 0 ? Math.round((node.currentDrawKw / capacityKw) * 100) : 0;

  return (
    <div
      className={depth > 0 ? 'ml-6 border-l border-border pl-4' : ''}
      data-testid={`transformer-node-${node.id}`}
    >
      <div className="rounded-lg border border-info/40 bg-card p-4">
        <div className="flex items-start gap-3">
          <button
            type="button"
            aria-label={expanded ? t('loadManagement.collapse') : t('loadManagement.expand')}
            onClick={() => {
              setExpanded(!expanded);
            }}
            className="mt-0.5 rounded-sm p-0.5 hover:bg-muted transition-colors"
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-semibold">{node.name}</p>
              <TransformerFacts transformer={transformer} capacityKw={capacityKw} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground" data-testid="transformer-load">
              {t('loadManagement.transformerLoad', {
                kw: formatNumber(node.currentDrawKw, 1),
                capacity: formatNumber(capacityKw, 1),
                percent: String(percent),
              })}
            </p>
            <div className="mt-2">
              <NodeLoadBars node={node} />
            </div>
            <NodeAssets assets={node.energyAssets ?? []} />
          </div>
          {ctx.canWrite && transformer != null && (
            <TransformerActions ctx={ctx} transformer={transformer} />
          )}
        </div>
        {expanded && node.childPanels.length > 0 && (
          <div className="mt-4 space-y-3">
            {node.childPanels.map((child) => (
              <TreeNodeView key={child.id} ctx={ctx} node={child} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** A transformer outside the tree: unrated, or no panel links it. */
function UnlinkedTransformer({
  ctx,
  transformer,
}: {
  ctx: TreeContext;
  transformer: TransformerItem;
}): React.JSX.Element {
  return (
    <div
      className="flex items-start gap-3 rounded-md border bg-card p-3"
      data-testid={`unlinked-transformer-${transformer.id}`}
    >
      <div className="flex flex-1 min-w-0 flex-wrap items-center gap-2">
        <p className="text-sm font-semibold">{transformer.name}</p>
        <TransformerFacts transformer={transformer} capacityKw={transformer.maxContinuousKw} />
      </div>
      {ctx.canWrite && <TransformerActions ctx={ctx} transformer={transformer} />}
    </div>
  );
}

function PanelNode({
  ctx,
  panel,
  depth,
}: {
  ctx: TreeContext;
  panel: PanelStatus;
  depth: number;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { siteId, allPanels, stations, transformers, canWrite, strategy, onRefresh } = ctx;
  const [expanded, setExpanded] = useState(false);
  const [editPanelOpen, setEditPanelOpen] = useState(false);
  const [addCircuitOpen, setAddCircuitOpen] = useState(false);
  const [addSubPanelOpen, setAddSubPanelOpen] = useState(false);
  const [addLoadOpen, setAddLoadOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/v1/sites/${siteId}/panels/${panel.id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sites', siteId, 'load-management'] });
      onRefresh();
    },
  });

  return (
    <div className={depth > 0 ? 'ml-6 border-l border-border pl-4' : ''}>
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-start gap-3">
          <button
            type="button"
            aria-label={expanded ? t('loadManagement.collapse') : t('loadManagement.expand')}
            onClick={() => {
              setExpanded(!expanded);
            }}
            className="mt-0.5 rounded-sm p-0.5 hover:bg-muted transition-colors"
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-semibold">{panel.name}</p>
              <span className="text-xs text-muted-foreground">{panel.breakerRatingAmps}A</span>
              <span className="text-xs text-muted-foreground">
                {panel.voltageV}V {panel.phases}ph
              </span>
              {panel.phaseConnections != null && (
                <Badge variant="outline" className="text-xs px-1.5 py-0">
                  {panel.phaseConnections}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                {t('loadManagement.kwMax', { kw: formatNumber(panel.maxContinuousKw, 1) })}
              </span>
              {panel.totalConnectedKw > panel.maxContinuousKw && (
                <Badge variant="warning" className="max-w-full whitespace-normal text-xs">
                  {t('loadManagement.oversubscribed')}{' '}
                  {formatNumber(panel.totalConnectedKw / panel.maxContinuousKw, 2)}x
                </Badge>
              )}
            </div>

            <div className="mt-2">
              <NodeLoadBars node={panel} />
            </div>
            <NodeAssets assets={panel.energyAssets ?? []} />
          </div>

          {canWrite && (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('loadManagement.editPanel')}
                onClick={() => {
                  setEditPanelOpen(true);
                }}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('loadManagement.addCircuit')}
                onClick={() => {
                  setAddCircuitOpen(true);
                  setExpanded(true);
                }}
              >
                <Plus className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('loadManagement.deletePanel')}
                onClick={() => {
                  setDeleteOpen(true);
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>

        {expanded && (
          <div className="mt-4 space-y-3">
            {panel.circuits.map((circuit) => (
              <CircuitNode
                key={circuit.id}
                siteId={siteId}
                panelId={panel.id}
                panelVoltageV={panel.voltageV}
                panelPhases={panel.phases}
                circuit={circuit}
                stations={stations}
                canWrite={canWrite}
                strategy={strategy}
                onRefresh={onRefresh}
              />
            ))}

            {panel.unmanagedLoads.length > 0 && (
              <div className="pl-4">
                <p className="text-xs font-medium text-muted-foreground mb-1">
                  {t('loadManagement.unmanagedLoads')}
                </p>
                {panel.unmanagedLoads.map((load) => (
                  <UnmanagedLoadItem
                    key={load.id}
                    siteId={siteId}
                    load={load}
                    canWrite={canWrite}
                    onRefresh={onRefresh}
                  />
                ))}
              </div>
            )}

            {panel.childPanels.map((child) => (
              <TreeNodeView key={child.id} ctx={ctx} node={child} depth={depth + 1} />
            ))}

            {canWrite && (
              <div className="flex flex-wrap gap-2 pl-4">
                <CreateButton
                  label={t('loadManagement.addSubPanel')}
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setAddSubPanelOpen(true);
                    setExpanded(true);
                  }}
                />
                <CreateButton
                  label={t('loadManagement.addUnmanagedLoad')}
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setAddLoadOpen(true);
                    setExpanded(true);
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {canWrite && (
        <>
          <PanelForm
            siteId={siteId}
            panel={panel}
            panels={allPanels}
            transformers={transformers}
            open={editPanelOpen}
            onClose={() => {
              setEditPanelOpen(false);
            }}
            onSaved={onRefresh}
          />

          <PanelForm
            siteId={siteId}
            panels={allPanels}
            transformers={transformers}
            defaultParentPanelId={panel.id}
            open={addSubPanelOpen}
            onClose={() => {
              setAddSubPanelOpen(false);
            }}
            onSaved={onRefresh}
          />

          <CircuitForm
            siteId={siteId}
            panelId={panel.id}
            panelVoltageV={panel.voltageV}
            panelPhases={panel.phases}
            open={addCircuitOpen}
            onClose={() => {
              setAddCircuitOpen(false);
            }}
            onSaved={onRefresh}
          />

          <UnmanagedLoadForm
            siteId={siteId}
            panelId={panel.id}
            open={addLoadOpen}
            onClose={() => {
              setAddLoadOpen(false);
            }}
            onSaved={onRefresh}
          />

          <ConfirmDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            title={t('loadManagement.deletePanel')}
            description={t('loadManagement.confirmDeletePanel')}
            confirmLabel={t('common.delete')}
            confirmIcon={<Trash2 className="h-4 w-4" />}
            onConfirm={() => {
              deleteMutation.mutate();
            }}
            isPending={deleteMutation.isPending}
          />
        </>
      )}
    </div>
  );
}

function CircuitNode({
  siteId,
  panelId,
  panelVoltageV,
  panelPhases,
  circuit,
  stations,
  canWrite,
  strategy,
  onRefresh,
}: {
  siteId: string;
  panelId: string;
  panelVoltageV: number;
  panelPhases: number;
  circuit: CircuitStatus;
  stations: StationStatus[];
  canWrite: boolean;
  strategy: LoadAllocationStrategy | undefined;
  onRefresh: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [addLoadOpen, setAddLoadOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [removeStation, setRemoveStation] = useState<CircuitStationStatus | null>(null);

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/v1/sites/${siteId}/panels/${panelId}/circuits/${circuit.id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sites', siteId, 'load-management'] });
      onRefresh();
    },
  });

  const unassignMutation = useMutation({
    mutationFn: (stationId: string) =>
      api.patch(`/v1/sites/${siteId}/stations/${stationId}/circuit`, { circuitId: null }),
    onSuccess: () => {
      setRemoveStation(null);
      void queryClient.invalidateQueries({ queryKey: ['sites', siteId, 'load-management'] });
      onRefresh();
    },
  });

  return (
    <div className="ml-4 rounded-md border bg-background p-3">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{circuit.name}</p>
            <span className="text-xs text-muted-foreground">{circuit.breakerRatingAmps}A</span>
            {circuit.phaseConnections != null && (
              <Badge variant="outline" className="text-xs px-1.5 py-0">
                {circuit.phaseConnections}
              </Badge>
            )}
            {circuit.voltageV != null && (
              <Badge variant="outline" className="text-xs px-1.5 py-0">
                {circuit.voltageV}V
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">
              {t('loadManagement.kwMax', { kw: formatNumber(circuit.maxContinuousKw, 1) })}
            </span>
          </div>
          <div className="mt-1.5">
            <PowerBar
              currentKw={circuit.currentDrawKw}
              limitKw={circuit.maxContinuousKw}
              maxKw={circuit.maxContinuousKw}
            />
          </div>
        </div>

        {canWrite && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('loadManagement.editCircuit')}
              onClick={() => {
                setEditOpen(true);
              }}
            >
              <Pencil className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('loadManagement.addStation')}
              onClick={() => {
                setAssignOpen(true);
              }}
            >
              <Plus className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('loadManagement.deleteCircuit')}
              onClick={() => {
                setDeleteOpen(true);
              }}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        )}
      </div>

      {circuit.stations.length > 0 && (
        <div className="mt-2">
          <CircuitStationTable
            siteId={siteId}
            stations={circuit.stations.map((station) => ({
              ...station,
              ...stations.find((s) => s.id === station.id),
            }))}
            strategy={strategy}
            canWrite={canWrite}
            onRemove={setRemoveStation}
          />
        </div>
      )}

      {circuit.unmanagedLoads.length > 0 && (
        <div className="mt-2 pl-2">
          {circuit.unmanagedLoads.map((load) => (
            <UnmanagedLoadItem
              key={load.id}
              siteId={siteId}
              load={load}
              canWrite={canWrite}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}

      {canWrite && (
        <div className="mt-2 pl-2">
          <CreateButton
            label={t('loadManagement.addUnmanagedLoad')}
            variant="outline"
            size="sm"
            onClick={() => {
              setAddLoadOpen(true);
            }}
          />
        </div>
      )}

      <CircuitForm
        siteId={siteId}
        panelId={panelId}
        panelVoltageV={panelVoltageV}
        panelPhases={panelPhases}
        circuit={circuit}
        open={editOpen}
        onClose={() => {
          setEditOpen(false);
        }}
        onSaved={onRefresh}
      />

      <UnmanagedLoadForm
        siteId={siteId}
        circuitId={circuit.id}
        open={addLoadOpen}
        onClose={() => {
          setAddLoadOpen(false);
        }}
        onSaved={onRefresh}
      />

      <AssignStationDialog
        siteId={siteId}
        circuitId={circuit.id}
        stations={stations}
        assignedStationIds={circuit.stations.map((s) => s.id)}
        open={assignOpen}
        onClose={() => {
          setAssignOpen(false);
        }}
        onAssigned={onRefresh}
      />

      <ConfirmDialog
        open={removeStation != null}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveStation(null);
            unassignMutation.reset();
          }
        }}
        title={t('loadManagement.removeStationTitle')}
        description={t('loadManagement.removeStationDescription', {
          station: removeStation?.stationId ?? '',
        })}
        confirmLabel={t('loadManagement.removeStation')}
        confirmIcon={<Trash2 className="h-4 w-4" />}
        onConfirm={() => {
          if (removeStation != null) unassignMutation.mutate(removeStation.id);
          return false;
        }}
        isPending={unassignMutation.isPending}
      >
        {unassignMutation.isError && (
          <p className="text-sm text-destructive">
            {getErrorMessage(unassignMutation.error, t, 'loadManagement.saveFailed')}
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('loadManagement.deleteCircuit')}
        description={t('loadManagement.confirmDeleteCircuit')}
        confirmLabel={t('common.delete')}
        confirmIcon={<Trash2 className="h-4 w-4" />}
        onConfirm={() => {
          deleteMutation.mutate();
        }}
        isPending={deleteMutation.isPending}
      />
    </div>
  );
}

function UnmanagedLoadItem({
  siteId,
  load,
  canWrite,
  onRefresh,
}: {
  siteId: string;
  load: UnmanagedLoad;
  canWrite: boolean;
  onRefresh: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/v1/sites/${siteId}/unmanaged-loads/${String(load.id)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sites', siteId, 'load-management'] });
      onRefresh();
    },
  });

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">{load.name}</span>
      <span className="text-muted-foreground">({formatNumber(load.estimatedDrawKw, 1)} kW)</span>
      {canWrite && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('loadManagement.deleteLoad', { name: load.name })}
          onClick={() => {
            deleteMutation.mutate();
          }}
        >
          <Trash2 className="h-3 w-3 text-muted-foreground" />
        </Button>
      )}
    </div>
  );
}
