// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { StationSearchList } from '@/components/StationSearchList';

export function ReservationSearch(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div className="flex flex-1 min-h-0 flex-col gap-3">
      <button
        onClick={() => {
          void navigate('/reservations');
        }}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground self-start"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('common.back')}
      </button>
      <StationSearchList
        title={t('reservations.findStation')}
        searchPlaceholder={t('reservations.searchPlaceholder')}
        hideRoamingTab
        onSelect={(stationId) => {
          void navigate(`/reservations/new/${stationId}`);
        }}
      />
    </div>
  );
}
