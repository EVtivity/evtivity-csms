// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { OcppLogTable } from '@/components/OcppLogTable';
import type { OcppLogEntry } from '@/components/OcppLogTable';

interface OcppLogsResponse {
  data: OcppLogEntry[];
  total: number;
  actions: string[];
}

interface OcppMessageLogProps {
  stationDbId: string;
  timezone: string;
}

export function OcppMessageLog({ stationDbId, timezone }: OcppMessageLogProps): React.JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState('');
  const limit = 10;

  const { data } = useQuery({
    queryKey: ['stations', stationDbId, 'ocpp-logs', page, actionFilter],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (actionFilter !== '') params.set('action', actionFilter);
      return api.get<OcppLogsResponse>(
        `/v1/stations/${stationDbId}/ocpp-logs?${params.toString()}`,
      );
    },
    refetchInterval: false,
  });

  const entries = data?.data ?? [];
  const total = data?.total ?? 0;
  const actions = data?.actions ?? [];
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <OcppLogTable
      title={t('ocppLogs.title')}
      entries={entries}
      page={page}
      totalPages={totalPages}
      onPageChange={setPage}
      timezone={timezone}
      emptyMessage={t('ocppLogs.noMessages')}
      rowTestIdPrefix="ocpp-message-row"
      actions={actions}
      actionFilter={actionFilter}
      onActionFilterChange={(a) => {
        setActionFilter(a);
        setPage(1);
      }}
    />
  );
}
