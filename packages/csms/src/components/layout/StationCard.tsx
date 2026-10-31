// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, useMotionValue } from 'motion/react';
import { Plug, Zap, Circle, Plus, Shield } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatEnergy, formatNumber } from '@/lib/formatting';
import { STATUS_COLORS, SVG_COLORS } from '@/lib/chart-theme';
import { stationDisplayState, stationStateLabelKey } from '@/lib/station-display-state';
import { CellularBadge, StationStateIcon } from './StationStateIcon';
import type { AvatarData } from '@/components/AccountAvatar';

const GRID_SIZE = 20;

let globalDragCounter = 0;

interface ConnectorData {
  connectorId: number;
  connectorType: string | null;
  maxPowerKw: number | null;
  status: string;
  isPluggedIn: boolean;
  energyDeliveredWh: number | null;
}

interface EvseData {
  evseId: number;
  status: string;
  connectors: ConnectorData[];
}

/** The driver of an active session (only with drivers:read). */
export interface LayoutSessionDriver {
  id: string;
  name: string | null;
  avatar: AvatarData | null;
}

/** The newest active session of a station (only with sessions:read). */
export interface LayoutSession {
  id: string;
  startedAt: string;
  energyDeliveredWh: number;
  currentCostCents: number | null;
  currency: string;
  driver: LayoutSessionDriver | null;
}

export interface LayoutStation {
  id: string;
  stationId: string;
  model: string | null;
  status: string;
  statusReason?: string | null | undefined;
  isOnline: boolean;
  securityProfile: number;
  positionX: number;
  positionY: number;
  /** False while the position is a free slot the server picked, not saved yet. */
  placed: boolean;
  chargingKind: 'ac' | 'dc';
  cellular: boolean;
  inMaintenance: boolean;
  displayMessage: string | null;
  evses: EvseData[];
  /** The active session: null without one or without sessions:read (absent in older replies). */
  session?: LayoutSession | null | undefined;
}

interface StationCardProps {
  station: LayoutStation;
  onDragEnd: (stationId: string, x: number, y: number) => void;
  /** Where a drop at (x, y) lands: on the grid, inside the board, on no other card. */
  resolveDrop?: ((stationId: string, x: number, y: number) => { x: number; y: number }) | undefined;
  currentDrawKw?: number | undefined;
  allocatedLimitKw?: number | null | undefined;
  /** Opens the station popup (shared with the 3D view). */
  onOpenDetails?: ((stationId: string) => void) | undefined;
}

function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? '#6b7280';
}

function isCharging(station: LayoutStation): boolean {
  return station.evses.some((evse) => evse.connectors.some((conn) => conn.isPluggedIn));
}

function totalEnergy(station: LayoutStation): number {
  let total = 0;
  for (const evse of station.evses) {
    for (const conn of evse.connectors) {
      if (conn.energyDeliveredWh != null) {
        total += conn.energyDeliveredWh;
      }
    }
  }
  return total;
}

function allConnectors(station: LayoutStation): ConnectorData[] {
  const result: ConnectorData[] = [];
  for (const evse of station.evses) {
    for (const conn of evse.connectors) {
      result.push(conn);
    }
  }
  return result;
}

