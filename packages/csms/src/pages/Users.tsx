// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CreateButton } from '@/components/create-button';
import { SearchInput } from '@/components/search-input';
import { ResponsiveFilters } from '@/components/responsive-filters';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { Pagination } from '@/components/ui/pagination';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { api } from '@/lib/api';
import { CopyableId } from '@/components/copyable-id';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

interface User {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  roleId: string;
  hasAllSiteAccess: boolean;
  siteCount: number | null;
  isActive: boolean;
  mustResetPassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

interface Role {
  id: string;
  name: string;
}

export function UsersPage(): React.JSX.Element {
  const timezone = useUserTimezone();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [filterRoleId, setFilterRoleId] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const {
    data: users,
    isLoading,
    isError,
    page,
    totalPages,
    setPage,
    search,
    setSearch,
  } = usePaginatedQuery<User>('users', '/v1/users', {
    roleId: filterRoleId,
    status: filterStatus,
  });

  const { data: roles } = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<Role[]>('/v1/roles'),
  });

  const resendInviteMutation = useMutation({
    mutationFn: (id: string) => api.post(`/v1/users/${id}/resend-invite`, {}),
  });

  function getRoleName(id: string): string {
    return roles?.find((r) => r.id === id)?.name ?? id;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl md:text-3xl font-bold">{t('users.title')}</h1>
        <CreateButton
          label={t('users.addUser')}
          onClick={() => {
            void navigate('/users/new');
          }}
        />
      </div>

      <div className="flex items-center gap-1.5">
        <SearchInput
          value={search}
          onDebouncedChange={setSearch}
          placeholder={t('users.searchPlaceholder')}
        />
        <InfoTooltip content={t('users.searchHint')} />
        <ResponsiveFilters
          activeCount={[filterRoleId, filterStatus].filter((v) => v !== '').length}
        >
          <Select
            aria-label="Filter by role"
            value={filterRoleId}
            onChange={(e) => {
              setFilterRoleId(e.target.value);
            }}
            className="h-9 w-auto"
          >
            <option value="">{t('users.allRoles')}</option>
            {roles?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by status"
            value={filterStatus}
            onChange={(e) => {
              setFilterStatus(e.target.value);
            }}
            className="h-9 w-auto"
          >
            <option value="">{t('users.allStatuses')}</option>
            <option value="active">{t('common.active')}</option>
            <option value="inactive">{t('common.inactive')}</option>
          </Select>
        </ResponsiveFilters>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('users.fullName')}</TableHead>
              <TableHead>{t('common.email')}</TableHead>
              <TableHead>{t('users.userId')}</TableHead>
              <TableHead>{t('users.role')}</TableHead>
              <TableHead>{t('users.siteAccessColumn')}</TableHead>
              <TableHead>{t('common.status')}</TableHead>
              <TableHead>{t('users.lastLogin')}</TableHead>
              <TableHead>{t('common.created')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground">
                  {t('common.loading')}
                </TableCell>
              </TableRow>
            )}
            {isError && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-destructive">
                  {t('common.loadError')}
                </TableCell>
              </TableRow>
            )}
            {users?.map((user) => (
              <TableRow
                key={user.id}
                data-testid={`user-row-${user.id}`}
                className="cursor-pointer"
                onClick={() => {
                  void navigate(`/users/${user.id}`);
                }}
              >
                <TableCell
                  className="font-medium text-primary whitespace-nowrap"
                  data-testid="row-click-target"
                >
                  {[user.firstName, user.lastName].filter(Boolean).join(' ') || '-'}
                </TableCell>
                <TableCell>{user.email}</TableCell>
                <TableCell>
                  <CopyableId id={user.id} variant="table" />
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{getRoleName(user.roleId)}</Badge>
                </TableCell>
                <TableCell className="text-sm">
                  {user.hasAllSiteAccess
                    ? t('users.allSites')
                    : t('users.sitesCount', { count: user.siteCount ?? 0 })}
                </TableCell>
                <TableCell>
                  {user.mustResetPassword ? (
                    <Badge variant="warning">{t('users.invitePending')}</Badge>
                  ) : (
                    <Badge variant={user.isActive ? 'default' : 'outline'}>
                      {user.isActive ? t('common.active') : t('common.inactive')}
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  {user.lastLoginAt != null
                    ? formatDateTime(user.lastLoginAt, timezone)
                    : t('common.never')}
                </TableCell>
                <TableCell>{formatDateTime(user.createdAt, timezone)}</TableCell>
                <TableCell
                  className="text-right"
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                >
                  {user.mustResetPassword && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={resendInviteMutation.isPending}
                      onClick={() => {
                        resendInviteMutation.mutate(user.id);
                      }}
                    >
                      <Send className="h-4 w-4" />
                      {t('users.resendInvite')}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {users?.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground">
                  {t('users.noUsersFound')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
