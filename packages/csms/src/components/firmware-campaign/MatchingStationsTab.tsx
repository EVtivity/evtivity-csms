// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { MatchingStationsCard } from '@/components/MatchingStationsCard';

interface Props {
  campaignId: string;
}

export function FirmwareCampaignMatchingStationsTab({ campaignId }: Props): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <MatchingStationsCard
      title={t('firmwareCampaigns.matchingStations')}
      endpoint={`/v1/firmware-campaigns/${campaignId}/matching-stations`}
      queryKey={['firmware-campaigns', campaignId, 'matching-stations']}
      showFirmwareVersion
    />
  );
}
