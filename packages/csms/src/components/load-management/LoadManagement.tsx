// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Checkbox } from '@/components/ui/checkbox';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { LoadAllocationStrategy } from '@evtivity/lib/load-allocation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CreateButton } from '@/components/create-button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { SaveButton } from '@/components/save-button';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { useFeatureFlags } from '@/hooks/use-feature-flags';
import { api } from '@/lib/api';
import { PanelTree } from './PanelTree';
import { PanelForm } from './PanelForm';
import { TransformerForm } from './TransformerForm';
import { EnergyAssetsCard } from './EnergyAssetsCard';
import {
  asList,
  energyAssetsQueryKey,
  transformersQueryKey,
  type EnergyAssetItem,
  type TransformerItem,
} from './load-management-types';
import { useHasPermission } from '@/lib/auth';
import { TabPanel } from '@/components/ui/tab-panel';
import { EmptyState } from '@/components/ui/content-state';
import { formatNumber } from '@/lib/formatting';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { getErrorMessage } from '@/lib/error-message';

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
  type?: 'panel' | 'circuit' | 'transformer';
  transformerKind?: 'service' | 'step_down';
  supplyCreditKw?: number;
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
  loadMinPowerKw: number | null;
  rateUnit: 'A' | 'W';
  /** The allocated value is power kept for the station as a fixed load, not a limit sent to it. */
  limitReserved?: boolean;
  isOnline: boolean;
  hasActiveSession: boolean;
}

interface LoadManagementConfig {
  strategy: LoadAllocationStrategy;
  isEnabled: boolean;
  /** Minutes before a departure the depot plan aims to finish (0 to 180). */
  departureBufferMinutes?: number;
}

const BUFFER_MAX_MINUTES = 180;
const DEFAULT_BUFFER_MINUTES = 30;

/** The validation error of the Finish Buffer field, or null. */
export function finishBufferError(value: string): 'required' | 'range' | null {
  if (value.trim() === '') return 'required';
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > BUFFER_MAX_MINUTES) return 'range';
  return null;
}

