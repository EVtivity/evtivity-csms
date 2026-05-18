// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Calendar } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { CreateButton } from '@/components/create-button';
import { SearchInput } from '@/components/search-input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TableSkeleton } from '@/components/TableSkeleton';
import { api } from '@/lib/api';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import type { PricingGroup } from '@/lib/types';

export function Pricing(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const timezone = useUserTimezone();
  const [search, setSearch] = useState('');

  const { data: groups, isLoading } = useQuery({
    queryKey: ['pricing-groups'],
    queryFn: () => api.get<PricingGroup[]>('/v1/pricing-groups'),
  });

  const filtered = groups?.filter((group) => {
    if (search === '') return true;
    const q = search.toLowerCase();
    return (
      group.name.toLowerCase().includes(q) ||
      (group.description?.toLowerCase().includes(q) ?? false) ||
      group.id.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 [&>*]:w-full sm:flex-row sm:items-start sm:justify-between sm:[&>*]:w-auto">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl">{t('pricing.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('pricing.subtitle')}</p>
        </div>
        <div className="flex flex-col gap-2 [&>*]:w-full sm:flex-row sm:items-center sm:[&>*]:w-auto">
          <Button
            variant="outline"
            onClick={() => {
              void navigate('/pricing/holidays');
            }}
          >
            <Calendar className="h-4 w-4" />
            {t('pricing.manageHolidays')}
          </Button>
          <CreateButton
            label={t('pricing.createPricingGroup')}
            onClick={() => {
              void navigate('/pricing/new');
            }}
          />
        </div>
      </div>

      <Card>
        <CardContent className="p-4">
          <SearchInput
            value={search}
            onDebouncedChange={setSearch}
            placeholder={t('common.search')}
            className="h-10 w-full sm:max-w-half-vw"
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="overflow-x-auto p-4">
          {isLoading && <TableSkeleton columns={5} rows={5} />}

          {filtered != null && filtered.length === 0 && (
            <p className="text-center text-sm text-muted-foreground">
              {t('pricing.noTariffsFound')}
            </p>
          )}

          {filtered != null && filtered.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('pricing.pricingGroupId')}</TableHead>
                    <TableHead>{t('pricing.groupName')}</TableHead>
                    <TableHead>{t('common.description')}</TableHead>
                    <TableHead>{t('common.default')}</TableHead>
                    <TableHead>{t('common.created')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((group) => (
                    <TableRow
                      key={group.id}
                      data-testid={`pricing-group-row-${group.id}`}
                      className="cursor-pointer"
                      onClick={() => {
                        void navigate(`/pricing/${group.id}`);
                      }}
                    >
                      <TableCell className="text-muted-foreground">{group.id}</TableCell>
                      <TableCell
                        className="font-medium text-primary"
                        data-testid="row-click-target"
                      >
                        {group.name}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {group.description ?? 'n/a'}
                      </TableCell>
                      <TableCell>
                        {group.isDefault && <Badge variant="default">{t('common.default')}</Badge>}
                      </TableCell>
                      <TableCell>{formatDateTime(group.createdAt, timezone)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
