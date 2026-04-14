// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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

interface TariffMapping {
  id: number;
  tariffId: string;
  partnerId: string | null;
  ocpiTariffId: string;
  currency: string;
  createdAt: string;
  updatedAt: string;
  tariffName: string | null;
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl md:text-3xl font-bold">{t('roaming.tariffs.title')}</h1>
        <CreateButton
          label={t('roaming.tariffs.addMapping')}
          onClick={() => {
            void navigate('/roaming/tariffs/new');
          }}
        />
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('roaming.tariffs.internalTariff')}</TableHead>
            <TableHead>{t('roaming.tariffs.ocpiTariffId')}</TableHead>
            <TableHead>{t('roaming.tariffs.currency')}</TableHead>
            <TableHead>{t('roaming.tariffs.partner')}</TableHead>
            <TableHead>{t('common.created')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center">
                {t('common.loading')}
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
                <TableCell className="font-medium" data-testid="row-click-target">
                  {mapping.tariffName ?? '-'}
                </TableCell>
                <TableCell className="whitespace-nowrap">{mapping.ocpiTariffId}</TableCell>
                <TableCell>{mapping.currency}</TableCell>
                <TableCell>{mapping.partnerName ?? t('roaming.tariffs.allPartners')}</TableCell>
                <TableCell>{formatDateTime(mapping.updatedAt, timezone)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />}
    </div>
  );
}
