// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { CreateButton } from '@/components/create-button';
import { SearchInput } from '@/components/search-input';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { cn } from '@/lib/utils';
import { supportCaseStatusVariant, supportCasePriorityVariant } from '@/lib/status-variants';

interface User {
  id: string;
  firstName: string | null;
  lastName: string | null;
}

interface SupportCase {
  id: string;
  caseNumber: string;
  subject: string;
  status: string;
  category: string;
  priority: string;
  createdByDriver: boolean;
  driverName: string | null;
  assignedToName: string | null;
  assignedTo: string | null;
  driverId: string | null;
  isRead: boolean;
  createdAt: string;
}

const STATUS_OPTIONS = ['open', 'in_progress', 'waiting_on_driver', 'resolved', 'closed'] as const;

const CATEGORY_OPTIONS = [
  'billing_dispute',
  'charging_failure',
  'connector_damage',
  'account_issue',
  'payment_problem',
  'reservation_issue',
  'general_inquiry',
] as const;

const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'urgent'] as const;

export function SupportCases(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [assignedToFilter, setAssignedToFilter] = useState('');

  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<{ data: User[]; total: number }>('/v1/users?limit=100'),
  });

  const {
    data: cases,
    isLoading,
    page,
    totalPages,
    setPage,
    search,
    setSearch,
  } = usePaginatedQuery<SupportCase>('support-cases', '/v1/support-cases', {
    status: statusFilter,
    category: categoryFilter,
    priority: priorityFilter,
    assignedTo: assignedToFilter,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 [&>*]:w-full sm:flex-row sm:items-start sm:justify-between sm:[&>*]:w-auto">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{t('supportCases.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('supportCases.subtitle')}</p>
        </div>
        <CreateButton
          label={t('supportCases.createCase')}
          onClick={() => {
            void navigate('/support-cases/new');
          }}
        />
      </div>

      <Card>
        <CardContent className="grid grid-cols-1 gap-4 p-4 md:grid-cols-3 lg:grid-cols-5">
          <div className="space-y-2">
            <Label htmlFor="cases-search">{t('supportCases.search')}</Label>
            <SearchInput
              id="cases-search"
              value={search}
              onDebouncedChange={setSearch}
              placeholder={t('supportCases.searchPlaceholder')}
              className="h-9 max-w-none"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cases-status">{t('common.status')}</Label>
            <Select
              id="cases-status"
              className="h-9"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">{t('supportCases.allStatuses')}</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {t(`supportCases.statuses.${s}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cases-category">{t('supportCases.category')}</Label>
            <Select
              id="cases-category"
              className="h-9"
              value={categoryFilter}
              onChange={(e) => {
                setCategoryFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">{t('supportCases.allCategories')}</option>
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {t(`supportCases.categories.${c}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cases-priority">{t('supportCases.priority')}</Label>
            <Select
              id="cases-priority"
              className="h-9"
              value={priorityFilter}
              onChange={(e) => {
                setPriorityFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">{t('supportCases.allPriorities')}</option>
              {PRIORITY_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {t(`supportCases.priorities.${p}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cases-assignee">{t('supportCases.assignedTo')}</Label>
            <Select
              id="cases-assignee"
              className="h-9"
              value={assignedToFilter}
              onChange={(e) => {
                setAssignedToFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">{t('supportCases.allAssignedTo')}</option>
              {users?.data.map((u) => (
                <option key={u.id} value={u.id}>
                  {[u.firstName, u.lastName].filter(Boolean).join(' ')}
                </option>
              ))}
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('supportCases.caseNumber')}</TableHead>
                <TableHead>{t('supportCases.subject')}</TableHead>
                <TableHead>{t('supportCases.driver')}</TableHead>
                <TableHead>{t('supportCases.category')}</TableHead>
                <TableHead>{t('supportCases.priority')}</TableHead>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead>{t('supportCases.assignedTo')}</TableHead>
                <TableHead>{t('common.created')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    {t('common.loading')}
                  </TableCell>
                </TableRow>
              )}
              {cases?.map((c) => (
                <TableRow
                  key={c.id}
                  data-testid={`case-row-${c.id}`}
                  className={cn(
                    'cursor-pointer',
                    !c.isRead && 'font-semibold bg-primary/5 border-l-2 border-l-primary',
                  )}
                  onClick={() => {
                    void navigate(`/support-cases/${c.id}`);
                  }}
                >
                  <TableCell
                    className="font-medium text-primary whitespace-nowrap"
                    data-testid="row-click-target"
                  >
                    {c.caseNumber}
                  </TableCell>
                  <TableCell className="max-w-[200px] truncate">{c.subject}</TableCell>
                  <TableCell>
                    {c.driverName ?? <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {t(`supportCases.categories.${c.category}`, c.category)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={supportCasePriorityVariant(c.priority)}>
                      {t(`supportCases.priorities.${c.priority}`, c.priority)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={supportCaseStatusVariant(c.status)}>
                      {t(`supportCases.statuses.${c.status}`, c.status)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {c.assignedToName ?? <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell>{formatDateTime(c.createdAt, timezone)}</TableCell>
                </TableRow>
              ))}
              {cases?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    {t('supportCases.noCases')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
