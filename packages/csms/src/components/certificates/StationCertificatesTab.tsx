// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TabsContent } from '@/components/ui/tabs';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { ResponsiveFilters } from '@/components/responsive-filters';
import { certificateStatusVariant } from '@/lib/status-variants';

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

  const stationCertParams = stationCertStatusFilter
    ? { status: stationCertStatusFilter }
    : undefined;

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
          <div className="flex items-center justify-between">
            <CardTitle>{t('pnc.stationCertificates')}</CardTitle>
            <ResponsiveFilters activeCount={stationCertStatusFilter ? 1 : 0}>
              <Select
                aria-label="Filter by status"
                value={stationCertStatusFilter}
                onChange={(e) => {
                  setStationCertStatusFilter(e.target.value);
                }}
                className="h-9 w-32"
              >
                <option value="">{t('common.all')}</option>
                <option value="active">{t('pnc.active')}</option>
                <option value="expired">{t('pnc.expired')}</option>
                <option value="revoked">{t('pnc.revoked')}</option>
              </Select>
            </ResponsiveFilters>
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
                    <TableHead>{t('pnc.certificateType')}</TableHead>
                    <TableHead>{t('pnc.subject')}</TableHead>
                    <TableHead>{t('pnc.serialNumber')}</TableHead>
                    <TableHead>{t('pnc.validFrom')}</TableHead>
                    <TableHead>{t('pnc.validTo')}</TableHead>
                    <TableHead>{t('common.status')}</TableHead>
                    <TableHead>{t('pnc.source')}</TableHead>
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
