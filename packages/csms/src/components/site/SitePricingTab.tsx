// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { PricingAssignmentTab } from '@/components/pricing/PricingAssignmentTab';
import { TabsContent } from '@/components/ui/tabs';

export interface SitePricingTabProps {
  siteId: string;
}

export function SitePricingTab({ siteId }: SitePricingTabProps): React.JSX.Element {
  return (
    <TabsContent value="pricing" className="space-y-6">
      <PricingAssignmentTab
        resourceType="site"
        resourceId={siteId}
        assignUrl={`/sites/${siteId}/pricing/add`}
      />
    </TabsContent>
  );
}
