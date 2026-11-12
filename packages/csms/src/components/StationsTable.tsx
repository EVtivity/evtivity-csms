// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { HelpCircle, Info, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InfoTooltip as Tooltip } from '@/components/ui/info-tooltip';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import type { ListSort } from '@/hooks/use-list-sort';
import { SecurityProfileBadge } from '@/components/SecurityProfileBadge';
import { StationStatusBadge } from '@/components/StationStatusBadge';
import { StationOnlineBadge } from '@/components/StationOnlineBadge';
import { Type1ListIcon as Type1Icon } from '@/components/connector-icons/Type1ListIcon';
import { Type2ListIcon as Type2Icon } from '@/components/connector-icons/Type2ListIcon';
import { Ccs1ListIcon as CCS1Icon } from '@/components/connector-icons/Ccs1ListIcon';
import { Ccs2ListIcon as CCS2Icon } from '@/components/connector-icons/Ccs2ListIcon';
import { ChademoListIcon as CHAdeMOIcon } from '@/components/connector-icons/ChademoListIcon';
import { NacsListIcon as NACSIcon } from '@/components/connector-icons/NacsListIcon';
import { formatDateTime, formatRelativeTime } from '@/lib/timezone';
import type { ColumnMeta, ColumnVisibility } from '@/lib/column-visibility';
import { EmptyState, ErrorState, LoadingState, TableStateRow } from '@/components/ui/content-state';

export const STATIONS_COLUMNS: ColumnMeta[] = [
  {
    key: 'stationId',
    label: 'stations.id',
    defaultVisible: true,
    defaultVisibleMobile: true,
    alwaysVisible: true,
  },
  { key: 'site', label: 'sites.siteName', defaultVisible: true, defaultVisibleMobile: true },
  { key: 'vendor', label: 'stations.vendor', defaultVisible: false, defaultVisibleMobile: false },
  { key: 'model', label: 'stations.model', defaultVisible: true, defaultVisibleMobile: false },
  {
    key: 'securityProfile',
    label: 'stations.securityProfile',
    defaultVisible: true,
    defaultVisibleMobile: false,
  },
  {
    key: 'ocppProtocol',
    label: 'stations.ocppProtocol',
    defaultVisible: true,
    defaultVisibleMobile: false,
  },
  {
    key: 'evseStatus',
    label: 'stations.evseStatus',
    defaultVisible: true,
    defaultVisibleMobile: true,
    alwaysVisible: true,
  },
  {
    key: 'connectors',
    label: 'stations.connectors',
    defaultVisible: true,
    defaultVisibleMobile: false,
  },
  { key: 'online', label: 'status.online', defaultVisible: true, defaultVisibleMobile: true },
  {
    key: 'lastHeartbeat',
    label: 'stations.lastHeartbeat',
    defaultVisible: true,
    defaultVisibleMobile: false,
  },
  {
    key: 'createdAt',
    label: 'common.created',
    defaultVisible: true,
    defaultVisibleMobile: false,
  },
];

/**
 * The sort keys of `GET /v1/stations` and `GET /v1/sites/:id/stations` (`stationListSort`
 * and `siteStationListSort` in the API, `lib/sorts/station-list-sort.ts`).
 */
export const STATION_SORT_KEYS = [
  'stationId',
  'site',
  'vendor',
  'model',
  'securityProfile',
  'ocppProtocol',
  'status',
  'connectors',
  'online',
  'lastHeartbeat',
  'createdAt',
] as const;
export type StationSortKey = (typeof STATION_SORT_KEYS)[number];

export interface Station {
  id: string;
  stationId: string;
  siteId?: string | null;
  siteName?: string | null;
  vendorName?: string | null;
  model: string | null;
  securityProfile?: number | undefined;
  ocppProtocol?: string | null;
  status: string;
  statusReason?: string | null;
  connectorCount: number;
  connectorTypes: string[] | null;
  /** Units (physical charger boxes) of the station; 0 and null for a station without units. */
  unitCount?: number;
  units?: { id: string; name: string; connectorTypes: string[] }[] | null;
  unassignedConnectorTypes?: string[] | null;
  isOnline: boolean;
  isSimulator?: boolean;
  siteFreeVendEnabled?: boolean;
  underMaintenance?: boolean;
  aiInsightsSuppressed?: boolean;
  lastHeartbeat: string | null;
  createdAt: string | null;
}

