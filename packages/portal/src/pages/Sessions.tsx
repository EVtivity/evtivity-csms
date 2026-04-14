// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { formatCents, formatEnergy, formatDate } from '@/lib/utils';
import { useDriverTimezone } from '@/lib/timezone';

interface Session {
  id: string;
  transactionId: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  energyDeliveredWh: string | null;
  finalCostCents: number | null;
  currency: string | null;
  stationName: string | null;
  siteName: string | null;
}

interface SessionsResponse {
  data: Session[];
  total: number;
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' {
  switch (status) {
    case 'active':
      return 'default';
    case 'completed':
      return 'secondary';
    default:
      return 'destructive';
  }
}

export function Sessions(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const timezone = useDriverTimezone();
  const [page, setPage] = useState(1);
  const limit = 10;

  const { data, isLoading } = useQuery({
    queryKey: ['portal-sessions', page],
    queryFn: () =>
      api.get<SessionsResponse>(`/v1/portal/sessions?page=${String(page)}&limit=${String(limit)}`),
  });

  const totalPages = data != null ? Math.ceil(data.total / limit) : 0;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t('sessions.title')}</h1>

      {isLoading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}

      {data != null && data.data.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('sessions.noSessions')}</p>
      )}

      <div className="space-y-2">
        {data?.data.map((session) => (
          <Card
            key={session.id}
            className="cursor-pointer hover:bg-accent/50 transition-colors"
            onClick={() => {
              void navigate(`/sessions/${session.id}`);
            }}
          >
            <CardContent className="p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">
                    {session.stationName ?? t('sessions.unknownStation')}
                  </p>
                  {session.siteName != null && (
                    <p className="text-xs text-muted-foreground">{session.siteName}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {formatDate(session.startedAt, timezone)}
                  </p>
                </div>
                <div className="text-right space-y-1">
                  <Badge variant={statusVariant(session.status)}>{session.status}</Badge>
                  <p className="text-sm font-medium">{formatEnergy(session.energyDeliveredWh)}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatCents(session.finalCostCents, session.currency ?? 'USD')}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="flex justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => {
              setPage((p) => p - 1);
            }}
          >
            {t('common.previous')}
          </Button>
          <span className="flex items-center text-sm text-muted-foreground">
            {t('sessions.pageOf', { page, total: totalPages })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => {
              setPage((p) => p + 1);
            }}
          >
            {t('common.next')}
          </Button>
        </div>
      )}
    </div>
  );
}
