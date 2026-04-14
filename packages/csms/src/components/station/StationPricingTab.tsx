// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { PricingAssignmentTab } from '@/components/pricing/PricingAssignmentTab';

export interface StationPricingTabProps {
  stationId: string;
}

export function StationPricingTab({ stationId }: StationPricingTabProps): React.JSX.Element {
  return (
    <PricingAssignmentTab
      resourceType="station"
      resourceId={stationId}
      assignUrl={`/stations/${stationId}/pricing/add`}
    />
  );
}
