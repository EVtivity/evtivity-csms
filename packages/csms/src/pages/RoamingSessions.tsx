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
    page,
    totalPages,
    setPage,
  } = usePaginatedQuery<RoamingSession>('ocpi-sessions', '/v1/ocpi/sessions');

  return (
    <div className="space-y-6">
      <h1 className="text-2xl md:text-3xl font-bold">{t('roaming.sessions.title')}</h1>

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
            <TableRow>
              <TableCell colSpan={6} className="text-center">
                {t('common.loading')}
              </TableCell>
            </TableRow>
          ) : sessions == null || sessions.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground">
                {t('roaming.sessions.noSessions')}
              </TableCell>
            </TableRow>
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
                <TableCell>{parseFloat(session.kwh).toFixed(2)} kWh</TableCell>
                <TableCell>
                  {session.totalCost != null
                    ? `${parseFloat(session.totalCost).toFixed(2)} ${session.currency ?? ''}`
                    : '-'}
                </TableCell>
                <TableCell>{formatDateTime(session.createdAt, timezone)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />}
    </div>
  );
}
