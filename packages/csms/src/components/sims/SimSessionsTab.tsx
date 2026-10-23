// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { SimTimelineCard } from '@/components/sim/SimTimelineCard';
import type { SimRefreshController } from '@/components/sim/use-sim-refresh';
import type { SimDetailData } from './sim-detail';

/**
 * The stored sessions and alerts of the SIM, with the coverage strip, from
 * `GET /v1/sims/:id/timeline` (the shared timeline card of the station tab).
 */
export function SimSessionsTab({
  sim,
  controller,
  timezone,
}: {
  sim: SimDetailData;
  controller: SimRefreshController;
  timezone: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <SimTimelineCard
      controller={controller}
      timezone={timezone}
      lastFetchedAt={sim.lastFetchedAt}
      reportingDelayHours={sim.reportingDelayHours}
      disabledReason={sim.status === 'inactive' ? t('sims.detail.inactiveReason') : null}
    />
  );
}
