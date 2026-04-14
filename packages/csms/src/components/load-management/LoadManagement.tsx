// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { SaveButton } from '@/components/save-button';
import { Pagination } from '@/components/ui/pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { PowerBar } from './PowerBar';
import { PanelTree } from './PanelTree';
import { PanelForm } from './PanelForm';

interface CircuitStation {
  id: string;
  stationId: string;
  currentDrawKw: number;
  allocatedLimitKw: number | null;
  maxPowerKw: number;
  isOnline: boolean;
  hasActiveSession: boolean;
}

interface UnmanagedLoad {
  id: number;
  name: string;
  estimatedDrawKw: number;
}

interface CircuitStatus {
  id: string;
  name: string;
  breakerRatingAmps: number;
  maxContinuousKw: number;
  currentDrawKw: number;
  availableKw: number;
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

interface LoadManagementConfig {
  strategy: 'equal_share' | 'priority_based';
  isEnabled: boolean;
}

interface LoadManagementData {
  config: LoadManagementConfig | null;
  hierarchy: PanelStatus[];
  stations: StationStatus[];
}

interface AllocationLogEntry {
  id: number;
  siteLimitKw: number;
  totalDrawKw: number;
  availableKw: number;
  strategy: string;
  allocations: Array<{ stationId: string; allocatedKw: number; currentDrawKw: number }>;
  createdAt: string;
}

interface LoadManagementProps {
  siteId: string;
}

export function LoadManagement({ siteId }: LoadManagementProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [strategy, setStrategy] = useState<'equal_share' | 'priority_based'>('equal_share');
  const [isEnabled, setIsEnabled] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [addPanelOpen, setAddPanelOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['sites', siteId, 'load-management'],
    queryFn: () => api.get<LoadManagementData>(`/v1/sites/${siteId}/load-management`),
    refetchInterval: 5000,
  });

  const { data: history } = useQuery({
    queryKey: ['sites', siteId, 'load-management', 'history'],
    queryFn: () =>
      api.get<AllocationLogEntry[]>(`/v1/sites/${siteId}/load-management/history?limit=20`),
    enabled: showHistory,
  });

  useEffect(() => {
    if (data?.config != null) {
      setStrategy(data.config.strategy);
      setIsEnabled(data.config.isEnabled);
    }
  }, [data?.config]);

  const saveMutation = useMutation({
    mutationFn: async (body: { strategy: string; isEnabled: boolean }) => {
      const [result] = await Promise.all([
        api.put(`/v1/sites/${siteId}/load-management`, body),
        new Promise((r) => setTimeout(r, 500)),
      ]);
      return result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sites', siteId, 'load-management'] });
    },
  });

