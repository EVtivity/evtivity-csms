// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SessionsTable } from '@/components/SessionsTable';
import { api } from '@/lib/api';
import { useUserTimezone } from '@/lib/timezone';

interface SessionRow {
  id: string;
  stationId: string;
  stationName: string | null;
  siteName: string | null;
  driverId: string | null;
  driverName: string | null;
  transactionId: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  idleStartedAt: string | null;
  energyDeliveredWh: number | null;
  currentCostCents: number | null;
  finalCostCents: number | null;
  currency: string | null;
  freeVend: boolean | null;
  co2AvoidedKg: number | null;
}

interface FleetSessionsTabProps {
  fleetId: string;
}

export function FleetSessionsTab({ fleetId }: FleetSessionsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const [page, setPage] = useState(1);
  const limit = 10;

  const { data: response } = useQuery({
    queryKey: ['fleets', fleetId, 'sessions', page],
    queryFn: () =>
      api.get<{ data: SessionRow[]; total: number }>(
        `/v1/fleets/${fleetId}/sessions?page=${String(page)}&limit=${String(limit)}`,
      ),
  });

  const totalPages = Math.max(1, Math.ceil((response?.total ?? 0) / limit));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('sessions.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <SessionsTable
          sessions={response?.data}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          timezone={timezone}
        />
      </CardContent>
    </Card>
  );
}
