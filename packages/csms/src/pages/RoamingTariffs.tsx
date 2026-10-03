// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
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
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { useRoamingTabAction } from './RoamingLayout';
import { LoadingLogo } from '@/components/loading-logo';

interface TariffMapping {
  id: number;
  tariffId: string | null;
  pricingGroupId: string | null;
  partnerId: string | null;
  ocpiTariffId: string;
  createdAt: string;
  updatedAt: string;
  tariffName: string | null;
  pricingGroupName: string | null;
  partnerName: string | null;
}

export function RoamingTariffs(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const timezone = useUserTimezone();

  const {
    data: mappings,
    isLoading,
    page,
    totalPages,
    setPage,
  } = usePaginatedQuery<TariffMapping>('ocpi-tariff-mappings', '/v1/ocpi/tariff-mappings');

  useRoamingTabAction(
    useMemo(
      () => (
        <CreateButton
          label={t('roaming.tariffs.addMapping')}
          onClick={() => {
            void navigate('/roaming/tariffs/new');
          }}
        />
      ),
      [t, navigate],
    ),
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('roaming.tariffs.ocpiTariffId')}</TableHead>
                <TableHead>{t('roaming.tariffs.publishedFrom')}</TableHead>
                <TableHead>{t('roaming.tariffs.partner')}</TableHead>
                <TableHead>{t('common.lastUpdated')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center">
                    <LoadingLogo size="inline" />
                  </TableCell>
                </TableRow>
              ) : mappings == null || mappings.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    {t('roaming.tariffs.noMappings')}
                  </TableCell>
                </TableRow>
              ) : (
                mappings.map((mapping) => (
                  <TableRow
                    key={mapping.id}
                    className="cursor-pointer"
                    data-testid={`roaming-tariff-row-${String(mapping.id)}`}
                    onClick={() => {
                      void navigate(`/roaming/tariffs/${String(mapping.id)}`);
                    }}
                  >
                    <TableCell
                      className="whitespace-nowrap font-medium"
                      data-testid="row-click-target"
                    >
                      {mapping.ocpiTariffId}
                    </TableCell>
                    <TableCell>
                      {mapping.pricingGroupId != null
                        ? `${t('roaming.tariffs.sourcePricingGroup')}: ${mapping.pricingGroupName ?? '-'}`
                        : `${t('roaming.tariffs.sourceTariff')}: ${mapping.tariffName ?? '-'}`}
                    </TableCell>
                    <TableCell>{mapping.partnerName ?? t('roaming.tariffs.allPartners')}</TableCell>
                    <TableCell>{formatDateTime(mapping.updatedAt, timezone)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />}
    </div>
  );
}
