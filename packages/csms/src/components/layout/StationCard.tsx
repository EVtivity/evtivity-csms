// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { motion, useMotionValue } from 'motion/react';
import { MessageSquare, Plug, Zap, Circle, Plus, Minus, Power, Shield } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatEnergy } from '@/lib/formatting';
import { STATUS_COLORS, SVG_COLORS } from '@/lib/chart-theme';
import { stationCardConnectorStatusVariant } from '@/lib/status-variants';

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

export interface LayoutStation {
  id: string;
  stationId: string;
  model: string | null;
  status: string;
  isOnline: boolean;
  securityProfile: number;
  positionX: number;
  positionY: number;
  displayMessage: string | null;
  evses: EvseData[];
}

interface StationCardProps {
  station: LayoutStation;
  onDragEnd: (stationId: string, x: number, y: number) => void;
  currentDrawKw?: number | undefined;
  allocatedLimitKw?: number | null | undefined;
  collapseKey?: number;
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

function stationLevel(station: LayoutStation): string {
  let maxKw = 0;
  for (const evse of station.evses) {
    for (const conn of evse.connectors) {
      if (conn.maxPowerKw != null && conn.maxPowerKw > maxKw) {
        maxKw = conn.maxPowerKw;
      }
    }
  }
  if (maxKw >= 50) return 'DC Fast';
  if (maxKw >= 7) return 'Level 2';
  if (maxKw > 0) return 'Level 1';
  return '';
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
      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover/tip:block whitespace-nowrap rounded bg-popover px-1.5 py-0.5 text-xs text-popover-foreground shadow border z-[100]">
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
      return 'text-primary';
    case 2:
      return 'text-success';
    case 3:
      return 'text-warning';
    default:
      return 'text-muted-foreground';
  }
}

function utilizationBarColor(drawKw: number, limitKw: number): string {
  const pct = limitKw > 0 ? drawKw / limitKw : 0;
  if (pct >= 0.95) return 'bg-destructive';
  if (pct >= 0.8) return 'bg-warning';
  return 'bg-success';
}

function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

export function StationCard({
  station,
  onDragEnd,
  currentDrawKw,
  allocatedLimitKw,
  collapseKey,
}: StationCardProps): React.JSX.Element {
  const charging = isCharging(station);
  const energy = totalEnergy(station);
  const connectors = allConnectors(station);
  const level = stationLevel(station);
  const motionX = useMotionValue(station.positionX);
  const motionY = useMotionValue(station.positionY);
  const [zIndex, setZIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // Collapse when parent signals reset
  useEffect(() => {
    if (collapseKey != null && collapseKey > 0) {
      setExpanded(false);
    }
  }, [collapseKey]);

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
        const snappedX = snapToGrid(Math.max(0, motionX.get()));
        const snappedY = snapToGrid(Math.max(0, motionY.get()));
        motionX.set(snappedX);
        motionY.set(snappedY);
        onDragEnd(station.id, snappedX, snappedY);
      }}
      className={cn(
        'rounded-lg border bg-card text-card-foreground shadow-sm select-none',
        expanded ? 'w-[280px]' : 'w-[160px]',
        isDragging && 'ring-2 ring-primary shadow-lg',
      )}
    >
      <div className={cn(expanded ? 'p-4 space-y-3' : 'p-2.5 space-y-1.5')}>
        <div className="flex items-center gap-1.5">
          <span
            className="relative inline-flex h-2 w-2 shrink-0"
            title={station.isOnline ? 'Online' : 'Offline'}
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
          <span className={cn('font-semibold truncate', expanded ? 'text-sm' : 'text-xs')}>
            {station.stationId}
          </span>
          <Tooltip label={`Security Profile ${String(station.securityProfile)}`}>
            <span
              className={cn('flex items-center gap-0.5 shrink-0', spColor(station.securityProfile))}
            >
              <Shield className="h-3 w-3" />
              <span className="text-xs font-bold">{String(station.securityProfile)}</span>
            </span>
          </Tooltip>
          <button
            type="button"
            className="ml-auto rounded p-0.5 hover:bg-muted"
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((prev) => {
                if (!prev) {
                  globalDragCounter += 1;
                  setZIndex(globalDragCounter);
                }
                return !prev;
              });
            }}
          >
            {expanded ? (
              <Minus className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <Plus className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </button>
        </div>

        {expanded ? (
          <>
            <div className="flex items-center gap-2">
              <StationIcon status={station.status} charging={charging} dc={level === 'DC Fast'} />
              {level !== '' && (
                <span className="text-xs font-medium text-muted-foreground">{level}</span>
              )}
            </div>

            {charging && energy > 0 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center justify-center gap-1 text-sm font-medium text-primary"
              >
                <Zap className="h-4 w-4" />
                <span>{formatEnergy(energy)}</span>
              </motion.div>
            )}

            {station.displayMessage != null && (
              <div className="flex items-start gap-1.5 rounded border border-primary/20 bg-primary/5 px-2 py-1.5">
                <MessageSquare className="h-3 w-3 shrink-0 mt-0.5 text-primary" />
                <p className="text-xs leading-tight text-primary/70 line-clamp-2">
                  {station.displayMessage}
                </p>
              </div>
            )}

            {currentDrawKw != null &&
              currentDrawKw > 0 &&
              allocatedLimitKw != null &&
              allocatedLimitKw > 0 && (
                <div className="space-y-1">
                  <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn(
                        'h-full rounded-full transition-all',
                        utilizationBarColor(currentDrawKw, allocatedLimitKw),
                      )}
                      style={{
                        width: `${String(Math.min(100, (currentDrawKw / allocatedLimitKw) * 100))}%`,
                      }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground text-center">
                    {currentDrawKw.toFixed(1)} / {allocatedLimitKw.toFixed(1)} kW
                  </p>
                </div>
              )}

            <div className="space-y-2">
              {station.evses.map((evse) => (
                <div key={evse.evseId} className="rounded border p-2 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                      <Power className="h-3 w-3" />
                      EVSE {String(evse.evseId)}
                    </span>
                  </div>
                  {evse.connectors.map((conn) => (
                    <div
                      key={conn.connectorId}
                      className="flex items-center justify-between text-xs"
                    >
                      <div className="flex items-center gap-1.5">
                        <ConnectorIcon conn={conn} />
                        <span
                          className={cn(
                            conn.isPluggedIn ? 'text-primary' : 'text-muted-foreground',
                          )}
                        >
                          {conn.connectorType ?? `#${String(conn.connectorId)}`}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {conn.maxPowerKw != null && (
                          <span className="text-muted-foreground">
                            {String(conn.maxPowerKw)} kW
                          </span>
                        )}
                        {conn.isPluggedIn && conn.energyDeliveredWh != null && (
                          <motion.span
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="text-primary"
                          >
                            {formatEnergy(conn.energyDeliveredWh)}
                          </motion.span>
                        )}
                        <Badge
                          variant={stationCardConnectorStatusVariant(conn.status)}
                          className="text-xs px-1.5 py-0"
                        >
                          {conn.status}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <StationIcon status={station.status} charging={charging} dc={level === 'DC Fast'} />
              <div className="flex flex-col gap-1 min-w-0">
                <div className="flex flex-wrap gap-1">
                  {connectors.map((conn, i) => (
                    <ConnectorIcon key={i} conn={conn} />
                  ))}
                </div>
                {charging && energy > 0 && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex items-center gap-0.5 text-xs font-medium text-primary"
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
                    <span>{currentDrawKw.toFixed(1)} kW</span>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </motion.div>
  );
}