function StationIcon({
  status,
  charging,
  dc,
}: {
  status: string;
  charging: boolean;
  dc: boolean;
}): React.JSX.Element {
  const color = statusColor(status);

  if (dc) {
    return (
      <svg width="52" height="62" viewBox="0 0 52 62" className="shrink-0">
        {charging && (
          <motion.circle
            cx="26"
            cy="31"
            r="26"
            fill="none"
            stroke={SVG_COLORS.chargingPulse}
            strokeWidth="1.5"
            animate={{ opacity: [0.3, 0.8, 0.3], scale: [0.9, 1.1, 0.9] }}
            transition={{ duration: 2, repeat: Infinity }}
          />
        )}
        {/* Wider body */}
        <rect
          x="4"
          y="2"
          width="44"
          height="52"
          rx="5"
          fill={SVG_COLORS.stationBody}
          stroke={SVG_COLORS.stationStroke}
          strokeWidth="1.5"
        />
        {/* Screen */}
        <rect
          x="9"
          y="6"
          width="34"
          height="20"
          rx="2"
          fill={color}
          opacity="0.3"
          stroke={color}
          strokeWidth="0.5"
        />
        {/* Lightning bolt on screen */}
        <path d="M28 9 L22 17 L26 17 L22 25 L30 15 L26 15 Z" fill={color} opacity="0.7" />
        {/* Two thick cable ports */}
        <rect x="10" y="32" width="12" height="7" rx="2" fill={SVG_COLORS.stationPort} />
        <rect x="30" y="32" width="12" height="7" rx="2" fill={SVG_COLORS.stationPort} />
        {/* Cable dangles */}
        <path
          d="M16 39 Q16 46 13 50"
          fill="none"
          stroke={SVG_COLORS.stationPort}
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M36 39 Q36 46 39 50"
          fill="none"
          stroke={SVG_COLORS.stationPort}
          strokeWidth="2"
          strokeLinecap="round"
        />
        {/* Status LED */}
        <circle cx="44" cy="6" r="3" fill={color} />
      </svg>
    );
  }

  return (
    <svg width="48" height="56" viewBox="0 0 48 56" className="shrink-0">
      {charging && (
        <motion.circle
          cx="24"
          cy="28"
          r="23"
          fill="none"
          stroke={SVG_COLORS.chargingPulse}
          strokeWidth="1.5"
          animate={{ opacity: [0.3, 0.8, 0.3], scale: [0.9, 1.1, 0.9] }}
          transition={{ duration: 2, repeat: Infinity }}
        />
      )}
      <rect
        x="8"
        y="4"
        width="32"
        height="44"
        rx="4"
        fill={SVG_COLORS.stationBody}
        stroke={SVG_COLORS.stationStroke}
        strokeWidth="1.5"
      />
      <rect
        x="12"
        y="8"
        width="24"
        height="16"
        rx="2"
        fill={color}
        opacity="0.3"
        stroke={color}
        strokeWidth="0.5"
      />
      {/* Small bolt on screen */}
      <path d="M26 10 L22 15 L25 15 L22 20 L28 14 L25 14 Z" fill={color} opacity="0.7" />
      <rect x="14" y="30" width="8" height="5" rx="1" fill={SVG_COLORS.stationPort} />
      <rect x="26" y="30" width="8" height="5" rx="1" fill={SVG_COLORS.stationPort} />
      <circle cx="40" cy="8" r="3" fill={color} />
    </svg>
  );
}

function Tooltip({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover/tip:block whitespace-nowrap rounded bg-popover px-1.5 py-0.5 text-xs text-popover-foreground shadow-sm border z-100">
        {label}
      </span>
    </span>
  );
}

function ConnectorIcon({ conn }: { conn: ConnectorData }): React.JSX.Element {
  const color = statusColor(conn.status);
  const label = conn.connectorType ?? `#${String(conn.connectorId)}`;
  const isPulsing =
    conn.isPluggedIn ||
    ['occupied', 'charging', 'preparing', 'suspended_ev', 'suspended_evse'].includes(conn.status);

  if (conn.status === 'available') {
    return (
      <Tooltip label={`${label} - available`}>
        <Plug className="h-3.5 w-3.5 text-success" />
      </Tooltip>
    );
  }

  return (
    <Tooltip label={`${label} - ${conn.status}`}>
      <span className="relative inline-flex h-3 w-3">
        {isPulsing && (
          <span
            className="absolute inset-0 rounded-full animate-ping opacity-75"
            style={{ backgroundColor: color }}
          />
        )}
        <Circle className="relative h-3 w-3" style={{ color }} fill={color} />
      </span>
    </Tooltip>
  );
}

function utilizationColor(drawKw: number, limitKw: number): string {
  const pct = limitKw > 0 ? drawKw / limitKw : 0;
  if (pct >= 0.95) return 'text-destructive';
  if (pct >= 0.8) return 'text-warning';
  return 'text-success';
}

function spColor(sp: number): string {
  switch (sp) {
    case 0:
      return 'text-muted-foreground';
    case 1:
      return 'text-link';
    case 2:
      return 'text-success';
    case 3:
      return 'text-warning';
    default:
      return 'text-muted-foreground';
  }
}

function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

