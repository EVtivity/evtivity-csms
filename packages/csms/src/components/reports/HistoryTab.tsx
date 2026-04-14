// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useMemo } from 'react';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL } from '@/lib/config';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { api } from '@/lib/api';
import { formatFileSize } from '@/lib/formatting';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ResponsiveFilters } from '@/components/responsive-filters';
import { reportStatusVariant } from '@/lib/status-variants';

interface Report {
  id: string;
  name: string;
  reportType: string;
  format: string;
  status: string;
  fileSize: number | null;
  createdAt: string;
  completedAt: string | null;
}

const REPORT_TYPES = [
  'revenue',
  'utilization',
  'energy',
  'stationHealth',
  'sessions',
  'sustainability',
  'driverActivity',
  'nevi',
] as const;

async function downloadReport(id: string, fileName: string): Promise<void> {
  const baseUrl = API_BASE_URL;
  const res = await fetch(`${baseUrl}/v1/reports/${id}/download`, {
    credentials: 'include',
  });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function HistoryTab(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const timezone = useUserTimezone();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState('');

  const extraParams = useMemo(
    () => (typeFilter ? { reportType: typeFilter } : undefined),
    [typeFilter],
  );

  const {
    data: reports,
    isLoading,
    page,
    totalPages,
    setPage,
  } = usePaginatedQuery<Report>('reports', '/v1/reports', extraParams);

  const hasGenerating = reports?.some((r) => r.status === 'pending' || r.status === 'generating');

  useQuery({
    queryKey: ['reports-poll', page, typeFilter],
    queryFn: () => {
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
      return null;
    },
    refetchInterval: hasGenerating ? 5000 : false,
    enabled: hasGenerating === true,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/v1/reports/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
    },
  });

  return (
    <Card>
      <CardContent className="pt-6 space-y-4">
        <div className="flex">
          <ResponsiveFilters activeCount={typeFilter ? 1 : 0}>
            <Select
              aria-label="Filter by report type"
              className="h-9"
              value={typeFilter}
              onChange={(e) => {
                setTypeFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">{t('common.all')}</option>
              {REPORT_TYPES.map((rt) => (
                <option key={rt} value={rt}>
                  {t(`reports.types.${rt}`, rt)}
                </option>
              ))}
            </Select>
          </ResponsiveFilters>
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('reports.name')}</TableHead>
                <TableHead>{t('reports.reportType')}</TableHead>
                <TableHead>{t('reports.format')}</TableHead>
                <TableHead>{t('reports.status')}</TableHead>
                <TableHead>{t('reports.size')}</TableHead>
                <TableHead>{t('reports.created')}</TableHead>
                <TableHead>{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    {t('common.loading')}
                  </TableCell>
                </TableRow>
              )}
              {reports?.map((report) => (
                <TableRow key={report.id}>
                  <TableCell className="font-medium">{report.name}</TableCell>
                  <TableCell>
                    {t(`reports.types.${report.reportType}`, report.reportType)}
                  </TableCell>
                  <TableCell className="uppercase">{report.format}</TableCell>
                  <TableCell>
                    <Badge variant={reportStatusVariant(report.status)}>
                      {t(`reports.statuses.${report.status}`, report.status)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {report.fileSize != null ? formatFileSize(report.fileSize) : '-'}
                  </TableCell>
                  <TableCell>{formatDateTime(report.createdAt, timezone)}</TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      {report.status === 'completed' && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            void downloadReport(report.id, report.name);
                          }}
                        >
                          {t('reports.download')}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setDeleteId(report.id);
                        }}
                      >
                        {t('reports.deleteReport')}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {reports?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    {t('reports.noReports')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

        <ConfirmDialog
          open={deleteId != null}
          onOpenChange={(open) => {
            if (!open) setDeleteId(null);
          }}
          title={t('reports.deleteReport')}
          description={t('reports.reportDeleted')}
          confirmLabel={t('common.delete')}
          confirmIcon={<Trash2 className="h-4 w-4" />}
          onConfirm={() => {
            if (deleteId != null) {
              deleteMutation.mutate(deleteId);
              setDeleteId(null);
            }
          }}
        />
      </CardContent>
    </Card>
  );
}
