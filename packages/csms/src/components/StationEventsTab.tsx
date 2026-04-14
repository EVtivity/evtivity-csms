// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import { ResponsiveFilters } from '@/components/responsive-filters';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/timezone';

interface SecurityEvent {
  id: number;
  type: string;
  severity: string;
  timestamp: string;
  techInfo: string | null;
}

interface NotifyEvent {
  id: number;
  generatedAt: string;
  seqNo: number;
  tbc: boolean;
  eventData: Record<string, unknown>;
}

interface Props {
  stationId: string;
  timezone: string;
}

const SEVERITY_VARIANT: Record<
  string,
  'destructive' | 'warning' | 'secondary' | 'outline' | 'info'
> = {
  critical: 'destructive',
  high: 'destructive',
  medium: 'warning',
  low: 'secondary',
  info: 'outline',
};

function SecurityEventsPanel({ stationId, timezone }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [severity, setSeverity] = useState('');
  const limit = 25;

  const { data, isLoading } = useQuery({
    queryKey: ['stations', stationId, 'security-events', page, severity],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (severity !== '') params.set('severity', severity);
      return api.get<{ data: SecurityEvent[]; total: number }>(
        `/v1/stations/${stationId}/security-events?${params.toString()}`,
      );
    },
  });

  const totalPages = data != null ? Math.ceil(data.total / limit) : 1;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{t('stations.securityEvents')}</CardTitle>
          <ResponsiveFilters activeCount={severity ? 1 : 0}>
            <Select
              aria-label="Filter by severity"
              value={severity}
              onChange={(e) => {
                setSeverity(e.target.value);
                setPage(1);
              }}
              className="h-9 w-auto"
            >
              <option value="">{t('common.all')}</option>
              <option value="critical">{t('severity.critical')}</option>
              <option value="high">{t('severity.high')}</option>
              <option value="medium">{t('severity.medium')}</option>
              <option value="low">{t('severity.low')}</option>
              <option value="info">{t('severity.info')}</option>
            </Select>
          </ResponsiveFilters>
        </div>
        <CardDescription>{t('stations.securityEventsDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : data == null || data.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('stations.noSecurityEvents')}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('common.type')}</TableHead>
                    <TableHead>{t('common.severity')}</TableHead>
                    <TableHead>{t('common.timestamp')}</TableHead>
                    <TableHead>{t('stations.techInfo')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.data.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="text-xs">{event.type}</TableCell>
                      <TableCell>
                        <Badge variant={SEVERITY_VARIANT[event.severity] ?? 'outline'}>
                          {event.severity}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {formatDateTime(event.timestamp, timezone)}
                      </TableCell>
                      <TableCell className="text-xs max-w-xs truncate">
                        {event.techInfo ?? '--'}
                      </TableCell>
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

function NotifyEventsPanel({ stationId, timezone }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const limit = 25;

  const { data, isLoading } = useQuery({
    queryKey: ['stations', stationId, 'events', page],
    queryFn: () =>
      api.get<{ data: NotifyEvent[]; total: number }>(
        `/v1/stations/${stationId}/events?page=${String(page)}&limit=${String(limit)}`,
      ),
  });

  const totalPages = data != null ? Math.ceil(data.total / limit) : 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('stations.notifyEvents')}</CardTitle>
        <CardDescription>{t('stations.notifyEventsDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : data == null || data.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('stations.noEvents')}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('common.timestamp')}</TableHead>
                    <TableHead>Seq</TableHead>
                    <TableHead>{t('common.data')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.data.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="text-xs">
                        {formatDateTime(event.generatedAt, timezone)}
                      </TableCell>
                      <TableCell className="text-xs">{event.seqNo}</TableCell>
                      <TableCell className="text-xs max-w-md truncate">
                        {JSON.stringify(event.eventData)}
                      </TableCell>
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

export function StationEventsTab({ stationId, timezone }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const [subTab, setSubTab] = useState('security');

  return (
    <div className="space-y-4">
      <Tabs value={subTab} onValueChange={setSubTab}>
        <TabsList>
          <TabsTrigger value="security">{t('stations.securityEvents')}</TabsTrigger>
          <TabsTrigger value="notify">{t('stations.notifyEvents')}</TabsTrigger>
        </TabsList>
        <TabsContent value="security" className="space-y-6">
          <SecurityEventsPanel stationId={stationId} timezone={timezone} />
        </TabsContent>
        <TabsContent value="notify" className="space-y-6">
          <NotifyEventsPanel stationId={stationId} timezone={timezone} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
