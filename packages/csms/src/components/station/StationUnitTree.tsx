// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StationStatusBadge } from '@/components/StationStatusBadge';
import { StationOnlineBadge } from '@/components/StationOnlineBadge';
import { AddIconButton } from '@/components/add-icon-button';
import { EditIconButton } from '@/components/edit-icon-button';
import { RemoveIconButton } from '@/components/remove-icon-button';
import { MinusIconButton } from '@/components/minus-icon-button';
import { useHasPermission } from '@/lib/auth';
import { groupEvsesByUnit, unitStatus, type StationUnit } from '@/lib/station-units';
import {
  StationUnitAssignDialog,
  StationUnitDeleteDialog,
  StationUnitNameDialog,
  StationUnitRemoveEvseDialog,
  type UnitNameDraft,
} from './station-unit-actions';

interface TreeEvse {
  evseId: number;
  unitId?: string | null;
  connectors: { status: string; retiredAt?: string | null }[];
  retiredAt?: string | null;
}

interface StationUnitTreeProps<E extends TreeEvse> {
  stationId: string;
  evses: E[];
  units: StationUnit[];
  station: { status: string; statusReason: string | null; isOnline: boolean };
  renderEvse: (evse: E) => React.JSX.Element;
}

const GRID = 'grid grid-cols-1 md:grid-cols-2 gap-4';
// The EVSE card style, so a unit card reads as the card of one charger box.
const CARD = 'rounded-lg border p-4 space-y-3';
const HEADER = 'flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b';

/**
 * The EVSE & Connectors tab body: the station's EVSE cards in one grid, or, for a
 * station with units (a master box and its extenders), one card per unit
 * holding its EVSE cards, then a card of the EVSEs without a unit while there
 * are any. A unit shows the station state while the station is offline or
 * unavailable as a whole. With `stations:write` each unit card can assign an
 * EVSE, remove one of its EVSEs, rename the unit and delete it.
 */
export function StationUnitTree<E extends TreeEvse>({
  stationId,
  evses,
  units,
  station,
  renderEvse,
}: StationUnitTreeProps<E>): React.JSX.Element {
  const { t } = useTranslation();
  const canWrite = useHasPermission('stations:write');
  const [renaming, setRenaming] = useState<UnitNameDraft | null>(null);
  const [deleting, setDeleting] = useState<StationUnit | null>(null);
  const [assigning, setAssigning] = useState<StationUnit | null>(null);
  const [removing, setRemoving] = useState<StationUnit | null>(null);
  if (units.length === 0) {
    return <div className={GRID}>{evses.map(renderEvse)}</div>;
  }
  const grouped = groupEvsesByUnit(evses, units);
  const badge = (group: E[]): React.JSX.Element => {
    if (!station.isOnline) return <StationOnlineBadge isOnline={false} size="sm" />;
    const statuses = group
      .filter((e) => e.retiredAt == null)
      .flatMap((e) => e.connectors.filter((c) => c.retiredAt == null).map((c) => c.status));
    return <StationStatusBadge status={unitStatus(statuses, station)} size="sm" />;
  };
  // Counts the EVSEs in service; retired ones still show (to restore them)
  // but are named apart, as the driver views and the dashboard leave them out.
  const count = (group: E[]): React.JSX.Element => {
    const retired = group.filter((e) => e.retiredAt != null).length;
    return (
      <span className="text-sm text-muted-foreground">
        {t('stationUnits.evseCount', { count: group.length - retired })}
        {retired > 0 && ` · ${t('stationUnits.retiredCount', { count: retired })}`}
      </span>
    );
  };
  return (
    <div className="space-y-4" data-testid="station-unit-tree">
      {grouped.units.map(({ unit, evses: unitEvses }) => (
        <section
          key={unit.id}
          className={CARD}
          data-testid={`station-unit-${unit.id}`}
          aria-label={unit.name}
        >
          <div className={HEADER}>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">{unit.name}</h3>
              {badge(unitEvses)}
              {count(unitEvses)}
              {unit.serialNumber != null && (
                <span className="text-xs text-muted-foreground">
                  {t('stationUnits.serialNumberValue', { value: unit.serialNumber })}
                </span>
              )}
              {unit.ipAddress != null && (
                <span className="text-xs text-muted-foreground">
                  {t('stationUnits.ipAddressValue', { value: unit.ipAddress })}
                </span>
              )}
            </div>
            {canWrite && (
              <div className="flex flex-wrap items-center gap-1">
                <AddIconButton
                  title={t('stationUnits.assignEvse')}
                  disabled={unitEvses.length === evses.length}
                  onClick={() => {
                    setAssigning(unit);
                  }}
                />
                <MinusIconButton
                  title={t('stationUnits.removeEvse')}
                  disabled={unitEvses.length === 0}
                  onClick={() => {
                    setRemoving(unit);
                  }}
                />
                <EditIconButton
                  title={t('stationUnits.editUnit')}
                  onClick={() => {
                    setRenaming({
                      id: unit.id,
                      name: unit.name,
                      serialNumber: unit.serialNumber ?? '',
                      ipAddress: unit.ipAddress ?? '',
                    });
                  }}
                />
                <RemoveIconButton
                  title={t('stationUnits.deleteUnit')}
                  onClick={() => {
                    setDeleting(unit);
                  }}
                />
              </div>
            )}
          </div>
          {unitEvses.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('stationUnits.noEvses')}</p>
          ) : (
            <div className={GRID}>{unitEvses.map(renderEvse)}</div>
          )}
        </section>
      ))}
      {grouped.unassigned.length > 0 && (
        <section
          className={CARD}
          data-testid="station-unit-unassigned"
          aria-label={t('stationUnits.evsesWithoutUnit')}
        >
          <div className={HEADER}>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">{t('stationUnits.evsesWithoutUnit')}</h3>
              {count(grouped.unassigned)}
            </div>
          </div>
          <div className={GRID}>{grouped.unassigned.map(renderEvse)}</div>
        </section>
      )}
      {canWrite && (
        <>
          <StationUnitNameDialog
            stationId={stationId}
            draft={renaming}
            onDraftChange={setRenaming}
          />
          <StationUnitDeleteDialog
            stationId={stationId}
            unit={deleting}
            onClose={() => {
              setDeleting(null);
            }}
          />
          <StationUnitAssignDialog
            stationId={stationId}
            unit={assigning}
            units={units}
            evses={evses}
            onClose={() => {
              setAssigning(null);
            }}
          />
          <StationUnitRemoveEvseDialog
            stationId={stationId}
            unit={removing}
            evses={evses}
            onClose={() => {
              setRemoving(null);
            }}
          />
        </>
      )}
    </div>
  );
}