function connectorTypeKey(type: string): string {
  const t = type.toLowerCase();
  if (t.includes('ccs1')) return 'ccs1';
  if (t.includes('ccs2')) return 'ccs2';
  if (t.includes('ccs')) return 'ccs';
  if (t.includes('chademo')) return 'chademo';
  if (t.includes('type1') || t.includes('j1772')) return 'type1';
  if (t.includes('type2') || t.includes('mennekes')) return 'type2';
  if (t.includes('tesla') || t.includes('nacs')) return 'nacs';
  return 'unknown';
}

function connectorDisplayName(type: string): string {
  const key = connectorTypeKey(type);
  const names: Record<string, string> = {
    ccs1: 'CCS1',
    ccs2: 'CCS2',
    ccs: 'CCS',
    chademo: 'CHAdeMO',
    type1: 'Type 1',
    type2: 'Type 2',
    nacs: 'NACS',
    unknown: type,
  };
  return names[key] ?? type;
}

function ConnectorTypeIcon({ type }: { type: string }): React.JSX.Element {
  const key = connectorTypeKey(type);
  const name = connectorDisplayName(type);

  let icon: React.JSX.Element;
  switch (key) {
    case 'ccs1':
      icon = <CCS1Icon />;
      break;
    case 'ccs2':
      icon = <CCS2Icon />;
      break;
    case 'ccs':
      icon = <CCS2Icon />;
      break;
    case 'chademo':
      icon = <CHAdeMOIcon />;
      break;
    case 'type1':
      icon = <Type1Icon />;
      break;
    case 'nacs':
      icon = <NACSIcon />;
      break;
    case 'unknown':
      icon = <HelpCircle className="h-5 w-5 text-muted-foreground" />;
      break;
    default:
      icon = <Type2Icon />;
      break;
  }

  return <Tooltip content={name}>{icon}</Tooltip>;
}

// The connector icons of a station with units: one group per unit (its name as
// the group title), then the EVSEs without a unit, divided by a thin line.
function UnitConnectorGroups({
  units,
  unassigned,
}: {
  units: { id: string; name: string; connectorTypes: string[] }[];
  unassigned: string[];
}): React.JSX.Element {
  const { t } = useTranslation();
  const groups = [
    ...units.map((u) => ({ key: u.id, name: u.name, types: u.connectorTypes })),
    ...(unassigned.length > 0
      ? [{ key: 'unassigned', name: t('stationUnits.evsesWithoutUnit'), types: unassigned }]
      : []),
  ];
  return (
    <div className="flex items-center gap-1.5 flex-wrap" data-testid="unit-connector-groups">
      {groups.map((g) => (
        <span
          key={g.key}
          role="group"
          aria-label={g.name}
          title={g.name}
          data-testid="unit-connector-group"
          className="flex items-center gap-1 border-l border-border pl-1.5 first:border-l-0 first:pl-0"
        >
          {g.types.map((type) => (
            <ConnectorTypeIcon key={type} type={type} />
          ))}
        </span>
      ))}
    </div>
  );
}

interface StationsTableProps {
  stations: Station[] | undefined;
  timezone: string;
  emptyMessage?: string;
  siteMap?: Map<string, string>;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: (() => void) | undefined;
  onRemove?: (station: Station) => void;
  visibility?: ColumnVisibility;
  /** The list's sort; without it the headers do not sort. */
  sort?: ListSort<StationSortKey> | undefined;
}

