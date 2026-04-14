// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';

interface MatchingStation {
  id: string;
  stationId: string;
  model: string | null;
  firmwareVersion?: string | null;
  siteName: string | null;
  vendorName: string | null;
}

interface MatchingStationsCardProps {
  endpoint: string;
  queryKey: string[];
  subtitle?: string;
  showFirmwareVersion?: boolean;
}

export function MatchingStationsCard({
  endpoint,
  queryKey,
  subtitle,
  showFirmwareVersion = false,
}: MatchingStationsCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const limit = 10;

  const { data: matchingStations } = useQuery({
    queryKey: [...queryKey, page],
    queryFn: () =>
      api.get<{ data: MatchingStation[]; total: number }>(
        `${endpoint}?page=${String(page)}&limit=${String(limit)}`,
      ),
  });

  const total = matchingStations?.total ?? 0;
  const totalPages = Math.ceil(total / limit);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t('firmwareCampaigns.matchingStations')}{' '}
          <span className="text-muted-foreground font-normal text-sm">({total})</span>
        </CardTitle>
        {subtitle != null && <CardDescription>{subtitle}</CardDescription>}
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('firmwareCampaigns.noMatchingStations')}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('nav.stations')}</TableHead>
                    <TableHead>{t('firmwareCampaigns.site')}</TableHead>
                    <TableHead>{t('firmwareCampaigns.vendor')}</TableHead>
                    <TableHead>{t('firmwareCampaigns.model')}</TableHead>
                    {showFirmwareVersion && (
                      <TableHead>{t('firmwareCampaigns.currentFirmware')}</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {matchingStations?.data.map((station) => (
                    <TableRow key={station.id}>
                      <TableCell className="font-medium">{station.stationId}</TableCell>
                      <TableCell>{station.siteName ?? '--'}</TableCell>
                      <TableCell>{station.vendorName ?? '--'}</TableCell>
                      <TableCell>{station.model ?? '--'}</TableCell>
                      {showFirmwareVersion && (
                        <TableCell className="text-xs">{station.firmwareVersion ?? '--'}</TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
