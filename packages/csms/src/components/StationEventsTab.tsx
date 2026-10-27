// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { TabPanel } from '@/components/ui/tab-panel';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { JsonDetailBlock, JsonPreviewToggle } from '@/components/ExpandableJson';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/timezone';

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

/**
 * The station Events tab: the variable monitoring events the station reports
 * through NotifyEvent. Security events are on the Security tab's log.
 */
export function StationEventsTab({ stationId, timezone }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const limit = 25;

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['stations', stationId, 'events', page],
    queryFn: () =>
      api.get<{ data: NotifyEvent[]; total: number }>(
        `/v1/stations/${stationId}/events?page=${String(page)}&limit=${String(limit)}`,
      ),
  });

  const totalPages = data != null ? Math.ceil(data.total / limit) : 1;

  return (
    <TabPanel
      title={t('stations.events')}
      description={t('stations.notifyEventsDescription')}
      isLoading={isLoading}
      isError={isError}
      onRetry={() => {
        void refetch();
      }}
      isEmpty={data == null || data.data.length === 0}
      emptyMessage={t('stations.noEvents')}
    >
      <>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('common.timestamp')}</TableHead>
                <TableHead>{t('stations.seqNo')}</TableHead>
                <TableHead>{t('common.data')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.data ?? []).map((event) => {
                const isExpanded = expandedId === event.id;
                const toggle = (): void => {
                  setExpandedId(isExpanded ? null : event.id);
                };
                const detailId = `notify-event-${String(event.id)}-data`;
                return (
                  <Fragment key={event.id}>
                    <TableRow
                      className="cursor-pointer"
                      data-testid={`notify-event-row-${String(event.id)}`}
                      onClick={toggle}
                    >
                      <TableCell className="text-xs whitespace-nowrap">
                        {formatDateTime(event.generatedAt, timezone)}
                      </TableCell>
                      <TableCell className="text-xs">{event.seqNo}</TableCell>
                      <TableCell className="text-xs max-w-md">
                        <JsonPreviewToggle
                          value={event.eventData}
                          expanded={isExpanded}
                          onToggle={toggle}
                          controlsId={detailId}
                        />
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableCell colSpan={3} className="p-3">
                          <JsonDetailBlock id={detailId} value={event.eventData} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      </>
    </TabPanel>
  );
}
