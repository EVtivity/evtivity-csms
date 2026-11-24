// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { TableCell, TableRow } from '@/components/ui/table';
import { EditIconButton } from '@/components/edit-icon-button';
import { api } from '@/lib/api';
import { formatNumberUpTo } from '@/lib/formatting';
import { UnitBudgetDialog } from './UnitBudgetDialog';

/** One charging EVSE limit of the load management reply. */
export interface EvseLimitView {
  evseNumber: number;
  unitId: string | null;
  kind: 'ac' | 'dc';
  limitA: number | null;
  limitKw: number;
  paused: boolean;
}

export interface UnitBudgetValue {
  kind: 'ac' | 'dc';
  maxCurrentA: number | null;
  phases: number | null;
  maxPowerKw: number | null;
}

/** A unit of `GET /v1/sites/:id/stations/:stationId/unit-budgets`. */
export interface UnitBudgetUnit {
  unitId: string;
  name: string;
  evseNumbers: number[];
  chargingKind: 'ac' | 'dc' | 'mixed' | null;
  budget: UnitBudgetValue | null;
}

interface UnitBudgetsReply {
  stationId: string;
  defaultPhases: number | null;
  units: UnitBudgetUnit[];
}

const CELL = 'px-2 py-1.5 text-xs whitespace-nowrap';

export function unitBudgetsQueryKey(siteId: string, stationId: string): unknown[] {
  return ['sites', siteId, 'load-management', 'unit-budgets', stationId];
}

/**
 * The units of a station that groups its EVSEs in units, one sub-row each
 * under the station row: the unit budget and the limits of its charging EVSEs,
 * with Edit (loadManagement:write) opening the unit budget dialog.
 */
export function StationUnitBudgetRows({
  siteId,
  stationId,
  evseLimits,
  colSpan,
  canWrite,
}: {
  siteId: string;
  stationId: string;
  evseLimits: readonly EvseLimitView[];
  colSpan: number;
  canWrite: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<UnitBudgetUnit | null>(null);
  const { data, isError } = useQuery({
    queryKey: unitBudgetsQueryKey(siteId, stationId),
    queryFn: () =>
      api.get<UnitBudgetsReply>(`/v1/sites/${siteId}/stations/${stationId}/unit-budgets`),
    staleTime: 30_000,
  });

  if (isError) {
    return (
      <TableRow>
        <TableCell colSpan={colSpan} className={`${CELL} pl-6 text-destructive`}>
          {t('loadManagement.unitBudgetLoadFailed')}
        </TableCell>
      </TableRow>
    );
  }
  if (data == null || data.units.length === 0) return null;

  function budgetText(budget: UnitBudgetValue | null): string {
    if (budget == null) return t('loadManagement.unitBudgetNone');
    if (budget.kind === 'dc') {
      return t('loadManagement.unitBudgetDc', { kw: formatNumberUpTo(budget.maxPowerKw ?? 0, 2) });
    }
    return budget.phases === 1
      ? t('loadManagement.unitBudgetAcOnePhase', {
          amps: formatNumberUpTo(budget.maxCurrentA ?? 0, 1),
        })
      : t('loadManagement.unitBudgetAcThreePhase', {
          amps: formatNumberUpTo(budget.maxCurrentA ?? 0, 1),
        });
  }

  function limitText(limit: EvseLimitView): string {
    const value = limit.paused
      ? t('loadManagement.unitBudgetPaused')
      : limit.limitA != null
        ? `${formatNumberUpTo(limit.limitA, 1)} A`
        : `${formatNumberUpTo(limit.limitKw, 2)} kW`;
    return t('loadManagement.unitBudgetEvseLimit', { evse: limit.evseNumber, limit: value });
  }

  return (
    <>
      {data.units.map((unit) => {
        const limits = evseLimits.filter((l) => l.unitId === unit.unitId);
        return (
          <TableRow key={unit.unitId} data-testid={`unit-budget-row-${unit.unitId}`}>
            <TableCell colSpan={colSpan} className={`${CELL} pl-6`}>
              <div className="flex items-center gap-3">
                <span className="font-medium">{unit.name}</span>
                {unit.chargingKind === 'mixed' ? (
                  <span className="text-muted-foreground">
                    {t('loadManagement.unitBudgetMixed')}
                  </span>
                ) : (
                  <Badge
                    variant={unit.budget == null ? 'outline' : 'secondary'}
                    className="text-xs px-1.5 py-0"
                    data-testid="unit-budget-value"
                  >
                    {budgetText(unit.budget)}
                  </Badge>
                )}
                {limits.length > 0 && (
                  <span className="text-muted-foreground" data-testid="unit-budget-limits">
                    {limits.map(limitText).join(', ')}
                  </span>
                )}
                {canWrite && unit.chargingKind !== 'mixed' && (
                  <EditIconButton
                    title={t('loadManagement.unitBudgetEditFor', { unit: unit.name })}
                    onClick={() => {
                      setEditing(unit);
                    }}
                  />
                )}
              </div>
              {editing?.unitId === unit.unitId && (
                <UnitBudgetDialog
                  siteId={siteId}
                  stationId={stationId}
                  unit={editing}
                  defaultPhases={data.defaultPhases}
                  open
                  onClose={() => {
                    setEditing(null);
                  }}
                />
              )}
            </TableCell>
          </TableRow>
        );
      })}
    </>
  );
}