export function StationsTable({
  stations,
  timezone,
  emptyMessage,
  siteMap,
  isLoading,
  isError = false,
  onRetry,
  onRemove,
  visibility,
  sort,
}: StationsTableProps): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const showSiteColumn = siteMap != null;
  const hasActions = onRemove != null;
  const isVisible = (key: string): boolean => visibility == null || visibility[key] !== false;
  const visibleCount = STATIONS_COLUMNS.filter(
    (c) => (c.key !== 'site' || showSiteColumn) && isVisible(c.key),
  ).length;
  const colSpan = visibleCount + (hasActions ? 1 : 0);

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            {isVisible('stationId') && (
              <SortableTableHead sortKey="stationId" sort={sort}>
                {t('stations.id')}
              </SortableTableHead>
            )}
            {showSiteColumn && isVisible('site') && (
              <SortableTableHead sortKey="site" sort={sort}>
                {t('sites.siteName')}
              </SortableTableHead>
            )}
            {isVisible('vendor') && (
              <SortableTableHead sortKey="vendor" sort={sort}>
                {t('stations.vendor')}
              </SortableTableHead>
            )}
            {isVisible('model') && (
              <SortableTableHead sortKey="model" sort={sort}>
                {t('stations.model')}
              </SortableTableHead>
            )}
            {isVisible('securityProfile') && (
              <SortableTableHead sortKey="securityProfile" sort={sort}>
                {t('stations.securityProfile')}
              </SortableTableHead>
            )}
            {isVisible('ocppProtocol') && (
              <SortableTableHead sortKey="ocppProtocol" sort={sort}>
                {t('stations.ocppProtocol')}
              </SortableTableHead>
            )}
            {isVisible('evseStatus') && (
              <SortableTableHead sortKey="status" sort={sort}>
                <span className="inline-flex items-center gap-1">
                  {t('stations.evseStatus')}
                  <Tooltip
                    content={
                      <div className="w-56 space-y-1">
                        <p className="font-medium">{t('stations.evseStatus')}</p>
                        <p className="text-muted-foreground">{t('stations.evseStatusTooltip')}</p>
                      </div>
                    }
                  >
                    <Info className="h-3.5 w-3.5 text-muted-foreground" />
                  </Tooltip>
                </span>
              </SortableTableHead>
            )}
            {isVisible('connectors') && (
              <SortableTableHead sortKey="connectors" sort={sort}>
                <span className="inline-flex items-center gap-1">
                  {t('stations.connectors')}
                  <Tooltip
                    content={
                      <div className="w-48 space-y-2">
                        <p className="font-medium">{t('stations.connectors')}</p>
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2">
                            <Type1Icon />
                            <span>Type 1 (J1772)</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Type2Icon />
                            <span>Type 2</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <CCS1Icon />
                            <span>CCS1</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <CCS2Icon />
                            <span>CCS2</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <CHAdeMOIcon />
                            <span>CHAdeMO</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <NACSIcon />
                            <span>NACS (Tesla)</span>
                          </div>
                        </div>
                      </div>
                    }
                  >
                    <Info className="h-3.5 w-3.5 text-muted-foreground" />
                  </Tooltip>
                </span>
              </SortableTableHead>
            )}
            {isVisible('online') && (
              <SortableTableHead sortKey="online" sort={sort}>
                {t('status.online')}
              </SortableTableHead>
            )}
            {isVisible('lastHeartbeat') && (
              <SortableTableHead sortKey="lastHeartbeat" sort={sort}>
                {t('stations.lastHeartbeat')}
              </SortableTableHead>
            )}
            {isVisible('createdAt') && (
              <SortableTableHead sortKey="createdAt" sort={sort}>
                {t('common.created')}
              </SortableTableHead>
            )}
            {hasActions && <TableHead />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading === true && (
            <TableStateRow colSpan={colSpan}>
              <LoadingState />
            </TableStateRow>
          )}
          {isError && isLoading !== true && (
            <TableStateRow colSpan={colSpan}>
              <ErrorState onRetry={onRetry} />
            </TableStateRow>
          )}
          {stations?.map((station) => (
            <TableRow
              key={station.id}
              data-testid={`station-row-${station.id}`}
              className="cursor-pointer"
              onClick={() => {
                void navigate(`/stations/${station.id}`);
              }}
            >
              {isVisible('stationId') && (
                <TableCell
                  className="font-medium text-link whitespace-nowrap"
                  data-testid="row-click-target"
                >
                  <span className="inline-flex items-center gap-1.5">
                    {station.stationId}
                    {station.isSimulator === true && (
                      <Badge variant="info" className="text-[10px] px-1.5 py-0">
                        {t('stations.simulator')}
                      </Badge>
                    )}
                    {station.siteFreeVendEnabled === true && (
                      <Badge variant="info" className="text-[10px] px-1.5 py-0">
                        {t('stations.freeVend')}
                      </Badge>
                    )}
                    {station.underMaintenance === true && (
                      <Badge variant="warning" className="text-[10px] px-1.5 py-0">
                        {t('nav.maintenance')}
                      </Badge>
                    )}
                    {station.aiInsightsSuppressed === true && (
                      <Badge
                        variant="secondary"
                        className="text-[10px] px-1.5 py-0"
                        data-testid="station-ai-suppressed-badge"
                      >
                        {t('stations.aiInsights.listBadge')}
                      </Badge>
                    )}
                  </span>
                </TableCell>
              )}
              {showSiteColumn && isVisible('site') && (
                <TableCell>
                  {station.siteId != null ? (
                    <Link
                      to={`/sites/${station.siteId}`}
                      className="text-link hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                      }}
                    >
                      {station.siteName ?? siteMap.get(station.siteId) ?? t('common.unnamedSite')}
                    </Link>
                  ) : (
                    '-'
                  )}
                </TableCell>
              )}
              {isVisible('vendor') && (
                <TableCell className="whitespace-nowrap">{station.vendorName ?? '-'}</TableCell>
              )}
              {isVisible('model') && (
                <TableCell className="whitespace-nowrap">
                  {station.model ?? '-'}
                  {(station.unitCount ?? 0) > 0 && (
                    <div className="text-xs text-muted-foreground" data-testid="station-unit-count">
                      {t('stationUnits.unitCount', { count: station.unitCount })}
                    </div>
                  )}
                </TableCell>
              )}
              {isVisible('securityProfile') && (
                <TableCell className="whitespace-nowrap">
                  {station.securityProfile != null ? (
                    <SecurityProfileBadge
                      profile={station.securityProfile}
                      ocppProtocol={station.ocppProtocol}
                    />
                  ) : (
                    '-'
                  )}
                </TableCell>
              )}
              {isVisible('ocppProtocol') && <TableCell>{station.ocppProtocol ?? '-'}</TableCell>}
              {isVisible('evseStatus') && (
                <TableCell>
                  <StationStatusBadge status={station.status} statusReason={station.statusReason} />
                </TableCell>
              )}
              {isVisible('connectors') && (
                <TableCell>
                  {station.units != null && station.units.length > 0 ? (
                    <UnitConnectorGroups
                      units={station.units}
                      unassigned={station.unassignedConnectorTypes ?? []}
                    />
                  ) : (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {station.connectorTypes?.map((type) => (
                        <ConnectorTypeIcon key={type} type={type} />
                      ))}
                    </div>
                  )}
                </TableCell>
              )}
              {isVisible('online') && (
                <TableCell>
                  <StationOnlineBadge isOnline={station.isOnline} />
                </TableCell>
              )}
              {isVisible('lastHeartbeat') && (
                <TableCell>
                  {station.lastHeartbeat != null ? (
                    <span title={formatDateTime(station.lastHeartbeat, timezone)}>
                      {formatRelativeTime(station.lastHeartbeat, timezone)}
                    </span>
                  ) : (
                    '-'
                  )}
                </TableCell>
              )}
              {isVisible('createdAt') && (
                <TableCell>
                  {station.createdAt != null ? (
                    <span title={formatDateTime(station.createdAt, timezone)}>
                      {formatRelativeTime(station.createdAt, timezone)}
                    </span>
                  ) : (
                    t('common.na')
                  )}
                </TableCell>
              )}
              {hasActions && (
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('fleets.removeStation')}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(station);
                    }}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {stations?.length === 0 && isLoading !== true && !isError && (
        <EmptyState>{emptyMessage ?? t('stations.noStationsFound')}</EmptyState>
      )}
    </>
  );
}
