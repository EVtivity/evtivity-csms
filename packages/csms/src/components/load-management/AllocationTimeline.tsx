// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, ErrorState, LoadingState, TableStateRow } from '@/components/ui/content-state';
import { formatNumber } from '@/lib/formatting';
import { formatDateTime } from '@/lib/timezone';

/** One part of a session: from its start or a tariff switch to the next one. */
export interface TimelinePart {
  sessionId: string;
  stationId: string;
  stationOcppId: string;
  evseNumber: number | null;
  unitName: string | null;
  from: string;
  to: string | null;
  tariffName: string | null;
  maxCurrentA: number | null;
}

interface AllocationTimelineProps {
  parts: readonly TimelinePart[];
  timezone: string;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

const COLUMNS = 5;

export function AllocationTimeline({
  parts,
  timezone,
  isLoading,
  isError,
  onRetry,
}: AllocationTimelineProps): React.JSX.Element {
  const { t } = useTranslation();
  const where = (p: TimelinePart): string =>
    [
      p.stationOcppId,
      p.unitName,
      p.evseNumber != null ? t('loadManagement.chart.evse', { number: p.evseNumber }) : null,
    ]
      .filter((x): x is string => x != null)
      .join(' / ');
  return (
    <div className="space-y-2" data-testid="allocation-timeline">
      <h3 className="text-sm font-semibold">{t('loadManagement.chart.sessionsTitle')}</h3>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('loadManagement.chart.columns.session')}</TableHead>
              <TableHead>{t('loadManagement.chart.columns.from')}</TableHead>
              <TableHead>{t('loadManagement.chart.columns.to')}</TableHead>
              <TableHead>{t('loadManagement.chart.columns.tariff')}</TableHead>
              <TableHead className="text-right">
                {t('loadManagement.chart.columns.currentLimit')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableStateRow colSpan={COLUMNS}>
                <LoadingState />
              </TableStateRow>
            ) : isError ? (
              <TableStateRow colSpan={COLUMNS}>
                <ErrorState onRetry={onRetry} />
              </TableStateRow>
            ) : parts.length === 0 ? (
              <TableStateRow colSpan={COLUMNS}>
                <EmptyState>{t('loadManagement.chart.noSessions')}</EmptyState>
              </TableStateRow>
            ) : (
              parts.map((p) => (
                <TableRow key={`${p.sessionId}-${p.from}`}>
                  <TableCell className="max-w-64 truncate">
                    <Link className="text-link hover:underline" to={`/sessions/${p.sessionId}`}>
                      {where(p)}
                    </Link>
                  </TableCell>
                  <TableCell>{formatDateTime(p.from, timezone)}</TableCell>
                  <TableCell>
                    {p.to != null
                      ? formatDateTime(p.to, timezone)
                      : t('loadManagement.chart.running')}
                  </TableCell>
                  <TableCell>{p.tariffName ?? t('common.na')}</TableCell>
                  <TableCell className="text-right">
                    {p.maxCurrentA != null
                      ? t('loadManagement.chart.amps', { value: formatNumber(p.maxCurrentA, 1) })
                      : t('common.na')}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
