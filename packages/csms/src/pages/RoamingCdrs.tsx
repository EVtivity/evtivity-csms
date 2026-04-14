// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { cdrPushStatusVariant } from '@/lib/status-variants';

interface CdrEntry {
  id: number;
  partnerId: string;
  ocpiCdrId: string;
  totalEnergy: string;
  totalCost: string;
  currency: string;
  isCredit: boolean;
  pushStatus: string;
  createdAt: string;
  partnerName: string | null;
}

export function RoamingCdrs(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();

  const {
    data: cdrs,
    isLoading,
    page,
    totalPages,
    setPage,
  } = usePaginatedQuery<CdrEntry>('ocpi-cdrs', '/v1/ocpi/cdrs');

  return (
    <div className="space-y-6">
      <h1 className="text-2xl md:text-3xl font-bold">{t('roaming.cdrs.title')}</h1>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('roaming.cdrs.partner')}</TableHead>
            <TableHead>{t('roaming.cdrs.cdrId')}</TableHead>
            <TableHead>{t('roaming.cdrs.energy')}</TableHead>
            <TableHead>{t('roaming.cdrs.cost')}</TableHead>
            <TableHead>{t('roaming.cdrs.type')}</TableHead>
            <TableHead>{t('roaming.cdrs.pushStatus')}</TableHead>
            <TableHead>{t('common.created')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={7} className="text-center">
                {t('common.loading')}
              </TableCell>
            </TableRow>
          ) : cdrs == null || cdrs.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground">
                {t('roaming.cdrs.noCdrs')}
              </TableCell>
            </TableRow>
          ) : (
            cdrs.map((cdr) => (
              <TableRow key={cdr.id}>
                <TableCell className="font-medium">{cdr.partnerName ?? '-'}</TableCell>
                <TableCell className="whitespace-nowrap">{cdr.ocpiCdrId}</TableCell>
                <TableCell>{parseFloat(cdr.totalEnergy).toFixed(2)} kWh</TableCell>
                <TableCell>
                  {parseFloat(cdr.totalCost).toFixed(2)} {cdr.currency}
                </TableCell>
                <TableCell>
                  <Badge variant={cdr.isCredit ? 'destructive' : 'default'}>
                    {cdr.isCredit ? t('roaming.cdrs.credit') : t('roaming.cdrs.charge')}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={cdrPushStatusVariant(cdr.pushStatus)}>{cdr.pushStatus}</Badge>
                </TableCell>
                <TableCell>{formatDateTime(cdr.createdAt, timezone)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />}
    </div>
  );
}
