// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
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
import { formatDate } from '@/lib/timezone';

export interface Driver {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  createdAt: string;
}

interface DriversTableProps {
  drivers: Driver[] | undefined;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  timezone: string;
  isLoading?: boolean;
  emptyMessage?: string;
  onRemove?: (driverId: string) => void;
  removeDisabled?: boolean;
}

export function DriversTable({
  drivers,
  page,
  totalPages,
  onPageChange,
  timezone,
  isLoading,
  emptyMessage,
  onRemove,
  removeDisabled,
}: DriversTableProps): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const hasRemove = onRemove != null;
  const colSpan = hasRemove ? 7 : 6;

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('drivers.driverName')}</TableHead>
              <TableHead>{t('drivers.driverId')}</TableHead>
              <TableHead>{t('common.email')}</TableHead>
              <TableHead>{t('drivers.phone')}</TableHead>
              <TableHead>{t('common.status')}</TableHead>
              <TableHead>{t('common.created')}</TableHead>
              {hasRemove && <TableHead />}
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
            {drivers?.map((driver) => (
              <TableRow
                key={driver.id}
                data-testid={`driver-row-${driver.id}`}
                className="cursor-pointer"
                onClick={() => {
                  void navigate(`/drivers/${driver.id}`);
                }}
              >
                <TableCell className="font-medium text-primary" data-testid="row-click-target">
                  {driver.firstName} {driver.lastName}
                </TableCell>
                <TableCell>
                  <CopyableId id={driver.id} variant="table" />
                </TableCell>
                <TableCell>{driver.email ?? '-'}</TableCell>
                <TableCell>{driver.phone ?? '-'}</TableCell>
                <TableCell>
                  <Badge variant={driver.isActive ? 'default' : 'secondary'}>
                    {driver.isActive ? t('common.active') : t('common.inactive')}
                  </Badge>
                </TableCell>
                <TableCell>{formatDate(driver.createdAt, timezone)}</TableCell>
                {hasRemove && (
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemove(driver.id);
                      }}
                      disabled={removeDisabled}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {drivers?.length === 0 && (
              <TableRow>
                <TableCell colSpan={colSpan} className="text-center text-muted-foreground">
                  {emptyMessage ?? t('drivers.noDriversFound')}
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
