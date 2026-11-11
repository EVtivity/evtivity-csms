// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router';
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
import { EmptyState, ErrorState, LoadingState, TableStateRow } from '@/components/ui/content-state';
import { AccountAvatar, type AvatarData } from '@/components/AccountAvatar';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import type { ListSort } from '@/hooks/use-list-sort';

export const DRIVERS_COLUMNS: ColumnMeta[] = [
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

/**
 * The sort keys of `GET /v1/drivers` and `GET /v1/fleets/:id/drivers` (`driverListSort` in
 * the API, `lib/sorts/driver-list-sort.ts`).
 */
export const DRIVER_SORT_KEYS = ['name', 'email', 'phone', 'status', 'createdAt'] as const;
export type DriverSortKey = (typeof DRIVER_SORT_KEYS)[number];

export interface Driver {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  /** Set when the personal data was erased: the name is blank. */
  erasedAt?: string | null;
  createdAt: string;
  /** The avatar the driver set in the portal or app. */
  avatar?: AvatarData | null;
}

/** An extra column a caller adds before the remove button (the fleet member billing switch). */
export interface DriversTableExtraColumn {
  header: string;
  render: (driver: Driver) => React.ReactNode;
}

interface DriversTableProps {
  drivers: Driver[] | undefined;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  timezone: string;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: (() => void) | undefined;
  emptyMessage?: string;
  onRemove?: (driverId: string) => void;
  removeDisabled?: boolean;
  visibility?: ColumnVisibility;
  extraColumn?: DriversTableExtraColumn;
  /** The list's sort; without it the headers do not sort. */
  sort?: ListSort<DriverSortKey> | undefined;
}

export function DriversTable({
  drivers,
  timezone,
  isLoading,
  isError = false,
  onRetry,
  emptyMessage,
  onRemove,
  removeDisabled,
  visibility,
  extraColumn,
  sort,
}: DriversTableProps): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const hasRemove = onRemove != null;
  const isVisible = (key: string): boolean => visibility == null || visibility[key] !== false;
  const visibleCount = DRIVERS_COLUMNS.filter((c) => isVisible(c.key)).length;
  const colSpan = visibleCount + (extraColumn != null ? 1 : 0) + (hasRemove ? 1 : 0);

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {isVisible('driverName') && (
                <SortableTableHead sortKey="name" sort={sort}>
                  {t('drivers.driverName')}
                </SortableTableHead>
              )}
              {isVisible('email') && (
                <SortableTableHead sortKey="email" sort={sort}>
                  {t('common.email')}
                </SortableTableHead>
              )}
              {isVisible('phone') && (
                <SortableTableHead sortKey="phone" sort={sort}>
                  {t('drivers.phone')}
                </SortableTableHead>
              )}
              {isVisible('status') && (
                <SortableTableHead sortKey="status" sort={sort}>
                  {t('common.status')}
                </SortableTableHead>
              )}
              {isVisible('created') && (
                <SortableTableHead sortKey="createdAt" sort={sort}>
                  {t('common.created')}
                </SortableTableHead>
              )}
              {extraColumn != null && <TableHead>{extraColumn.header}</TableHead>}
              {hasRemove && <TableHead />}
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
            {drivers?.map((driver) => (
              <TableRow
                key={driver.id}
                data-testid={`driver-row-${driver.id}`}
                className="cursor-pointer"
                onClick={() => {
                  void navigate(`/drivers/${driver.id}`);
                }}
              >
                {isVisible('driverName') && (
                  <TableCell className="font-medium text-link" data-testid="row-click-target">
                    <span className="inline-flex items-center gap-2">
                      {driver.erasedAt == null && (
                        <AccountAvatar
                          avatar={driver.avatar}
                          firstName={driver.firstName}
                          lastName={driver.lastName}
                        />
                      )}
                      {driver.erasedAt != null
                        ? t('drivers.erasedName')
                        : `${driver.firstName} ${driver.lastName}`}
                    </span>
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
                {extraColumn != null && (
                  <TableCell
                    onClick={(e) => {
                      e.stopPropagation();
                    }}
                  >
                    {extraColumn.render(driver)}
                  </TableCell>
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
            {!isLoading && !isError && drivers?.length === 0 && (
              <TableStateRow colSpan={colSpan}>
                <EmptyState>{emptyMessage ?? t('drivers.noDriversFound')}</EmptyState>
              </TableStateRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
