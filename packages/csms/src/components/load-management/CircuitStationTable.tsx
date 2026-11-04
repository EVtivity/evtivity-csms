// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import type { LoadAllocationStrategy } from '@evtivity/lib/load-allocation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DecimalInput } from '@/components/ui/decimal-input';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { PowerBar } from './PowerBar';

/** A station of the load management reply, as the circuit station rows show it. */
export interface CircuitStationStatus {
  id: string;
  stationId: string;
  currentDrawKw: number;
  allocatedLimitKw: number | null;
  /** The allocated value is power kept for the station as a fixed load, not a limit sent to it. */
  limitReserved?: boolean;
  maxPowerKw: number;
  loadPriority?: number;
  loadMinPowerKw?: number | null;
  rateUnit?: 'A' | 'W';
  isOnline: boolean;
  hasActiveSession: boolean;
}

const PRIORITIES = Array.from({ length: 10 }, (_, i) => i + 1);
const DEFAULT_PRIORITY = 5;
const MIN_POWER_MAX_KW = 1000;
/** Bar scale for a station whose maximum power is unknown. */
const UNKNOWN_MAX_KW = 22;

const HEAD = 'h-8 px-2 text-xs whitespace-nowrap';
const CELL = 'px-2 py-2 text-xs whitespace-nowrap';

/**
 * The stations of one circuit, one line each: status, session, power against
 * the allocated limit, priority, minimum power and limit unit, set in place.
 * The rows never wrap; the panel tree scrolls sideways on narrow screens.
 */