  const priorityMutation = useMutation({
    mutationFn: ({ stationId, loadPriority }: { stationId: string; loadPriority: number }) =>
      api.patch(`/v1/sites/${siteId}/stations/${stationId}/load-priority`, { loadPriority }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sites', siteId, 'load-management'] });
    },
  });

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    saveMutation.mutate({ strategy, isEnabled });
  }

  function handleRefresh(): void {
    void queryClient.invalidateQueries({ queryKey: ['sites', siteId, 'load-management'] });
  }

  if (isLoading) {
    return <p className="text-muted-foreground">{t('common.loading')}</p>;
  }

  const hierarchy = data?.hierarchy ?? [];
  const stations = data?.stations ?? [];

  return (
    <div className="space-y-6">
      {/* Configuration Card */}
      <Card>
        <CardHeader>
          <CardTitle>{t('loadManagement.configuration')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="strategy">{t('loadManagement.allocationStrategy')}</Label>
              <Select
                id="strategy"
                value={strategy}
                onChange={(e) => {
                  setStrategy(e.target.value as 'equal_share' | 'priority_based');
                }}
                className="h-9"
              >
                <option value="equal_share">{t('loadManagement.equalShare')}</option>
                <option value="priority_based">{t('loadManagement.priorityBased')}</option>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="lm-enabled"
                type="checkbox"
                checked={isEnabled}
                onChange={(e) => {
                  setIsEnabled(e.target.checked);
                }}
                className="h-4 w-4"
              />
              <Label htmlFor="lm-enabled">{t('loadManagement.enableLoadManagement')}</Label>
            </div>
            <SaveButton isPending={saveMutation.isPending} />
          </form>
        </CardContent>
      </Card>

      {/* Electrical Infrastructure Card */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('loadManagement.electricalInfrastructure')}</CardTitle>
          <Button
            size="sm"
            onClick={() => {
              setAddPanelOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            {t('loadManagement.addPanel')}
          </Button>
        </CardHeader>
        <CardContent>
          <PanelTree
            siteId={siteId}
            hierarchy={hierarchy}
            stations={stations}
            onRefresh={handleRefresh}
          />
        </CardContent>
      </Card>

      {/* Station Allocations Card */}
      {stations.length > 0 && (
        <StationAllocationsTable
          stations={stations}
          strategy={strategy}
          priorityMutation={priorityMutation}
        />
      )}

      {/* Allocation History Card */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('loadManagement.allocationHistory')}</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setShowHistory(!showHistory);
            }}
          >
            {showHistory ? t('loadManagement.hide') : t('loadManagement.show')}
          </Button>
        </CardHeader>
        {showHistory && (
          <CardContent>
            {history != null && history.length > 0 ? (
              <div className="space-y-3">
                {history.map((entry) => (
                  <div key={entry.id} className="border rounded p-3 text-sm space-y-1">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        {new Date(entry.createdAt).toLocaleString()}
                      </span>
                      <Badge variant="outline">{entry.strategy}</Badge>
                    </div>
                    <div className="flex gap-4">
                      <span>Draw: {entry.totalDrawKw.toFixed(1)} kW</span>
                      <span>Available: {entry.availableKw.toFixed(1)} kW</span>
                      <span>Limit: {entry.siteLimitKw.toFixed(1)} kW</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {(entry.allocations as Array<{ stationId: string; allocatedKw: number }>)
                        .map((a) => `${a.stationId}: ${a.allocatedKw.toFixed(1)} kW`)
                        .join(' | ')}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('loadManagement.noHistory')}</p>
            )}
          </CardContent>
        )}
      </Card>

      <PanelForm
        siteId={siteId}
        panels={hierarchy}
        open={addPanelOpen}
        onClose={() => {
          setAddPanelOpen(false);
        }}
        onSaved={handleRefresh}
      />
    </div>
  );
}

function StationAllocationsTable({
  stations,
  strategy,
  priorityMutation,
}: {
  stations: StationStatus[];
  strategy: string;
  priorityMutation: { mutate: (data: { stationId: string; loadPriority: number }) => void };
}): React.JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const limit = 10;

  const totalPages = Math.max(1, Math.ceil(stations.length / limit));
  const paginatedStations = useMemo(
    () => stations.slice((page - 1) * limit, page * limit),
    [stations, page],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('loadManagement.stationAllocations')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('loadManagement.station')}</TableHead>
                <TableHead>{t('loadManagement.priority')}</TableHead>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead>{t('loadManagement.session')}</TableHead>
                <TableHead className="min-w-[200px]">{t('loadManagement.powerDraw')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedStations.map((station) => (
                <TableRow key={station.id}>
                  <TableCell className="font-medium">{station.stationId}</TableCell>
                  <TableCell>
                    <Select
                      aria-label={`Priority for ${station.stationId}`}
                      value={station.loadPriority}
                      onChange={(e) => {
                        priorityMutation.mutate({
                          stationId: station.id,
                          loadPriority: Number(e.target.value),
                        });
                      }}
                      className="w-20"
                      disabled={strategy !== 'priority_based'}
                    >
                      {Array.from({ length: 10 }, (_, i) => i + 1).map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Badge variant={station.isOnline ? 'success' : 'outline'}>
                      {station.isOnline ? 'Online' : 'Offline'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {station.hasActiveSession ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <span className="text-muted-foreground">--</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <PowerBar
                      currentKw={station.currentDrawKw}
                      limitKw={station.allocatedLimitKw ?? 0}
                      maxKw={
                        station.allocatedLimitKw != null
                          ? station.allocatedLimitKw
                          : station.maxPowerKw > 0
                            ? station.maxPowerKw
                            : 22
                      }
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {totalPages > 1 && (
          <div className="mt-4">
            <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
