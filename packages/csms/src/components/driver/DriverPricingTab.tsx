// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { PricingAssignmentTab } from '@/components/pricing/PricingAssignmentTab';
import { TabsContent } from '@/components/ui/tabs';

export interface DriverPricingTabProps {
  driverId: string;
}

export function DriverPricingTab({ driverId }: DriverPricingTabProps): React.JSX.Element {
  return (
    <TabsContent value="pricing" className="space-y-6">
      <PricingAssignmentTab
        resourceType="driver"
        resourceId={driverId}
        assignUrl={`/drivers/${driverId}/pricing/add`}
      />
    </TabsContent>
  );
}
