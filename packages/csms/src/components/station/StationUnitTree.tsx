// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Collapsible } from '@/components/ui/collapsible';
import { StationStatusBadge } from '@/components/StationStatusBadge';
import { StationOnlineBadge } from '@/components/StationOnlineBadge';
import { groupEvsesByUnit, unitStatus, type StationUnit } from '@/lib/station-units';

interface TreeEvse {
  evseId: number;
  unitId?: string | null;
  connectors: { status: string; retiredAt?: string | null }[];
  retiredAt?: string | null;
}

interface StationUnitTreeProps<E extends TreeEvse> {
  evses: E[];
  units: StationUnit[];
  station: { status: string; statusReason: string | null; isOnline: boolean };
  renderEvse: (evse: E) => React.JSX.Element;
}

const GRID = 'grid grid-cols-1 md:grid-cols-2 gap-4';

/**
 * The Connectors tab body: the station's EVSE cards in one grid, or, for a
 * station with units (a master box and its extenders), one section per unit
 * with its EVSE cards, then the EVSEs without a unit. A unit shows the station
 * state while the station is offline or unavailable as a whole.
 */
export function StationUnitTree<E extends TreeEvse>({
  evses,
  units,
  station,
  renderEvse,
}: StationUnitTreeProps<E>): React.JSX.Element {
  const { t } = useTranslation();
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
  return (
    <div className="space-y-3" data-testid="station-unit-tree">
      {grouped.units.map(({ unit, evses: unitEvses }) => (
        <Collapsible
          key={unit.id}
          title={unit.name}
          defaultOpen
          data-testid={`station-unit-${unit.id}`}
          summary={
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">
                {t('stationUnits.evseCount', { count: unitEvses.length })}
              </span>
              {badge(unitEvses)}
            </span>
          }
        >
          {unitEvses.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('stationUnits.noEvses')}</p>
          ) : (
            <div className={GRID}>{unitEvses.map(renderEvse)}</div>
          )}
        </Collapsible>
      ))}
      {grouped.unassigned.length > 0 && (
        <Collapsible
          title={t('stationUnits.evsesWithoutUnit')}
          defaultOpen
          data-testid="station-unit-unassigned"
          summary={
            <span className="text-muted-foreground">
              {t('stationUnits.evseCount', { count: grouped.unassigned.length })}
            </span>
          }
        >
          <div className={GRID}>{grouped.unassigned.map(renderEvse)}</div>
        </Collapsible>
      )}
    </div>
  );
}
