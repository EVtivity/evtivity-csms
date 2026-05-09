// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

interface CampaignSummary {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  stationsTotal: number;
  installedCount: number;
  failedCount: number;
}

const STATUS_VARIANT: Record<
  string,
  'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning'
> = {
  draft: 'outline',
  active: 'warning',
  completed: 'success',
  cancelled: 'secondary',
};

interface Props {
  campaignId: string;
}

export function FirmwareCampaignHistoryTab({ campaignId }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const navigate = useNavigate();

  // Reuse the campaign detail endpoint with a tiny page so we get the
  // aggregate counts but skip pulling the full per-station list (the
  // standalone Progress page renders that detail).
  // No refetchInterval: SSE invalidates ['firmware-campaigns', campaignId, ...]
  // when the projection emits firmwareCampaign.stationUpdated / .completed.
  const { data: campaign } = useQuery({
    queryKey: ['firmware-campaigns', campaignId, 'history'],
    queryFn: () => api.get<CampaignSummary>(`/v1/firmware-campaigns/${campaignId}?page=1&limit=1`),
    enabled: campaignId !== '',
  });

  const hasRun = campaign != null && campaign.status !== 'draft';

  // Derive the displayed status from per-station counts so the row never
  // shows "completed" while any station is still in a non-terminal state.
  // The backend status field is updated by the FirmwareStatusNotification
  // projection and can lag, especially when stations never report back.
  const completedCount = campaign != null ? campaign.installedCount + campaign.failedCount : 0;
  const displayStatus =
    campaign == null
      ? ''
      : campaign.status === 'cancelled' || campaign.status === 'draft'
        ? campaign.status
        : completedCount < campaign.stationsTotal
          ? 'active'
          : 'completed';

  return (
    <Card>
      <CardContent className="pt-6">
        {!hasRun ? (
          <p className="text-center text-sm text-muted-foreground">
            {t('firmwareCampaigns.noCampaignRuns')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('common.timestamp')}</TableHead>
                  <TableHead>{t('common.status')}</TableHead>
                  <TableHead>{t('firmwareCampaigns.totalStations')}</TableHead>
                  <TableHead>{t('firmwareCampaigns.completedStations')}</TableHead>
                  <TableHead>{t('firmwareCampaigns.failedStations')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow
                  className="cursor-pointer"
                  data-testid={`campaign-run-row-${campaign.id}`}
                  onClick={() => {
                    void navigate(`/firmware-campaigns/${campaignId}/progress`);
                  }}
                >
                  <TableCell className="text-xs" data-testid="row-click-target">
                    {formatDateTime(campaign.updatedAt, timezone)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[displayStatus] ?? 'outline'}>
                      {displayStatus}
                    </Badge>
                  </TableCell>
                  <TableCell>{campaign.stationsTotal}</TableCell>
                  <TableCell>{completedCount}</TableCell>
                  <TableCell>
                    {campaign.failedCount > 0 ? (
                      <span className="text-destructive">{campaign.failedCount}</span>
                    ) : (
                      0
                    )}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