export function StationCard({
  station,
  onDragEnd,
  onOpenDetails,
  currentDrawKw,
  allocatedLimitKw,
  resolveDrop,
}: StationCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const charging = isCharging(station);
  const energy = totalEnergy(station);
  const connectors = allConnectors(station);
  const reasonLabel =
    station.statusReason != null &&
    (station.status === 'unavailable' || station.status === 'faulted')
      ? t(`stations.statusReason.${station.statusReason}`, station.statusReason)
      : null;
  const stationIcon = (
    <StationIcon status={station.status} charging={charging} dc={station.chargingKind === 'dc'} />
  );
  const state = stationDisplayState(station);
  const badges = station.cellular ? (
    <div className="flex flex-wrap items-center gap-1">
      <CellularBadge />
    </div>
  ) : null;
  const iconWithReason =
    reasonLabel != null ? <Tooltip label={reasonLabel}>{stationIcon}</Tooltip> : stationIcon;
  const motionX = useMotionValue(station.positionX);
  const motionY = useMotionValue(station.positionY);
  const [zIndex, setZIndex] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    motionX.set(station.positionX);
    motionY.set(station.positionY);
  }, [station.positionX, station.positionY, motionX, motionY]);

  return (
    <motion.div
      drag
      dragMomentum={false}
      dragElastic={0}
      whileHover={{ scale: 1.02 }}
      whileDrag={{ scale: 1.05 }}
      onDragStart={() => {
        globalDragCounter += 1;
        setZIndex(globalDragCounter);
        setIsDragging(true);
      }}
      style={{
        position: 'absolute',
        x: motionX,
        y: motionY,
        zIndex,
        cursor: 'grab',
      }}
      onDragEnd={() => {
        setIsDragging(false);
        const dropped =
          resolveDrop != null
            ? resolveDrop(station.id, motionX.get(), motionY.get())
            : {
                x: snapToGrid(Math.max(0, motionX.get())),
                y: snapToGrid(Math.max(0, motionY.get())),
              };
        motionX.set(dropped.x);
        motionY.set(dropped.y);
        onDragEnd(station.id, dropped.x, dropped.y);
      }}
      data-testid={`site-layout-card-${station.id}`}
      className={cn(
        'w-[160px] rounded-lg border bg-card text-card-foreground shadow-xs select-none',
        isDragging && 'ring-2 ring-primary shadow-lg',
      )}
    >
      <div className="p-2.5 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <span
            className="relative inline-flex h-2 w-2 shrink-0"
            title={station.isOnline ? t('status.online') : t('status.offline')}
          >
            {station.isOnline && (
              <span className="absolute inset-0 rounded-full bg-success animate-ping opacity-75" />
            )}
            <span
              className={cn(
                'relative h-2 w-2 rounded-full',
                station.isOnline ? 'bg-success' : 'bg-destructive',
              )}
            />
          </span>
          <span className="font-semibold truncate text-xs">{station.stationId}</span>
          <StationStateIcon state={state} />
          <Tooltip label={`Security Profile ${String(station.securityProfile)}`}>
            <span
              className={cn('flex items-center gap-0.5 shrink-0', spColor(station.securityProfile))}
            >
              <Shield className="h-3 w-3" />
              <span className="text-xs font-bold">{String(station.securityProfile)}</span>
            </span>
          </Tooltip>
          {/* Opens the shared station popup, the same as the 3D view. */}
          <button
            type="button"
            className="ml-auto rounded p-0.5 hover:bg-muted"
            aria-label={t('sites.layoutView.stateDetailsLabel', {
              id: station.stationId,
              state: t(stationStateLabelKey(state)),
            })}
            aria-haspopup="dialog"
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              globalDragCounter += 1;
              setZIndex(globalDragCounter);
              onOpenDetails?.(station.id);
            }}
          >
            <Plus className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          </button>
        </div>

        <div className="flex items-center gap-2">
          {iconWithReason}
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex flex-wrap gap-1">
              {connectors.map((conn, i) => (
                <ConnectorIcon key={i} conn={conn} />
              ))}
            </div>
            {badges}
            {charging && energy > 0 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center gap-0.5 text-xs font-medium text-link"
              >
                <Zap className="h-3 w-3" />
                <span>{formatEnergy(energy)}</span>
              </motion.div>
            )}
            {currentDrawKw != null && currentDrawKw > 0 && (
              <div
                className={cn(
                  'flex items-center gap-0.5 text-xs font-medium',
                  allocatedLimitKw != null && allocatedLimitKw > 0
                    ? utilizationColor(currentDrawKw, allocatedLimitKw)
                    : 'text-success',
                )}
              >
                <Zap className="h-2.5 w-2.5" />
                <span>{formatNumber(currentDrawKw, 1)} kW</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
