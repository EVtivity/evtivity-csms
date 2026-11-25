// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { TableCell, TableRow } from '@/components/ui/table';
import { evseLimitText, type EvseLimitView } from './evse-limit-text';

/** The limits of a station's charging EVSEs, one sub-row under a station without units. */
export function StationEvseLimitsRow({
  stationId,
  evseLimits,
  colSpan,
}: {
  stationId: string;
  evseLimits: readonly EvseLimitView[];
  colSpan: number;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  if (evseLimits.length === 0) return null;
  return (
    <TableRow data-testid={`evse-limits-row-${stationId}`}>
      <TableCell
        colSpan={colSpan}
        className="px-2 py-1.5 pl-6 text-xs whitespace-nowrap text-muted-foreground"
      >
        {evseLimits.map((l) => evseLimitText(l, t)).join(', ')}
      </TableCell>
    </TableRow>
  );
}
