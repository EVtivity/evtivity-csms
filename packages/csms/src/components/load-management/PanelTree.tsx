// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2, Zap, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { PowerBar } from './PowerBar';
import { PanelForm } from './PanelForm';
import { CircuitForm } from './CircuitForm';
import { UnmanagedLoadForm } from './UnmanagedLoadForm';
import { AssignStationDialog } from './AssignStationDialog';

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
  stations: CircuitStation[];
  unmanagedLoads: UnmanagedLoad[];
}

interface PhaseLoadData {
  L1: number;
  L2: number;
  L3: number;
}

interface PanelStatus {
  id: string;
  name: string;
  breakerRatingAmps: number;
  voltageV: number;
  phases: number;
  maxContinuousKw: number;
  safetyMarginKw: number;
  oversubscriptionRatio: number;
  currentDrawKw: number;
  availableKw: number;
  utilization: number;
  totalConnectedKw: number;
  phaseLoad: PhaseLoadData | null;
  perPhaseCapacityKw: number | null;
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
}

interface PanelTreeProps {
  siteId: string;
  hierarchy: PanelStatus[];
  stations: StationStatus[];
  onRefresh: () => void;
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
  onRefresh,
}: PanelTreeProps): React.JSX.Element {
  const { t } = useTranslation();

  const assignedIds = getAssignedStationIds(hierarchy);
  const unassignedStations = stations.filter((s) => !assignedIds.has(s.id));

  return (
    <div className="space-y-4">
      {hierarchy.map((panel) => (
        <PanelNode
          key={panel.id}
          siteId={siteId}
          panel={panel}
          allPanels={hierarchy}
          stations={stations}
          depth={0}
          onRefresh={onRefresh}
        />
      ))}

      {hierarchy.length === 0 && (
        <p className="text-sm text-muted-foreground py-4 text-center">
          {t('loadManagement.noPanels')}
        </p>
      )}

      {unassignedStations.length > 0 && (
        <div className="mt-6 rounded-lg border border-warning/50 bg-warning/5 p-4">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <p className="text-sm font-medium">{t('loadManagement.unassignedStations')}</p>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            {t('loadManagement.unassignedWarning')}
          </p>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {unassignedStations.map((station) => (
              <div key={station.id} className="flex items-center gap-2 text-sm">
                <Zap className="h-3 w-3 text-muted-foreground" />
                <span>{station.stationId}</span>
                <Badge variant={station.isOnline ? 'success' : 'outline'} className="text-xs">
                  {station.isOnline ? 'Online' : 'Offline'}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PanelNode({
  siteId,
  panel,
  allPanels,
  stations,
  depth,
  onRefresh,
}: {
  siteId: string;
  panel: PanelStatus;
  allPanels: PanelStatus[];
  stations: StationStatus[];
  depth: number;
  onRefresh: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(true);
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
              <span className="text-xs text-muted-foreground">
                {panel.maxContinuousKw.toFixed(1)} kW max
              </span>
              {panel.totalConnectedKw > panel.maxContinuousKw && (
                <Badge variant="warning" className="text-xs">
                  {t('loadManagement.oversubscribed')}{' '}
                  {(panel.totalConnectedKw / panel.maxContinuousKw).toFixed(2)}x
                </Badge>
              )}
            </div>

            <div className="mt-2">
              {panel.phases === 3 && panel.phaseLoad != null && panel.perPhaseCapacityKw != null ? (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    {t('loadManagement.perPhaseUtilization')}
                  </p>
                  <PowerBar
                    currentKw={panel.phaseLoad.L1}
                    limitKw={panel.perPhaseCapacityKw}
                    maxKw={panel.perPhaseCapacityKw}
                    label="L1"
                  />
                  <PowerBar
                    currentKw={panel.phaseLoad.L2}
                    limitKw={panel.perPhaseCapacityKw}
                    maxKw={panel.perPhaseCapacityKw}
                    label="L2"
                  />
                  <PowerBar
                    currentKw={panel.phaseLoad.L3}
                    limitKw={panel.perPhaseCapacityKw}
                    maxKw={panel.perPhaseCapacityKw}
                    label="L3"
                  />
                </div>
              ) : (
                <PowerBar
                  currentKw={panel.currentDrawKw}
                  limitKw={panel.maxContinuousKw - panel.safetyMarginKw}
                  maxKw={panel.maxContinuousKw}
                />
              )}
            </div>
          </div>

          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={t('loadManagement.editPanel')}
              onClick={() => {
                setEditPanelOpen(true);
              }}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={t('loadManagement.addCircuit')}
              onClick={() => {
                setAddCircuitOpen(true);
              }}
            >
              <Plus className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={t('loadManagement.deletePanel')}
              onClick={() => {
                setDeleteOpen(true);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
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
                    onRefresh={onRefresh}
                  />
                ))}
              </div>
            )}

            {panel.childPanels.map((child) => (
              <PanelNode
                key={child.id}
                siteId={siteId}
                panel={child}
                allPanels={allPanels}
                stations={stations}
                depth={depth + 1}
                onRefresh={onRefresh}
              />
            ))}

            <div className="flex gap-2 pl-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setAddSubPanelOpen(true);
                }}
                className="text-xs"
              >
                <Plus className="h-3 w-3" />
                {t('loadManagement.addSubPanel')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setAddLoadOpen(true);
                }}
                className="text-xs"
              >
                <Plus className="h-3 w-3" />
                {t('loadManagement.addUnmanagedLoad')}
              </Button>
            </div>
          </div>
        )}
      </div>

      <PanelForm
        siteId={siteId}
        panel={panel}
        panels={allPanels}
        open={editPanelOpen}
        onClose={() => {
          setEditPanelOpen(false);
        }}
        onSaved={onRefresh}
      />

      <PanelForm
        siteId={siteId}
        panels={allPanels}
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
  onRefresh,
}: {
  siteId: string;
  panelId: string;
  panelVoltageV: number;
  panelPhases: number;
  circuit: CircuitStatus;
  stations: StationStatus[];
  onRefresh: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [addLoadOpen, setAddLoadOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);

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
      void queryClient.invalidateQueries({ queryKey: ['sites', siteId, 'load-management'] });
      onRefresh();
    },
  });

  return (
    <div className="ml-4 rounded-md border bg-background p-3">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{circuit.name}</p>
            <span className="text-xs text-muted-foreground">{circuit.breakerRatingAmps}A</span>
            {circuit.phaseConnections != null && (
              <Badge variant="outline" className="text-xs px-1.5 py-0">
                {circuit.phaseConnections}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">
              {circuit.maxContinuousKw.toFixed(1)} kW max
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

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t('loadManagement.editCircuit')}
            onClick={() => {
              setEditOpen(true);
            }}
          >
            <Pencil className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t('loadManagement.assignStation')}
            onClick={() => {
              setAssignOpen(true);
            }}
          >
            <Plus className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t('loadManagement.deleteCircuit')}
            onClick={() => {
              setDeleteOpen(true);
            }}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {circuit.stations.length > 0 && (
        <div className="mt-2 max-h-48 overflow-y-auto space-y-1">
          {circuit.stations.map((station) => (
            <div key={station.id} className="flex items-center gap-2 text-xs pl-2">
              <Zap className="h-3 w-3 text-muted-foreground" />
              <span className="font-medium">{station.stationId}</span>
              <Badge
                variant={station.isOnline ? 'success' : 'outline'}
                className="text-xs px-1.5 py-0"
              >
                {station.isOnline ? 'Online' : 'Offline'}
              </Badge>
              {station.hasActiveSession && (
                <span className="text-muted-foreground">{station.currentDrawKw.toFixed(1)} kW</span>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 ml-auto"
                aria-label={t('loadManagement.unassignStation')}
                onClick={() => {
                  unassignMutation.mutate(station.id);
                }}
              >
                <Trash2 className="h-3 w-3 text-muted-foreground" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {circuit.unmanagedLoads.length > 0 && (
        <div className="mt-2 pl-2">
          {circuit.unmanagedLoads.map((load) => (
            <UnmanagedLoadItem key={load.id} siteId={siteId} load={load} onRefresh={onRefresh} />
          ))}
        </div>
      )}

      <div className="mt-2 pl-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setAddLoadOpen(true);
          }}
          className="text-xs h-6"
        >
          <Plus className="h-3 w-3" />
          {t('loadManagement.addUnmanagedLoad')}
        </Button>
      </div>

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
  onRefresh,
}: {
  siteId: string;
  load: UnmanagedLoad;
  onRefresh: () => void;
}): React.JSX.Element {
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
      <span className="text-muted-foreground">({load.estimatedDrawKw.toFixed(1)} kW)</span>
      <Button
        variant="ghost"
        size="icon"
        className="h-5 w-5"
        aria-label="Remove"
        onClick={() => {
          deleteMutation.mutate();
        }}
      >
        <Trash2 className="h-3 w-3 text-muted-foreground" />
      </Button>
    </div>
  );
}