interface LoadManagementData {
  config: LoadManagementConfig | null;
  hierarchy: PanelStatus[];
  stations: StationStatus[];
  /** The installation accepts simulated battery and solar readings. */
  simulatedEnergyAssetsAllowed?: boolean;
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
  const timezone = useUserTimezone();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [strategy, setStrategy] = useState<LoadAllocationStrategy>('equal_share');
  const [isEnabled, setIsEnabled] = useState(false);
  const [bufferMinutes, setBufferMinutes] = useState(String(DEFAULT_BUFFER_MINUTES));
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const {
    flags: { fleetChargingEnabled },
  } = useFeatureFlags();
  const [showHistory, setShowHistory] = useState(false);
  const [addPanelOpen, setAddPanelOpen] = useState(false);
  const [addTransformerOpen, setAddTransformerOpen] = useState(false);
  const canWrite = useHasPermission('loadManagement:write');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['sites', siteId, 'load-management'],
    queryFn: () => api.get<LoadManagementData>(`/v1/sites/${siteId}/load-management`),
    refetchInterval: 5000,
  });

  const transformersQuery = useQuery({
    queryKey: transformersQueryKey(siteId),
    queryFn: () => api.get<TransformerItem[]>(`/v1/sites/${siteId}/transformers`),
    refetchInterval: 5000,
  });

  const energyAssetsQuery = useQuery({
    queryKey: energyAssetsQueryKey(siteId),
    queryFn: () => api.get<EnergyAssetItem[]>(`/v1/sites/${siteId}/energy-assets`),
    refetchInterval: 5000,
  });

  const { data: history } = useQuery({
    queryKey: ['sites', siteId, 'load-management', 'history'],
    queryFn: () =>
      api.get<AllocationLogEntry[]>(`/v1/sites/${siteId}/load-management/history?limit=20`),
    enabled: showHistory,
  });

  // Sync the form only when the saved values change: the query refetches every
  // 5 seconds with a new config object, which reset unsaved edits.
  const savedStrategy = data?.config?.strategy;
  const savedIsEnabled = data?.config?.isEnabled;
  const savedBuffer = data?.config?.departureBufferMinutes;
  useEffect(() => {
    if (savedStrategy != null) setStrategy(savedStrategy);
    if (savedIsEnabled != null) setIsEnabled(savedIsEnabled);
    if (savedBuffer != null) setBufferMinutes(String(savedBuffer));
  }, [savedStrategy, savedIsEnabled, savedBuffer]);

  const saveMutation = useMutation({
    mutationFn: async (body: {
      strategy: string;
      isEnabled: boolean;
      departureBufferMinutes?: number;
    }) => {
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

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (strategy === 'departure_aware' && finishBufferError(bufferMinutes) != null) return;
    saveMutation.mutate({
      strategy,
      isEnabled,
      ...(strategy === 'departure_aware' ? { departureBufferMinutes: Number(bufferMinutes) } : {}),
    });
  }

  function handleRefresh(): void {
    void queryClient.invalidateQueries({ queryKey: ['sites', siteId, 'load-management'] });
  }

  if (isLoading || isError) {
    return (
      <TabPanel
        title={t('sites.loadManagement')}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  const hierarchy = data?.hierarchy ?? [];
  const stations = data?.stations ?? [];
  const transformers = asList<TransformerItem>(transformersQuery.data);
  const energyAssets = asList<EnergyAssetItem>(energyAssetsQuery.data);

  return (
    <div className="space-y-6">
      {/* Configuration Card */}
      <TabPanel title={t('sites.loadManagement')}>
        <form onSubmit={handleSave} noValidate className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="strategy">{t('loadManagement.allocationStrategy')}</Label>
            <Select
              id="strategy"
              value={strategy}
              onChange={(e) => {
                setStrategy(e.target.value as LoadAllocationStrategy);
              }}
            >
              <option value="equal_share">{t('loadManagement.equalShare')}</option>
              <option value="priority_based">{t('loadManagement.priorityBased')}</option>
              {(fleetChargingEnabled || savedStrategy === 'departure_aware') && (
                <option value="departure_aware">{t('loadManagement.departureAware')}</option>
              )}
            </Select>
            {strategy === 'departure_aware' && (
              <p className="text-xs text-muted-foreground">
                {t('loadManagement.departureAwareHelp')}
              </p>
            )}
          </div>
          {strategy === 'departure_aware' && (
            <div className="grid gap-2">
              <Label htmlFor="lm-finish-buffer">{t('loadManagement.finishBuffer')}</Label>
              <Input
                id="lm-finish-buffer"
                type="number"
                inputMode="numeric"
                value={bufferMinutes}
                onChange={(e) => {
                  setBufferMinutes(e.target.value);
                  saveMutation.reset();
                }}
                className={
                  hasSubmitted && finishBufferError(bufferMinutes) != null
                    ? 'border-destructive'
                    : ''
                }
              />
              <p className="text-xs text-muted-foreground">
                {t('loadManagement.finishBufferHelp')}
              </p>
              {hasSubmitted && finishBufferError(bufferMinutes) != null && (
                <p className="text-sm text-destructive">
                  {finishBufferError(bufferMinutes) === 'required'
                    ? t('validation.required')
                    : t('loadManagement.finishBufferRange')}
                </p>
              )}
            </div>
          )}
          <div className="flex justify-end items-center gap-2">
            <Checkbox
              id="lm-enabled"
              checked={isEnabled}
              onChange={(e) => {
                setIsEnabled(e.target.checked);
              }}
            />
            <Label htmlFor="lm-enabled">{t('loadManagement.enableLoadManagement')}</Label>
          </div>
          {isEnabled && (
            <Alert variant="warning" data-testid="load-management-safety-notice">
              <AlertTriangle />
              <div>
                <AlertTitle>{t('loadManagement.electricalSafetyTitle')}</AlertTitle>
                <AlertDescription>{t('loadManagement.electricalSafetyBody')}</AlertDescription>
              </div>
            </Alert>
          )}
          <SaveButton isPending={saveMutation.isPending} />
          {saveMutation.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(saveMutation.error, t, 'loadManagement.saveFailed')}
            </p>
          )}
        </form>
      </TabPanel>

      {/* Electrical Infrastructure Card */}
      <TabPanel
        title={t('loadManagement.electricalInfrastructure')}
        actions={
          canWrite ? (
            <div className="flex flex-wrap gap-2">
              <CreateButton
                label={t('loadManagement.addTransformer')}
                variant="outline"
                onClick={() => {
                  setAddTransformerOpen(true);
                }}
              />
              <CreateButton
                label={t('loadManagement.addPanel')}
                onClick={() => {
                  setAddPanelOpen(true);
                }}
              />
            </div>
          ) : undefined
        }
      >
        <PanelTree
          siteId={siteId}
          hierarchy={hierarchy}
          stations={stations}
          transformers={transformers}
          canWrite={canWrite}
          strategy={savedStrategy}
          onRefresh={handleRefresh}
        />
        {hierarchy.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">{t('loadManagement.minPowerHint')}</p>
        )}
      </TabPanel>

      <EnergyAssetsCard
        siteId={siteId}
        assets={energyAssets}
        transformers={transformers}
        panels={hierarchy}
        simulatedAllowed={data?.simulatedEnergyAssetsAllowed === true}
        canWrite={canWrite}
        isLoading={energyAssetsQuery.isLoading}
        isError={energyAssetsQuery.isError}
        onRetry={() => {
          void energyAssetsQuery.refetch();
        }}
      />

      {/* Allocations Card */}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>{t('loadManagement.allocations')}</CardTitle>
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
                        {formatDateTime(entry.createdAt, timezone)}
                      </span>
                      <Badge variant="outline">
                        {entry.strategy === 'priority_based'
                          ? t('loadManagement.priorityBased')
                          : entry.strategy === 'departure_aware'
                            ? t('loadManagement.departureAware')
                            : t('loadManagement.equalShare')}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      <span>
                        {t('loadManagement.historyDraw', {
                          kw: formatNumber(entry.totalDrawKw, 1),
                        })}
                      </span>
                      <span>
                        {t('loadManagement.historyAvailable', {
                          kw: formatNumber(entry.availableKw, 1),
                        })}
                      </span>
                      <span>
                        {t('loadManagement.historyLimit', {
                          kw: formatNumber(entry.siteLimitKw, 1),
                        })}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {(entry.allocations as Array<{ stationId: string; allocatedKw: number }>)
                        .map((a) => `${a.stationId}: ${formatNumber(a.allocatedKw, 1)} kW`)
                        .join(' | ')}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState>{t('loadManagement.noAllocations')}</EmptyState>
            )}
          </CardContent>
        )}
      </Card>

      {canWrite && (
        <>
          <PanelForm
            siteId={siteId}
            panels={hierarchy}
            transformers={transformers}
            open={addPanelOpen}
            onClose={() => {
              setAddPanelOpen(false);
            }}
            onSaved={handleRefresh}
          />
          <TransformerForm
            siteId={siteId}
            panels={hierarchy}
            open={addTransformerOpen}
            onClose={() => {
              setAddTransformerOpen(false);
            }}
            onSaved={() => {
              void queryClient.invalidateQueries({ queryKey: ['sites', siteId] });
            }}
          />
        </>
      )}
    </div>
  );
}