export function CircuitStationTable({
  siteId,
  stations,
  strategy,
  canWrite,
  onRemove,
}: {
  siteId: string;
  stations: CircuitStationStatus[];
  /** The saved allocation strategy: the priority is set only for Priority Based. */
  strategy: LoadAllocationStrategy | undefined;
  canWrite: boolean;
  onRemove: (station: CircuitStationStatus) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className={HEAD}>{t('loadManagement.station')}</TableHead>
          <TableHead className={HEAD}>{t('common.status')}</TableHead>
          <TableHead className={HEAD}>{t('loadManagement.session')}</TableHead>
          <TableHead className={HEAD}>{t('loadManagement.powerDraw')}</TableHead>
          <TableHead className={HEAD}>{t('loadManagement.priority')}</TableHead>
          <TableHead className={HEAD}>{t('loadManagement.minPower')}</TableHead>
          <TableHead className={HEAD}>{t('loadManagement.limitUnit')}</TableHead>
          {canWrite && (
            <TableHead className={HEAD}>
              <span className="sr-only">{t('common.actions')}</span>
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {stations.map((station) => (
          <CircuitStationRow
            key={station.id}
            siteId={siteId}
            station={station}
            strategy={strategy}
            canWrite={canWrite}
            onRemove={() => {
              onRemove(station);
            }}
          />
        ))}
      </TableBody>
    </Table>
  );
}

function CircuitStationRow({
  siteId,
  station,
  strategy,
  canWrite,
  onRemove,
}: {
  siteId: string;
  station: CircuitStationStatus;
  strategy: LoadAllocationStrategy | undefined;
  canWrite: boolean;
  onRemove: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  function invalidate(): void {
    void queryClient.invalidateQueries({ queryKey: ['sites', siteId, 'load-management'] });
  }

  const priorityMutation = useMutation({
    mutationFn: (loadPriority: number) =>
      api.patch(`/v1/sites/${siteId}/stations/${station.id}/load-priority`, { loadPriority }),
    onSuccess: invalidate,
  });

  const minPowerMutation = useMutation({
    mutationFn: (loadMinPowerKw: number | null) =>
      api.patch(`/v1/sites/${siteId}/stations/${station.id}/load-min-power`, { loadMinPowerKw }),
    onSuccess: invalidate,
  });

  const priority = station.loadPriority ?? DEFAULT_PRIORITY;
  const priorityEditable = canWrite && strategy === 'priority_based';
  const writeError = priorityMutation.error ?? minPowerMutation.error;

  return (
    <TableRow data-testid={`circuit-station-${station.stationId}`}>
      <TableCell className={`${CELL} font-medium`}>{station.stationId}</TableCell>
      <TableCell className={CELL}>
        <Badge variant={station.isOnline ? 'success' : 'outline'} className="text-xs px-1.5 py-0">
          {station.isOnline ? t('status.online') : t('status.offline')}
        </Badge>
      </TableCell>
      <TableCell className={CELL}>
        {station.hasActiveSession ? (
          <Badge variant="success" className="text-xs px-1.5 py-0">
            {t('common.active')}
          </Badge>
        ) : (
          <span className="text-muted-foreground">{t('common.na')}</span>
        )}
      </TableCell>
      <TableCell className={CELL}>
        <div className="flex items-center gap-2">
          <div className="w-40">
            <PowerBar
              currentKw={station.currentDrawKw}
              limitKw={station.allocatedLimitKw ?? 0}
              maxKw={
                station.allocatedLimitKw != null
                  ? station.allocatedLimitKw
                  : station.maxPowerKw > 0
                    ? station.maxPowerKw
                    : UNKNOWN_MAX_KW
              }
            />
          </div>
          {station.limitReserved === true && (
            <Badge
              variant="outline"
              className="text-xs px-1.5 py-0"
              title={t('loadManagement.limitReservedNote')}
              data-testid="circuit-station-reserved"
            >
              {t('loadManagement.limitReserved')}
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className={CELL}>
        {priorityEditable ? (
          <Select
            aria-label={t('loadManagement.priorityFor', { stationId: station.stationId })}
            value={priority}
            onChange={(e) => {
              priorityMutation.mutate(Number(e.target.value));
            }}
            className="w-20"
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        ) : (
          <span title={canWrite ? t('loadManagement.priorityStrategyOnly') : undefined}>
            {priority}
            {canWrite && (
              <span className="ml-2 text-muted-foreground">
                {t('loadManagement.priorityStrategyOnly')}
              </span>
            )}
          </span>
        )}
      </TableCell>
      <TableCell className={CELL}>
        {canWrite ? (
          <MinPowerInput
            station={station}
            onSave={(kw) => {
              minPowerMutation.mutate(kw);
            }}
          />
        ) : (
          <span>{station.loadMinPowerKw ?? t('common.na')}</span>
        )}
        {writeError != null && (
          <span className="ml-2 text-destructive">
            {getErrorMessage(writeError, t, 'loadManagement.saveFailed')}
          </span>
        )}
      </TableCell>
      <TableCell className={CELL} data-testid="circuit-station-rate-unit">
        {station.rateUnit ?? 'W'}
      </TableCell>
      {canWrite && (
        <TableCell className={CELL}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('loadManagement.removeStation')}
            onClick={onRemove}
          >
            <Trash2 className="h-3 w-3 text-muted-foreground" />
          </Button>
        </TableCell>
      )}
    </TableRow>
  );
}

/** Saves on blur; a value outside 0 to 1000 kW is put back and not sent. */
function MinPowerInput({
  station,
  onSave,
}: {
  station: CircuitStationStatus;
  onSave: (kw: number | null) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const saved = station.loadMinPowerKw != null ? String(station.loadMinPowerKw) : '';
  const [value, setValue] = useState(saved);
  useEffect(() => {
    setValue(saved);
  }, [saved]);

  function commit(): void {
    if (value === saved) return;
    const kw = value.trim() === '' ? null : Number(value);
    if (kw != null && (!Number.isFinite(kw) || kw < 0 || kw > MIN_POWER_MAX_KW)) {
      setValue(saved);
      return;
    }
    onSave(kw);
  }

  return (
    <DecimalInput
      aria-label={t('loadManagement.minPowerFor', { stationId: station.stationId })}
      value={value}
      onChange={setValue}
      onBlur={commit}
      className="w-24"
    />
  );
}
