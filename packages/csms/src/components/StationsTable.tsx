// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Info, Trash2 } from 'lucide-react';
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
import { CopyableId } from '@/components/copyable-id';
import { SecurityProfileBadge } from '@/components/SecurityProfileBadge';
import { SVG_COLORS } from '@/lib/chart-theme';
import { formatDateTime, formatRelativeTime } from '@/lib/timezone';
import { stationStatusVariant } from '@/lib/status-variants';

export interface Station {
  id: string;
  stationId: string;
  siteId?: string | null;
  model: string | null;
  securityProfile?: number | undefined;
  ocppProtocol?: string | null;
  status: string;
  connectorCount: number;
  connectorTypes: string[] | null;
  isOnline: boolean;
  isSimulator?: boolean;
  siteFreeVendEnabled?: boolean;
  lastHeartbeat: string | null;
}

function statusClassName(status: string): string | undefined {
  if (status === 'charging') return 'bg-blue-500 text-blue-50 hover:bg-blue-500/80';
  if (status === 'reserved') return 'bg-orange-500 text-orange-50 hover:bg-orange-500/80';
  return undefined;
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
    type1: 'Type 1 (J1772)',
    type2: 'Type 2',
    nacs: 'NACS (Tesla)',
    unknown: type,
  };
  return names[key] ?? type;
}

// Type 1 / J1772 - 5 pins in circular housing (AC)
function Type1Icon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className="shrink-0">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="5.5" cy="6" r="1" fill="currentColor" />
      <circle cx="10.5" cy="6" r="1" fill="currentColor" />
      <circle cx="4.5" cy="9.5" r="1" fill="currentColor" />
      <circle cx="11.5" cy="9.5" r="1" fill="currentColor" />
      <circle cx="8" cy="11" r="1" fill="currentColor" />
    </svg>
  );
}

// Type 2 / Mennekes - 7 pins in rounded housing (AC)
function Type2Icon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className="shrink-0">
      <rect
        x="1"
        y="2"
        width="14"
        height="12"
        rx="5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <circle cx="5" cy="6" r="0.9" fill="currentColor" />
      <circle cx="8" cy="5.5" r="0.9" fill="currentColor" />
      <circle cx="11" cy="6" r="0.9" fill="currentColor" />
      <circle cx="5" cy="9.5" r="0.9" fill="currentColor" />
      <circle cx="8" cy="10" r="0.9" fill="currentColor" />
      <circle cx="11" cy="9.5" r="0.9" fill="currentColor" />
      <circle cx="8" cy="7.8" r="0.9" fill="currentColor" />
    </svg>
  );
}

// CCS1 - Type 1 top + 2 DC pins below
function CCS1Icon(): React.JSX.Element {
  return (
    <svg width="16" height="20" viewBox="0 0 16 20" className="shrink-0">
      <circle
        cx="8"
        cy="6"
        r="5.5"
        fill="none"
        stroke={SVG_COLORS.connectorAmber}
        strokeWidth="1.2"
      />
      <circle cx="6" cy="5" r="0.8" fill={SVG_COLORS.connectorAmber} />
      <circle cx="10" cy="5" r="0.8" fill={SVG_COLORS.connectorAmber} />
      <circle cx="8" cy="7.5" r="0.8" fill={SVG_COLORS.connectorAmber} />
      <rect
        x="3"
        y="13"
        width="10"
        height="5"
        rx="2.5"
        fill="none"
        stroke={SVG_COLORS.connectorAmber}
        strokeWidth="1.2"
      />
      <circle cx="6" cy="15.5" r="1" fill={SVG_COLORS.connectorAmber} />
      <circle cx="10" cy="15.5" r="1" fill={SVG_COLORS.connectorAmber} />
    </svg>
  );
}

// CCS2 - Type 2 top + 2 DC pins below
function CCS2Icon(): React.JSX.Element {
  return (
    <svg width="16" height="20" viewBox="0 0 16 20" className="shrink-0">
      <rect
        x="1.5"
        y="1"
        width="13"
        height="10"
        rx="4.5"
        fill="none"
        stroke={SVG_COLORS.connectorAmber}
        strokeWidth="1.2"
      />
      <circle cx="5.5" cy="4.5" r="0.8" fill={SVG_COLORS.connectorAmber} />
      <circle cx="10.5" cy="4.5" r="0.8" fill={SVG_COLORS.connectorAmber} />
      <circle cx="8" cy="4" r="0.8" fill={SVG_COLORS.connectorAmber} />
      <circle cx="5.5" cy="7.5" r="0.8" fill={SVG_COLORS.connectorAmber} />
      <circle cx="10.5" cy="7.5" r="0.8" fill={SVG_COLORS.connectorAmber} />
      <rect
        x="3"
        y="13"
        width="10"
        height="5"
        rx="2.5"
        fill="none"
        stroke={SVG_COLORS.connectorAmber}
        strokeWidth="1.2"
      />
      <circle cx="6" cy="15.5" r="1" fill={SVG_COLORS.connectorAmber} />
      <circle cx="10" cy="15.5" r="1" fill={SVG_COLORS.connectorAmber} />
    </svg>
  );
}

