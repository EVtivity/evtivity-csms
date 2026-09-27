// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router';
import { StationSearchList } from '@/components/StationSearchList';

export function ChargerSearch(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <StationSearchList
      onSelect={(stationId) => {
        void navigate(`/start/${stationId}`);
      }}
    />
  );
}
