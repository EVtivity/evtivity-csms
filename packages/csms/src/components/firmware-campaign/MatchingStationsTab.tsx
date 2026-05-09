// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { MatchingStationsCard } from '@/components/MatchingStationsCard';

interface Props {
  campaignId: string;
}

export function FirmwareCampaignMatchingStationsTab({ campaignId }: Props): React.JSX.Element {
  return (
    <MatchingStationsCard
      endpoint={`/v1/firmware-campaigns/${campaignId}/matching-stations`}
      queryKey={['firmware-campaigns', campaignId, 'matching-stations']}
      showFirmwareVersion
    />
  );
}
