// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState, ErrorState, LoadingState, TableStateRow } from '@/components/ui/content-state';
import { Badge } from '@/components/ui/badge';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { formatVehicleId } from '@evtivity/lib/vehicle-id';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import type { ListSort } from '@/hooks/use-list-sort';

/** The sort keys of `GET /v1/fleets/:id/vehicles` (`vehicleListSort` in the API). */
export const VEHICLE_SORT_KEYS = [
  'make',
  'model',
  'driver',
  'year',
  'vin',
  'licensePlate',
] as const;
export type VehicleSortKey = (typeof VEHICLE_SORT_KEYS)[number];

export interface Vehicle {
  id: string;
  driverId: string;
  make: string | null;
  model: string | null;
  year: string | null;
  vin: string | null;
  licensePlate: string | null;
  driverName?: string;
  evccid?: string | null;
  autochargeEnabled?: boolean;
  autochargeBlockedAt?: string | null;
  lastSeen?: { stationId: string; siteName: string | null; at: string } | null;
}

interface VehiclesTableProps {
  vehicles: Vehicle[] | undefined;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  showDriver?: boolean;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: (() => void) | undefined;
  emptyMessage?: string;
  onEdit?: (vehicle: Vehicle) => void;
  onDelete?: (vehicle: Vehicle) => void;
  onRowClick?: (vehicle: Vehicle) => void;
  /** The Autocharge columns: EVCCID, Autocharge and Last Seen (a driver's vehicles). */
  showAutocharge?: boolean;
  /** The list's sort (a fleet's vehicles); without it the headers do not sort. */
  sort?: ListSort<VehicleSortKey> | undefined;
}

export function VehiclesTable({
  vehicles,
  page,
  totalPages,
  onPageChange,
  showDriver = false,
  isLoading,
  isError = false,
  onRetry,
  emptyMessage,
  onEdit,
  onDelete,
  onRowClick,
  showAutocharge = false,
  sort,
}: VehiclesTableProps): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const timezone = useUserTimezone();
  const hasActions = onEdit != null || onDelete != null;
  const baseCols = 5;
  const colSpan = baseCols + (showDriver ? 1 : 0) + (hasActions ? 1 : 0) + (showAutocharge ? 3 : 0);

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead sortKey="make" sort={sort}>
                {t('vehicles.make')}
              </SortableTableHead>
              <SortableTableHead sortKey="model" sort={sort}>
                {t('vehicles.model')}
              </SortableTableHead>
              {showDriver && (
                <SortableTableHead sortKey="driver" sort={sort}>
                  {t('tokens.driver')}
                </SortableTableHead>
              )}
              <SortableTableHead sortKey="year" sort={sort}>
                {t('vehicles.year')}
              </SortableTableHead>
              <SortableTableHead sortKey="vin" sort={sort}>
                {t('vehicles.vin')}
              </SortableTableHead>
              <SortableTableHead sortKey="licensePlate" sort={sort}>
                {t('vehicles.licensePlate')}
              </SortableTableHead>
              {showAutocharge && (
                <>
                  <TableHead>{t('vehicles.evccid')}</TableHead>
                  <TableHead>{t('vehicles.autocharge')}</TableHead>
                  <TableHead>{t('vehicles.lastSeen')}</TableHead>
                </>
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
            {vehicles?.map((v) => (
              <TableRow
                key={v.id}
                className={onRowClick != null ? 'cursor-pointer' : ''}
                data-testid={`vehicle-row-${v.id}`}
                onClick={() => {
                  onRowClick?.(v);
                }}
              >
                <TableCell className="font-medium" data-testid="row-click-target">
                  {v.make ?? 'n/a'}
                </TableCell>
                <TableCell>{v.model ?? 'n/a'}</TableCell>
                {showDriver && (
                  <TableCell>
                    <button
                      type="button"
                      className="font-medium text-link hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        void navigate(`/drivers/${v.driverId}`);
                      }}
                    >
                      {v.driverName ?? 'n/a'}
                    </button>
                  </TableCell>
                )}
                <TableCell>{v.year ?? 'n/a'}</TableCell>
                <TableCell>{v.vin ?? 'n/a'}</TableCell>
                <TableCell>{v.licensePlate ?? 'n/a'}</TableCell>
                {showAutocharge && (
                  <>
                    <TableCell className="font-mono whitespace-nowrap">
                      {v.evccid != null ? formatVehicleId(v.evccid) : 'n/a'}
                    </TableCell>
                    <TableCell>
                      {v.autochargeBlockedAt != null ? (
                        <Badge variant="destructive">{t('vehicles.blocked')}</Badge>
                      ) : v.autochargeEnabled === true ? (
                        <Badge variant="success">{t('vehicles.autochargeOn')}</Badge>
                      ) : (
                        <span className="text-muted-foreground">{t('vehicles.autochargeOff')}</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {v.lastSeen != null
                        ? t('vehicles.lastSeenValue', {
                            station: v.lastSeen.stationId,
                            time: formatDateTime(v.lastSeen.at, timezone),
                          })
                        : '-'}
                    </TableCell>
                  </>
                )}
                {hasActions && (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {onEdit != null && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t('vehicles.editVehicle')}
                          onClick={(e) => {
                            e.stopPropagation();
                            onEdit(v);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                      {onDelete != null && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t('vehicles.deleteVehicle')}
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete(v);
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {!isLoading && !isError && vehicles?.length === 0 && (
              <TableStateRow colSpan={colSpan}>
                <EmptyState>{emptyMessage ?? t('vehicles.noVehicles')}</EmptyState>
              </TableStateRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={onPageChange} />
    </>
  );
}
