// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router';
import { StationSearchList } from '@/components/StationSearchList';
import { chargerUnitQuery } from '@/lib/station-units';

export function ChargerSearch(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <StationSearchList
      onSelect={(stationId, unitId) => {
        void navigate(`/start/${stationId}${chargerUnitQuery(unitId)}`);
      }}
    />
  );
}
