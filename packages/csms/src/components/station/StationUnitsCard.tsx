// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TabPanel } from '@/components/ui/tab-panel';
import { EmptyState } from '@/components/ui/content-state';
import { CreateButton } from '@/components/create-button';
import { useHasPermission } from '@/lib/auth';
import type { StationUnit } from '@/lib/station-units';
import { StationUnitNameDialog, type UnitNameDraft } from './station-unit-actions';

/**
 * The units card of a station's Connectors tab: Add Unit (with
 * `stations:write`), and a hint while the station has no units. The units
 * themselves are cards in the Connectors tree, where they are renamed,
 * deleted and given EVSEs.
 */
export function StationUnitsCard({
  stationId,
  units,
}: {
  stationId: string;
  units: StationUnit[] | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  const canWrite = useHasPermission('stations:write');
  const [draft, setDraft] = useState<UnitNameDraft | null>(null);
  const empty = (units ?? []).length === 0;

  return (
    <TabPanel
      title={t('stationUnits.title')}
      description={t('stationUnits.description')}
      body={empty ? 'padded' : 'flush'}
      actions={
        canWrite ? (
          <CreateButton
            label={t('stationUnits.addUnit')}
            onClick={() => {
              setDraft({ id: null, name: '' });
            }}
          />
        ) : undefined
      }
    >
      {empty && <EmptyState>{t('stationUnits.empty')}</EmptyState>}
      {canWrite && (
        <StationUnitNameDialog stationId={stationId} draft={draft} onDraftChange={setDraft} />
      )}
    </TabPanel>
  );
}
