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
import { formatDate } from '@/lib/timezone';
import type { ColumnMeta, ColumnVisibility } from '@/lib/column-visibility';
import { LoadingLogo } from '@/components/loading-logo';

export const DRIVERS_COLUMNS: ColumnMeta[] = [
  {
    key: 'driverId',
    label: 'drivers.driverId',
    defaultVisible: true,
    defaultVisibleMobile: false,
    alwaysVisible: true,
  },
  {
    key: 'driverName',
    label: 'drivers.driverName',
    defaultVisible: true,
    defaultVisibleMobile: true,
    alwaysVisible: true,
  },
  { key: 'email', label: 'common.email', defaultVisible: true, defaultVisibleMobile: true },
  { key: 'phone', label: 'drivers.phone', defaultVisible: true, defaultVisibleMobile: false },
  { key: 'status', label: 'common.status', defaultVisible: true, defaultVisibleMobile: true },
  { key: 'created', label: 'common.created', defaultVisible: true, defaultVisibleMobile: false },
];

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
  visibility?: ColumnVisibility;
}

export function DriversTable({
  drivers,
  timezone,
  isLoading,
  emptyMessage,
  onRemove,
  removeDisabled,
  visibility,
}: DriversTableProps): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const hasRemove = onRemove != null;
  const isVisible = (key: string): boolean => visibility == null || visibility[key] !== false;
  const visibleCount = DRIVERS_COLUMNS.filter((c) => isVisible(c.key)).length;
  const colSpan = visibleCount + (hasRemove ? 1 : 0);

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {isVisible('driverId') && <TableHead>{t('drivers.driverId')}</TableHead>}
              {isVisible('driverName') && <TableHead>{t('drivers.driverName')}</TableHead>}
              {isVisible('email') && <TableHead>{t('common.email')}</TableHead>}
              {isVisible('phone') && <TableHead>{t('drivers.phone')}</TableHead>}
              {isVisible('status') && <TableHead>{t('common.status')}</TableHead>}
              {isVisible('created') && <TableHead>{t('common.created')}</TableHead>}
              {hasRemove && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading === true && (
              <TableRow>
                <TableCell colSpan={colSpan} className="text-center text-muted-foreground">
                  <LoadingLogo size="inline" />
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
                {isVisible('driverId') && (
                  <TableCell className="text-muted-foreground">{driver.id}</TableCell>
                )}
                {isVisible('driverName') && (
                  <TableCell className="font-medium text-primary" data-testid="row-click-target">
                    {driver.firstName} {driver.lastName}
                  </TableCell>
                )}
                {isVisible('email') && <TableCell>{driver.email ?? '-'}</TableCell>}
                {isVisible('phone') && <TableCell>{driver.phone ?? '-'}</TableCell>}
                {isVisible('status') && (
                  <TableCell>
                    <Badge variant={driver.isActive ? 'default' : 'secondary'}>
                      {driver.isActive ? t('common.active') : t('common.inactive')}
                    </Badge>
                  </TableCell>
                )}
                {isVisible('created') && (
                  <TableCell>{formatDate(driver.createdAt, timezone)}</TableCell>
                )}
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
    </>
  );
}
