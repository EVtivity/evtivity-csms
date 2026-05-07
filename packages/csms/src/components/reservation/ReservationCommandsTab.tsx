// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { OcppLogTable } from '@/components/OcppLogTable';
import type { OcppLogEntry } from '@/components/OcppLogTable';

interface OcppCommandsResponse {
  data: OcppLogEntry[];
  total: number;
}

export interface ReservationCommandsTabProps {
  reservationId: string;
  timezone: string;
}

export function ReservationCommandsTab({
  reservationId,
  timezone,
}: ReservationCommandsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const limit = 20;

  const { data } = useQuery({
    queryKey: ['reservations', reservationId, 'commands', page],
    queryFn: () =>
      api.get<OcppCommandsResponse>(
        `/v1/reservations/${reservationId}/commands?page=${String(page)}&limit=${String(limit)}`,
      ),
    enabled: reservationId !== '',
  });

  const entries = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <OcppLogTable
      title={t('reservations.commandLog')}
      entries={entries}
      page={page}
      totalPages={totalPages}
      onPageChange={setPage}
      timezone={timezone}
      emptyMessage={t('reservations.noCommands')}
      rowTestIdPrefix="reservation-command-row"
      showStationColumn
      showResponseTimeColumn
    />
  );
}
