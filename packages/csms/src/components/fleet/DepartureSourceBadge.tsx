// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { departureSourceLabel, type Departure } from './departure-types';

/**
 * Where a departure came from: Manual, Schedule, Import, Vehicle or Bus Depot
 * System (with the system's name when the reader may see it).
 */
export function DepartureSourceBadge({
  departure,
}: {
  departure: Pick<Departure, 'source' | 'depotSystemName'>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const depot = departure.source === 'depot_system';
  return (
    <Badge
      variant={depot ? 'info' : 'outline'}
      className="max-w-full whitespace-normal normal-case"
      data-testid={depot ? 'depot-system-badge' : 'departure-source-badge'}
    >
      {departureSourceLabel(t, departure)}
    </Badge>
  );
}
