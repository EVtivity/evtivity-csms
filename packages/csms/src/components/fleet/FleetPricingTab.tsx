// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { PricingAssignmentTab } from '@/components/pricing/PricingAssignmentTab';

interface FleetPricingTabProps {
  fleetId: string;
}

export function FleetPricingTab({ fleetId }: FleetPricingTabProps): React.JSX.Element {
  return (
    <PricingAssignmentTab
      resourceType="fleet"
      resourceId={fleetId}
      assignUrl={`/fleets/${fleetId}/pricing/add`}
    />
  );
}
