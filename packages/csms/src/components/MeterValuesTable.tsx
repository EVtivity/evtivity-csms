// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ResponsiveFilters } from '@/components/responsive-filters';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

export interface MeterValueItem {
  id: number;
  timestamp: string;
  measurand: string | null;
  value: string;
  unit: string | null;
  phase: string | null;
  location: string | null;
  context: string | null;
}

export const COMMON_MEASURANDS = [
  'Energy.Active.Import.Register',
  'Energy.Active.Export.Register',
  'Power.Active.Import',
  'Power.Active.Export',
  'Current.Import',
  'Current.Export',
  'Voltage',
  'SoC',
  'Temperature',
  'Frequency',
  'Power.Offered',
];

interface MeterValuesTableProps {
  queryKey: string;
  url: string;
  description: string;
}

export function MeterValuesTable({
  queryKey,
  url,
  description,
}: MeterValuesTableProps): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();

  const [measurandFilter, setMeasurandFilter] = useState('');
  const extraParams = useMemo(
    () => (measurandFilter !== '' ? { measurand: measurandFilter } : undefined),
    [measurandFilter],
  );
  const {
    data: meterData,
    isLoading,
    page,
    totalPages,
    setPage,
  } = usePaginatedQuery<MeterValueItem>(queryKey, url, extraParams);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="space-y-1.5">
            <CardTitle>{t('sessions.meterValuesTab')}</CardTitle>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
          <ResponsiveFilters activeCount={measurandFilter ? 1 : 0}>
            <Select
              aria-label="Filter by measurand"
              value={measurandFilter}
              onChange={(e) => {
                setMeasurandFilter(e.target.value);
                setPage(1);
              }}
              className="h-9 w-64"
            >
              <option value="">{t('sessions.meterValueFilterMeasurand')}</option>
              {COMMON_MEASURANDS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </ResponsiveFilters>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : meterData == null || meterData.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('sessions.noMeterValues')}</p>
        ) : (
          <div className="space-y-4">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('sessions.meterValueTimestamp')}</TableHead>
                    <TableHead>{t('sessions.meterValueMeasurand')}</TableHead>
                    <TableHead className="text-right">{t('sessions.meterValueValue')}</TableHead>
                    <TableHead>{t('sessions.meterValueUnit')}</TableHead>
                    <TableHead>{t('sessions.meterValuePhase')}</TableHead>
                    <TableHead>{t('sessions.meterValueContext')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {meterData.map((mv) => (
                    <TableRow key={mv.id}>
                      <TableCell>{formatDateTime(mv.timestamp, timezone)}</TableCell>
                      <TableCell>{mv.measurand ?? '--'}</TableCell>
                      <TableCell className="text-right">{mv.value}</TableCell>
                      <TableCell>{mv.unit ?? '--'}</TableCell>
                      <TableCell>{mv.phase ?? '--'}</TableCell>
                      <TableCell>{mv.context ?? '--'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
