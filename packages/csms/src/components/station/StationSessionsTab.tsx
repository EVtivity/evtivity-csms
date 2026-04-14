// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { SessionsTable, type Session } from '@/components/SessionsTable';
import { ResponsiveFilters } from '@/components/responsive-filters';
import { api } from '@/lib/api';

export interface StationSessionsTabProps {
  stationId: string;
  timezone: string;
}

export function StationSessionsTab({
  stationId,
  timezone,
}: StationSessionsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const [sessionsPage, setSessionsPage] = useState(1);
  const [sessionsStatus, setSessionsStatus] = useState('');

  const sessionsLimit = 10;
  const sessionsQueryParams = new URLSearchParams({
    page: String(sessionsPage),
    limit: String(sessionsLimit),
  });
  if (sessionsStatus !== '') sessionsQueryParams.set('status', sessionsStatus);
  const { data: sessionsResponse } = useQuery({
    queryKey: ['stations', stationId, 'sessions', sessionsPage, sessionsStatus],
    queryFn: () =>
      api.get<{ data: Session[]; total: number }>(
        `/v1/stations/${stationId}/sessions?${sessionsQueryParams.toString()}`,
      ),
  });
  const sessionsData = sessionsResponse?.data;
  const sessionsTotalPages = Math.max(1, Math.ceil((sessionsResponse?.total ?? 0) / sessionsLimit));

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <CardTitle>{t('sessions.title')}</CardTitle>
        <ResponsiveFilters activeCount={sessionsStatus ? 1 : 0}>
          <Select
            aria-label="Filter by status"
            value={sessionsStatus}
            onChange={(e) => {
              setSessionsStatus(e.target.value);
              setSessionsPage(1);
            }}
            className="h-9 sm:w-44"
          >
            <option value="">{t('sessions.allStatuses')}</option>
            <option value="active">{t('status.active')}</option>
            <option value="idling">{t('status.idle')}</option>
            <option value="completed">{t('status.completed')}</option>
            <option value="faulted">{t('status.faulted')}</option>
          </Select>
        </ResponsiveFilters>
      </CardHeader>
      <CardContent>
        <SessionsTable
          sessions={sessionsData}
          page={sessionsPage}
          totalPages={sessionsTotalPages}
          onPageChange={setSessionsPage}
          timezone={timezone}
          hideStationName
        />
      </CardContent>
    </Card>
  );
}
