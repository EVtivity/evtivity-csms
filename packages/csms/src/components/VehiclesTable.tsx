// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router-dom';
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
import { CopyableId } from '@/components/copyable-id';
import { Pagination } from '@/components/ui/pagination';

export interface Vehicle {
  id: string;
  driverId: string;
  make: string | null;
  model: string | null;
  year: string | null;
  vin: string | null;
  licensePlate: string | null;
  driverName?: string;
}

interface VehiclesTableProps {
  vehicles: Vehicle[] | undefined;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  showDriver?: boolean;
  isLoading?: boolean;
  emptyMessage?: string;
  onEdit?: (vehicle: Vehicle) => void;
  onDelete?: (vehicle: Vehicle) => void;
  onRowClick?: (vehicle: Vehicle) => void;
}

export function VehiclesTable({
  vehicles,
  page,
  totalPages,
  onPageChange,
  showDriver = false,
  isLoading,
  emptyMessage,
  onEdit,
  onDelete,
  onRowClick,
}: VehiclesTableProps): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const hasActions = onEdit != null || onDelete != null;
  const baseCols = 6;
  const colSpan = baseCols + (showDriver ? 1 : 0) + (hasActions ? 1 : 0);

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('vehicles.make')}</TableHead>
              <TableHead>{t('vehicles.model')}</TableHead>
              <TableHead>{t('vehicles.vehicleId')}</TableHead>
              {showDriver && <TableHead>{t('tokens.driver')}</TableHead>}
              <TableHead>{t('vehicles.year')}</TableHead>
              <TableHead>{t('vehicles.vin')}</TableHead>
              <TableHead>{t('vehicles.licensePlate')}</TableHead>
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
                  {v.make ?? '--'}
                </TableCell>
                <TableCell>{v.model ?? '--'}</TableCell>
                <TableCell>
                  <CopyableId id={v.id} variant="table" />
                </TableCell>
                {showDriver && (
                  <TableCell>
                    <button
                      type="button"
                      className="font-medium text-primary hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        void navigate(`/drivers/${v.driverId}`);
                      }}
                    >
                      {v.driverName ?? '--'}
                    </button>
                  </TableCell>
                )}
                <TableCell>{v.year ?? '--'}</TableCell>
                <TableCell>{v.vin ?? '--'}</TableCell>
                <TableCell>{v.licensePlate ?? '--'}</TableCell>
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
            {vehicles?.length === 0 && (
              <TableRow>
                <TableCell colSpan={colSpan} className="text-center text-muted-foreground">
                  {emptyMessage ?? t('vehicles.noVehicles')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={onPageChange} />
    </>
  );
}
