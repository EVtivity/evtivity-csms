// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { permissionCatalog } from '@evtivity/lib/permissions';
import { FLEET_MANAGER_ROLE_NAME } from '@evtivity/lib/user-access-scope';
import { TabPanel } from '@/components/ui/tab-panel';
import { Badge } from '@/components/ui/badge';
import { Pagination } from '@/components/ui/pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CreateButton } from '@/components/create-button';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { useHasPermission } from '@/lib/auth';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

export interface FleetManager {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  isActive: boolean;
  lastLoginAt: string | null;
  permissions: string[];
}

/** The New User page with the Fleet Manager role and this fleet chosen. */
export function fleetManagerCreatePath(fleetId: string): string {
  const params = new URLSearchParams({ role: FLEET_MANAGER_ROLE_NAME, fleetId });
  return `/users/new?${params.toString()}`;
}

/** "Fleets (Read), RFID Cards (Write)": a permission list in the editor's words. */
export function permissionSummary(permissions: readonly string[], t: TFunction): string {
  const groups = permissionCatalog.groups();
  return permissions
    .map((permission) => {
      const [resource, action] = permission.split(/:(?=[^:]+$)/);
      const group = groups.find((g) => g.resource === resource);
      const label = group != null ? t(group.labelKey, resource ?? permission) : permission;
      const level = action === 'write' ? t('users.permissionWrite') : t('users.permissionRead');
      return `${label} (${level})`;
    })
    .join(', ');
}

/** The fleet users of a fleet, for all-site admins (the fleet page Fleet Managers tab). */
export function FleetManagersTab({ fleetId }: { fleetId: string }): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const timezone = useUserTimezone();
  const canWriteUsers = useHasPermission('users:write');
  const { data, page, totalPages, setPage, isLoading, isError, refetch } =
    usePaginatedQuery<FleetManager>(
      ['fleets', fleetId, 'managers'],
      `/v1/fleets/${fleetId}/managers`,
    );
  const rows = data ?? [];

  return (
    <>
      <TabPanel
        title={t('fleets.managers.title')}
        description={t('fleets.managers.description')}
        actions={
          canWriteUsers ? (
            <CreateButton
              label={t('fleets.managers.add')}
              testId="fleet-manager-add"
              onClick={() => {
                void navigate(fleetManagerCreatePath(fleetId));
              }}
            />
          ) : undefined
        }
        body="flush"
        isLoading={isLoading}
        isError={isError}
        onRetry={refetch}
        isEmpty={rows.length === 0}
        emptyMessage={t('fleets.managers.empty')}
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('common.name')}</TableHead>
                <TableHead>{t('common.email')}</TableHead>
                <TableHead>{t('fleets.managers.permissions')}</TableHead>
                <TableHead>{t('fleets.managers.lastSignIn')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((manager) => {
                const name = [manager.firstName, manager.lastName]
                  .filter((part) => part != null && part !== '')
                  .join(' ');
                return (
                  <TableRow
                    key={manager.id}
                    className="cursor-pointer"
                    data-testid={`fleet-manager-row-${manager.id}`}
                    onClick={() => {
                      void navigate(`/users/${manager.id}`);
                    }}
                  >
                    <TableCell className="font-medium text-link" data-testid="row-click-target">
                      <span className="wrap-anywhere">
                        {name !== '' ? name : t('common.unnamedUser')}
                      </span>
                      {!manager.isActive && (
                        <Badge variant="outline" className="ml-2">
                          {t('common.inactive')}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="wrap-anywhere">{manager.email}</TableCell>
                    <TableCell
                      className="min-w-64 whitespace-normal text-sm"
                      data-testid="fleet-manager-permissions"
                    >
                      {permissionSummary(manager.permissions, t)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {manager.lastLoginAt != null
                        ? formatDateTime(manager.lastLoginAt, timezone)
                        : t('fleets.managers.neverSignedIn')}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </TabPanel>
      {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />}
    </>
  );
}
