// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { DataPlan } from '@evtivity/lib/station-data-plan';
import { TabsContent } from '@/components/ui/tabs';
import { SiteDataPlanCard } from '@/components/site/SiteDataPlanCard';

export interface SiteDataPlanTabProps {
  siteId: string;
  dataPlan: DataPlan | null;
}

/** Site detail > Data Plan: the plan of the site's stations without their own plan or a SIM. */
export function SiteDataPlanTab({ siteId, dataPlan }: SiteDataPlanTabProps): React.JSX.Element {
  return (
    <TabsContent value="data-plan">
      <SiteDataPlanCard siteId={siteId} dataPlan={dataPlan} />
    </TabsContent>
  );
}
