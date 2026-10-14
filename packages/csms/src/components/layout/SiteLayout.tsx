// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plug, Circle, Zap, Shield } from 'lucide-react';
import { SaveButton } from '@/components/save-button';
import { ResetButton } from '@/components/reset-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { StationCard, type LayoutStation } from './StationCard';
import { STATUS_COLORS } from '@/lib/chart-theme';
import { formatNumber } from '@/lib/formatting';

interface LoadManagementStation {
  id: string;
  stationId: string;
  currentDrawKw: number;
  allocatedLimitKw: number | null;
  loadPriority: number;
  isOnline: boolean;
  hasActiveSession: boolean;
}

interface LoadManagementResponse {
  config: {
    strategy: string;
    isEnabled: boolean;
  } | null;
  hierarchy: unknown[];
  stations: LoadManagementStation[];
}

interface SiteLayoutProps {
  siteId: string;
}

const COLUMN_COUNT = 5;
const SPACING_X = 200;
const SPACING_Y = 140;
const PADDING = 20;

function autoLayout(stations: LayoutStation[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  stations.forEach((station, i) => {
    const col = i % COLUMN_COUNT;
    const row = Math.floor(i / COLUMN_COUNT);
    positions.set(station.id, {
      x: PADDING + col * SPACING_X,
      y: PADDING + row * SPACING_Y,
    });
  });
  return positions;
}

export function SiteLayout({ siteId }: SiteLayoutProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('sites:write');
  const [pendingPositions, setPendingPositions] = useState<Map<string, { x: number; y: number }>>(
    new Map(),
  );
  const [collapseKey, setCollapseKey] = useState(0);

  const { data: stations, isLoading } = useQuery({
    queryKey: ['sites', siteId, 'layout'],
    queryFn: () => api.get<LayoutStation[]>(`/v1/sites/${siteId}/layout`),
  });

  const { data: loadManagement } = useQuery({
    queryKey: ['sites', siteId, 'load-management'],
    queryFn: () => api.get<LoadManagementResponse>(`/v1/sites/${siteId}/load-management`),
    refetchInterval: 5000,
  });

  const stationPowerMap = useMemo(() => {
    const map = new Map<string, { currentDrawKw: number; allocatedLimitKw: number | null }>();
    if (loadManagement?.stations != null) {
      for (const s of loadManagement.stations) {
        map.set(s.id, { currentDrawKw: s.currentDrawKw, allocatedLimitKw: s.allocatedLimitKw });
      }
    }
    return map;
  }, [loadManagement]);

  const saveMutation = useMutation({
    mutationFn: (positions: Array<{ stationId: string; positionX: number; positionY: number }>) =>
      api.put(`/v1/sites/${siteId}/layout`, { positions }),
    onSuccess: () => {
      setPendingPositions(new Map());
      void queryClient.invalidateQueries({ queryKey: ['sites', siteId, 'layout'] });
    },
  });

  const allZero = stations != null && stations.every((s) => s.positionX === 0 && s.positionY === 0);
  const autoPositions = useMemo(() => (allZero ? autoLayout(stations) : null), [allZero, stations]);

  const resolvedStations = useMemo(() => {
    if (stations == null) return [];
    return stations.map((station) => {
      const pending = pendingPositions.get(station.id);
      const auto = autoPositions?.get(station.id);
      return {
        ...station,
        positionX: pending?.x ?? auto?.x ?? station.positionX,
        positionY: pending?.y ?? auto?.y ?? station.positionY,
      };
    });
  }, [stations, pendingPositions, autoPositions]);

  function handleDragEnd(stationId: string, x: number, y: number): void {
    setPendingPositions((prev) => {
      const next = new Map(prev);
      next.set(stationId, { x, y });
      return next;
    });
  }

  function handleSave(): void {
    const positions = resolvedStations.map((s) => ({
      stationId: s.id,
      positionX: s.positionX,
      positionY: s.positionY,
    }));
    saveMutation.mutate(positions);
    setCollapseKey((k) => k + 1);
  }

  function handleReset(): void {
    setPendingPositions(new Map());
    setCollapseKey((k) => k + 1);
  }

  if (isLoading) {
    return <p className="text-muted-foreground">{t('common.loading')}</p>;
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>{t('sites.stationLayout')}</CardTitle>
        {canWrite && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSave();
            }}
            noValidate
            className="grid grid-cols-2 gap-2 [&>*:last-child:nth-child(odd)]:col-span-2 sm:flex"
          >
            <ResetButton onClick={handleReset} disabled={pendingPositions.size === 0} />
            <SaveButton isPending={saveMutation.isPending} />
          </form>
        )}
      </CardHeader>
      <CardContent>
        {saveMutation.isError && (
          <p className="mb-3 text-sm text-destructive">{getErrorMessage(saveMutation.error, t)}</p>
        )}
        {resolvedStations.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('sites.noStationsAtSite')}</p>
        ) : (
          <div className="relative w-full h-[700px] border-2 border-dashed rounded-lg overflow-auto">
            {resolvedStations.map((station) => {
              const power = stationPowerMap.get(station.id);
              return (
                <StationCard
                  key={station.id}
                  station={station}
                  onDragEnd={handleDragEnd}
                  currentDrawKw={power?.currentDrawKw}
                  allocatedLimitKw={power?.allocatedLimitKw}
                  collapseKey={collapseKey}
                />
              );
            })}
            {loadManagement != null && loadManagement.stations.length > 0 && (
              <div className="absolute top-3 right-3 z-50 rounded-lg border bg-card/80 backdrop-blur-xs p-3 space-y-1.5 text-xs shadow-xs max-w-[180px]">
                <div className="flex items-center gap-1.5 font-semibold text-sm">
                  <Zap className="h-3.5 w-3.5" />
                  {t('sites.powerDraw')}
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('sites.layoutDraw')}</span>
                  <span className="font-medium">
                    {formatNumber(
                      loadManagement.stations.reduce((sum, s) => sum + s.currentDrawKw, 0),
                      1,
                    )}{' '}
                    kW
                  </span>
                </div>
                {loadManagement.config != null && loadManagement.config.isEnabled && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      {t('loadManagement.allocationStrategy')}
                    </span>
                    <span className="font-medium">
                      {loadManagement.config.strategy === 'priority_based'
                        ? t('loadManagement.priorityBased')
                        : t('loadManagement.equalShare')}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="relative inline-flex h-2 w-2">
              <span className="absolute inset-0 rounded-full bg-success animate-ping opacity-75" />
              <span className="relative h-2 w-2 rounded-full bg-success" />
            </span>{' '}
            {t('status.online')}
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-muted-foreground inline-block" />{' '}
            {t('status.offline')}
          </span>
          <span className="flex items-center gap-1">
            <Plug className="h-3.5 w-3.5 text-success" /> {t('status.available')}
          </span>
          <span className="flex items-center gap-1">
            <span className="relative inline-flex h-3 w-3">
              <span
                className="absolute inset-0 rounded-full animate-ping opacity-75"
                style={{ backgroundColor: STATUS_COLORS.occupied }}
              />
              <Circle
                className="relative h-3 w-3"
                style={{ color: STATUS_COLORS.occupied }}
                fill={STATUS_COLORS.occupied}
              />
            </span>{' '}
            {t('status.charging')}
          </span>
          <span className="flex items-center gap-1">
            <Circle
              className="h-3 w-3"
              style={{ color: STATUS_COLORS.reserved }}
              fill={STATUS_COLORS.reserved}
            />{' '}
            {t('status.reserved')}
          </span>
          <span className="flex items-center gap-1">
            <Circle className="h-3 w-3 text-destructive" fill={STATUS_COLORS.faulted} />{' '}
            {t('status.faulted')}
          </span>
          <span className="flex items-center gap-1">
            <Circle className="h-3 w-3 text-muted-foreground" fill={STATUS_COLORS.unavailable} />{' '}
            {t('status.unavailable')}
          </span>
          <span className="text-muted-foreground/40">|</span>
          <span className="flex items-center gap-0.5 text-muted-foreground">
            <Shield className="h-3 w-3" />0 {t('stations.sp0')}
          </span>
          <span className="flex items-center gap-0.5 text-link">
            <Shield className="h-3 w-3" />1 {t('stations.sp1')}
          </span>
          <span className="flex items-center gap-0.5 text-success">
            <Shield className="h-3 w-3" />2 {t('stations.sp2')}
          </span>
          <span className="flex items-center gap-0.5 text-warning">
            <Shield className="h-3 w-3" />3 {t('stations.sp3')}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