// CHAdeMO - large round connector with pins
function CHAdeMOIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className="shrink-0">
      <circle
        cx="8"
        cy="8"
        r="7"
        fill="none"
        stroke={SVG_COLORS.connectorAmber}
        strokeWidth="1.2"
      />
      <circle cx="5" cy="5.5" r="1" fill={SVG_COLORS.connectorAmber} />
      <circle cx="11" cy="5.5" r="1" fill={SVG_COLORS.connectorAmber} />
      <circle cx="5" cy="10.5" r="1" fill={SVG_COLORS.connectorAmber} />
      <circle cx="11" cy="10.5" r="1" fill={SVG_COLORS.connectorAmber} />
      <circle cx="8" cy="8" r="1.2" fill={SVG_COLORS.connectorAmber} />
    </svg>
  );
}

// NACS / Tesla - oval connector
function NACSIcon(): React.JSX.Element {
  return (
    <svg width="12" height="16" viewBox="0 0 12 16" className="shrink-0">
      <rect
        x="1"
        y="1"
        width="10"
        height="14"
        rx="5"
        fill="none"
        stroke={SVG_COLORS.connectorAmber}
        strokeWidth="1.2"
      />
      <circle cx="6" cy="5.5" r="1" fill={SVG_COLORS.connectorAmber} />
      <circle cx="6" cy="10.5" r="1" fill={SVG_COLORS.connectorAmber} />
    </svg>
  );
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
    default:
      icon = <Type2Icon />;
      break;
  }

  return <Tooltip content={name}>{icon}</Tooltip>;
}

interface StationsTableProps {
  stations: Station[] | undefined;
  timezone: string;
  emptyMessage?: string;
  siteMap?: Map<string, string>;
  isLoading?: boolean;
  onRemove?: (station: Station) => void;
}

export function StationsTable({
  stations,
  timezone,
  emptyMessage,
  siteMap,
  isLoading,
  onRemove,
}: StationsTableProps): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const showSiteColumn = siteMap != null;
  const hasActions = onRemove != null;
  const baseCols = 9;
  const colSpan = baseCols + (showSiteColumn ? 1 : 0) + (hasActions ? 1 : 0);

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('stations.stationId')}</TableHead>
            <TableHead>{t('stations.id')}</TableHead>
            {showSiteColumn && <TableHead>{t('sites.siteName')}</TableHead>}
            <TableHead>{t('stations.model')}</TableHead>
            <TableHead>{t('stations.securityProfile')}</TableHead>
            <TableHead>{t('stations.ocppProtocol')}</TableHead>
            <TableHead>
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
            </TableHead>
            <TableHead>
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
            </TableHead>
            <TableHead>{t('status.online')}</TableHead>
            <TableHead>{t('stations.lastHeartbeat')}</TableHead>
            {hasActions && <TableHead />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading === true && (
            <TableRow>
              <TableCell colSpan={colSpan} className="text-center text-muted-foreground">
                {t('common.loading')}
              </TableCell>
            </TableRow>
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
              <TableCell
                className="font-medium text-primary whitespace-nowrap"
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
                </span>
              </TableCell>
              <TableCell>
                <CopyableId id={station.id} variant="table" />
              </TableCell>
              {showSiteColumn && (
                <TableCell>
                  {station.siteId != null ? (
                    <Link
                      to={`/sites/${station.siteId}`}
                      className="text-primary hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                      }}
                    >
                      {siteMap.get(station.siteId) ?? station.siteId}
                    </Link>
                  ) : (
                    '-'
                  )}
                </TableCell>
              )}
              <TableCell className="whitespace-nowrap">{station.model ?? '-'}</TableCell>
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
              <TableCell>{station.ocppProtocol ?? '-'}</TableCell>
              <TableCell>
                <Badge
                  variant={stationStatusVariant(station.status)}
                  className={statusClassName(station.status)}
                >
                  {t(`status.${station.status}`, station.status)}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {station.connectorTypes?.map((type) => (
                    <ConnectorTypeIcon key={type} type={type} />
                  ))}
                </div>
              </TableCell>
              <TableCell>
                <Badge variant={station.isOnline ? 'success' : 'destructive'}>
                  {station.isOnline ? t('status.online') : t('status.offline')}
                </Badge>
              </TableCell>
              <TableCell>
                {station.lastHeartbeat != null ? (
                  <span title={formatDateTime(station.lastHeartbeat, timezone)}>
                    {formatRelativeTime(station.lastHeartbeat, timezone)}
                  </span>
                ) : (
                  '-'
                )}
              </TableCell>
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
      {stations?.length === 0 && isLoading !== true && (
        <div className="text-center text-sm text-muted-foreground py-8">
          {emptyMessage ?? t('stations.noStationsFound')}
        </div>
      )}
    </>
  );
}
