// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useListSort } from '@/hooks/use-list-sort';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TabsContent } from '@/components/ui/tabs';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { FilterPopover } from '@/components/FilterBar';
import { certificateStatusVariant } from '@/lib/status-variants';

/** The sort keys of `GET /v1/pnc/station-certificates` (the API list sort definition in `lib/sorts/`). */
const STATION_CERTIFICATE_SORT_KEYS = [
  'certificateType',
  'subject',
  'serialNumber',
  'validFrom',
  'validTo',
  'status',
  'source',
] as const;

interface StationCertificate {
  id: number;
  stationId: string;
  certificateType: string;
  serialNumber: string | null;
  issuer: string | null;
  subject: string | null;
  validFrom: string | null;
  validTo: string | null;
  status: string;
  source: string | null;
  createdAt: string;
}

function isExpiringSoon(validTo: string | null): boolean {
  if (validTo == null) return false;
  const diff = new Date(validTo).getTime() - Date.now();
  return diff > 0 && diff < 30 * 24 * 60 * 60 * 1000;
}

export function StationCertificatesTab(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();

  const [stationCertStatusFilter, setStationCertStatusFilter] = useState('');

  const stationCertSort = useListSort(STATION_CERTIFICATE_SORT_KEYS);
  const stationCertParams = {
    ...(stationCertStatusFilter ? { status: stationCertStatusFilter } : {}),
    ...stationCertSort.params,
  };

  const {
    data: stationCerts,
    page: stationCertPage,
    totalPages: stationCertTotalPages,
    setPage: setStationCertPage,
  } = usePaginatedQuery<StationCertificate>(
    'pnc-station-certificates',
    '/v1/pnc/station-certificates',
    stationCertParams,
  );

  return (
    <TabsContent value="station">
      <Card>
        <CardHeader>
          <div className="flex flex-row items-center justify-between gap-2">
            <CardTitle>{t('pnc.stationCertificates')}</CardTitle>
            <Select
              aria-label={t('common.filterByStatus')}
              value={stationCertStatusFilter}
              onChange={(e) => {
                setStationCertStatusFilter(e.target.value);
              }}
              className="hidden w-32 md:block"
            >
              <option value="">{t('common.all')}</option>
              <option value="active">{t('pnc.active')}</option>
              <option value="expired">{t('pnc.expired')}</option>
              <option value="revoked">{t('pnc.revoked')}</option>
            </Select>
            <FilterPopover className="md:hidden" activeCount={stationCertStatusFilter ? 1 : 0}>
              <Select
                aria-label={t('common.filterByStatus')}
                value={stationCertStatusFilter}
                onChange={(e) => {
                  setStationCertStatusFilter(e.target.value);
                }}
                className="w-32"
              >
                <option value="">{t('common.all')}</option>
                <option value="active">{t('pnc.active')}</option>
                <option value="expired">{t('pnc.expired')}</option>
                <option value="revoked">{t('pnc.revoked')}</option>
              </Select>
            </FilterPopover>
          </div>
        </CardHeader>
        <CardContent>
          {stationCerts == null || stationCerts.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t('pnc.noStationCertificates')}
            </p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTableHead sortKey="certificateType" sort={stationCertSort}>
                      {t('pnc.certificateType')}
                    </SortableTableHead>
                    <SortableTableHead sortKey="subject" sort={stationCertSort}>
                      {t('pnc.subject')}
                    </SortableTableHead>
                    <SortableTableHead sortKey="serialNumber" sort={stationCertSort}>
                      {t('pnc.serialNumber')}
                    </SortableTableHead>
                    <SortableTableHead sortKey="validFrom" sort={stationCertSort}>
                      {t('pnc.validFrom')}
                    </SortableTableHead>
                    <SortableTableHead sortKey="validTo" sort={stationCertSort}>
                      {t('pnc.validTo')}
                    </SortableTableHead>
                    <SortableTableHead sortKey="status" sort={stationCertSort}>
                      {t('common.status')}
                    </SortableTableHead>
                    <SortableTableHead sortKey="source" sort={stationCertSort}>
                      {t('pnc.source')}
                    </SortableTableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stationCerts.map((cert) => (
                    <TableRow key={cert.id}>
                      <TableCell>{cert.certificateType}</TableCell>
                      <TableCell className="max-w-48 truncate">{cert.subject}</TableCell>
                      <TableCell>{cert.serialNumber ?? '-'}</TableCell>
                      <TableCell>
                        {cert.validFrom != null ? formatDateTime(cert.validFrom, timezone) : '-'}
                      </TableCell>
                      <TableCell>
                        {cert.validTo != null ? formatDateTime(cert.validTo, timezone) : '-'}
                        {isExpiringSoon(cert.validTo) && (
                          <Badge variant="secondary" className="ml-1">
                            {t('pnc.expiring')}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {
                          <Badge variant={certificateStatusVariant(cert.status)}>
                            {cert.status}
                          </Badge>
                        }
                      </TableCell>
                      <TableCell>{cert.source ?? '-'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                page={stationCertPage}
                totalPages={stationCertTotalPages}
                onPageChange={setStationCertPage}
              />
            </>
          )}
        </CardContent>
      </Card>
    </TabsContent>
  );
}
