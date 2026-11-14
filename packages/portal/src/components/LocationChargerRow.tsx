// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Plug } from 'lucide-react';
import { PortCard, PortGrid } from '@/components/PortCard';
import { chargerUnitQuery } from '@/lib/station-units';
import { portDisplayStatus } from '@/lib/connector-status';
import { evseDisplayStatus } from '@evtivity/lib/evse-status';

// One charger of the location page, for every case: a station without units,
// a unit (charger box) of a station with units, or the EVSEs without a unit of
// such a station. The row opens the charger page, a free port that EVSE.

/** One connector row of the location reply. */
export interface LocationConnectorRow {
  stationId: string;
  evseId: number;
  unitId?: string | null;
  unitName?: string | null;
  connectorType: string | null;
  maxPowerKw: string | null;
  status: string;
  // The API's driver availability rule: station online, enabled and not under
  // maintenance, EVSE not reserved, and a startable connector status.
  available: boolean;
}

/** One charger of the location reply (`driverChargers`). */
export interface LocationChargerInfo {
  stationId: string;
  /** The unit, or null for a station without units and for the EVSEs without a unit. */
  unitId: string | null;
  unitName: string | null;
  evseIds: number[];
  evseCount: number;
  availableCount: number;
}

/**
 * The chargers of a reply without `driverChargers` (an API before v0.1.52):
 * the rows grouped by station and unit, in row order.
 */
export function groupLocationRows(rows: readonly LocationConnectorRow[]): LocationChargerInfo[] {
  const groups = new Map<string, LocationChargerInfo & { free: Set<number> }>();
  for (const row of rows) {
    const unitId = row.unitId ?? null;
    const key = `${row.stationId}#${unitId ?? ''}`;
    const entry = groups.get(key) ?? {
      stationId: row.stationId,
      unitId,
      unitName: row.unitName ?? null,
      evseIds: [],
      evseCount: 0,
      availableCount: 0,
      free: new Set<number>(),
    };
    if (!entry.evseIds.includes(row.evseId)) entry.evseIds.push(row.evseId);
    if (row.available) entry.free.add(row.evseId);
    groups.set(key, entry);
  }
  return [...groups.values()].map(({ free, ...c }) => ({
    ...c,
    evseCount: c.evseIds.length,
    availableCount: free.size,
  }));
}

export function LocationChargerRow({
  charger,
  rows,
}: {
  charger: LocationChargerInfo;
  rows: readonly LocationConnectorRow[];
}): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const ports = charger.evseIds.map((evseId) => {
    const connectors = rows.filter((r) => r.stationId === charger.stationId && r.evseId === evseId);
    const available = connectors.some((r) => r.available);
    const status = evseDisplayStatus(connectors.map((r) => r.status));
    // A connector can report Available while its station is disabled,
    // offline, under maintenance or the EVSE is reserved.
    return {
      evseId,
      connectors,
      available,
      status: portDisplayStatus(status, available),
    };
  });
  return (
    <div
      className="space-y-3 rounded-md border border-input bg-background p-3"
      data-testid="location-charger-row"
    >
      <Link
        to={`/charge/${charger.stationId}${chargerUnitQuery(charger.unitId)}`}
        className="flex items-center justify-between gap-2"
        data-testid="location-charger-link"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Plug
            className={`h-4 w-4 shrink-0 ${charger.availableCount > 0 ? 'text-success' : 'text-muted-foreground'}`}
          />
          <span className="min-w-0 text-left">
            <span className="block truncate font-medium" data-testid="charger-row-title">
              {charger.unitName ?? charger.stationId}
            </span>
            {charger.unitName != null && (
              <span
                className="block truncate text-xs text-muted-foreground"
                data-testid="charger-row-station"
              >
                {charger.stationId}
              </span>
            )}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          {t('location.available', { count: charger.availableCount })}
          <ChevronRight className="h-4 w-4" />
        </span>
      </Link>
      <PortGrid count={ports.length}>
        {ports.map((port) => (
          <PortCard
            key={port.evseId}
            evseId={port.evseId}
            connectors={port.connectors}
            status={port.status}
            available={port.available}
            onSelect={() => {
              void navigate(`/charge/${charger.stationId}/${String(port.evseId)}`);
            }}
          />
        ))}
      </PortGrid>
    </div>
  );
}
