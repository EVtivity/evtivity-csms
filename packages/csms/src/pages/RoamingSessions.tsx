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
import { roamingSessionStatusVariant } from '@/lib/status-variants';
import { TabPanel } from '@/components/ui/tab-panel';
import { EmptyState, ErrorState, LoadingState, TableStateRow } from '@/components/ui/content-state';
import { formatMajorAmount, formatNumber } from '@/lib/formatting';

interface RoamingSession {
  id: number;
  partnerId: string;
  ocpiSessionId: string;
  tokenUid: string;
  status: string;
  kwh: string;
  totalCost: string | null;
  currency: string | null;
  createdAt: string;
  updatedAt: string;
  partnerName: string | null;
}

export function RoamingSessions(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();

  const {
    data: sessions,
    isLoading,
    isError,
    refetch,
    page,
    totalPages,
    setPage,
  } = usePaginatedQuery<RoamingSession>('ocpi-sessions', '/v1/ocpi/sessions');

  return (
    <div className="space-y-6">
      <TabPanel title={t('nav.roamingSessions')} body="flush">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('roaming.sessions.partner')}</TableHead>
                <TableHead>{t('roaming.sessions.tokenUid')}</TableHead>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead>{t('roaming.sessions.energy')}</TableHead>
                <TableHead>{t('roaming.sessions.cost')}</TableHead>
                <TableHead>{t('common.created')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableStateRow colSpan={6}>
                  <LoadingState />
                </TableStateRow>
              ) : isError ? (
                <TableStateRow colSpan={6}>
                  <ErrorState onRetry={refetch} />
                </TableStateRow>
              ) : sessions == null || sessions.length === 0 ? (
                <TableStateRow colSpan={6}>
                  <EmptyState>{t('roaming.sessions.noSessions')}</EmptyState>
                </TableStateRow>
              ) : (
                sessions.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell className="font-medium">{session.partnerName ?? '-'}</TableCell>
                    <TableCell className="whitespace-nowrap">{session.tokenUid}</TableCell>
                    <TableCell>
                      <Badge variant={roamingSessionStatusVariant(session.status)}>
                        {session.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatNumber(parseFloat(session.kwh), 2)} kWh</TableCell>
                    <TableCell>{formatMajorAmount(session.totalCost, session.currency)}</TableCell>
                    <TableCell>{formatDateTime(session.createdAt, timezone)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </TabPanel>

      {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />}
    </div>
  );
}
