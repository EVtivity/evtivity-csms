// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/** The element id of the EVSEs Without a Unit card. */
export const STATION_UNASSIGNED_CARD_ID = 'station-unassigned-evses-card';

/**
 * The element id of the unit cards, the target of the notice's action: each
 * unit card has Assign EVSE, which puts an EVSE into that unit.
 */
export const STATION_UNIT_TREE_ID = 'station-unit-tree';

/**
 * A warning on the EVSE & Connectors tab of a station that has units but still has
 * EVSEs without one (setup not finished, or a box added later). Drivers see
 * those EVSEs as one more charger named by the station, so the operator is
 * told and taken to the unit cards, where Assign EVSE puts them in a unit. Renders nothing otherwise.
 */
export function StationUnassignedEvsesNotice({
  unitCount,
  evses,
}: {
  unitCount: number;
  evses: { evseId: number; unitId?: string | null; retiredAt?: string | null }[] | undefined;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  if (unitCount === 0) return null;
  const count = (evses ?? []).filter((e) => e.unitId == null && e.retiredAt == null).length;
  if (count === 0) return null;
  return (
    <Alert variant="warning" className="mb-4" data-testid="station-unassigned-evses">
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>{t('stationUnits.unassignedNotice', { count })}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            document
              .getElementById(STATION_UNIT_TREE_ID)
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
        >
          {t('stationUnits.manageUnits')}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
