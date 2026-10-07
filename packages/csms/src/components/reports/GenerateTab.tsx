// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { GenerateButton } from '@/components/generate-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { reportTypeFormats, useReportTypes } from '@/hooks/use-report-types';
import { ReportTypesLoadError } from '@/components/reports/ReportTypesLoadError';

export function GenerateTab({ onGenerated }: { onGenerated: () => void }): React.JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [reportType, setReportType] = useState('');
  const [format, setFormat] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [siteId, setSiteId] = useState('');
  const [stationId, setStationId] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const { offered, isError: reportTypesError, refetch: refetchReportTypes } = useReportTypes();
  // Until the operator picks one, the first offered type and its first format are selected.
  const selectedType = reportType !== '' ? reportType : (offered[0]?.type ?? '');
  const formats = reportTypeFormats(offered, selectedType);
  const selectedFormat = formats.includes(format) ? format : (formats[0] ?? '');

  const { data: sitesResponse } = useQuery({
    queryKey: ['sites'],
    queryFn: () => api.get<{ data: { id: string; name: string }[] }>('/v1/sites?limit=100'),
  });

  const stationQueryParams = siteId
    ? `/v1/stations?limit=100&siteId=${siteId}`
    : '/v1/stations?limit=100';
  const { data: stationsResponse } = useQuery({
    queryKey: ['stations', siteId],
    queryFn: () => api.get<{ data: { id: string; stationId: string }[] }>(stationQueryParams),
  });

  const generateMutation = useMutation({
    mutationFn: (body: {
      name: string;
      reportType: string;
      format: string;
      filters: Record<string, string>;
    }) => api.post<{ id: string; status: string }>('/v1/reports/generate', body),
    onSuccess: () => {
      setName('');
      setDateFrom('');
      setDateTo('');
      setSiteId('');
      setStationId('');
      setHasSubmitted(false);
      onGenerated();
    },
  });

  function getGenerateValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (name.trim() === '') {
      errors.name = t('validation.required');
    }
    return errors;
  }

  const generateErrors = getGenerateValidationErrors();

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(generateErrors).length > 0 || selectedType === '') return;
    const filters: Record<string, string> = {};
    if (dateFrom) filters['dateFrom'] = dateFrom;
    if (dateTo) filters['dateTo'] = dateTo;
    if (siteId) filters['siteId'] = siteId;
    if (stationId) filters['stationId'] = stationId;
    generateMutation.mutate({
      name,
      reportType: selectedType,
      format: selectedFormat,
      filters,
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('reports.generate')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="space-y-4 max-w-2xl">
          <div className="space-y-2">
            <Label htmlFor="report-name" className="leading-6">
              {t('reports.name')}
            </Label>
            <Input
              id="report-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              className={hasSubmitted && generateErrors.name ? 'border-destructive' : ''}
            />
            {hasSubmitted && generateErrors.name && (
              <p className="text-sm text-destructive">{generateErrors.name}</p>
            )}
          </div>

          {reportTypesError ? (
            <ReportTypesLoadError onRetry={refetchReportTypes} />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="report-type" className="leading-6">
                  {t('reports.reportType')}
                </Label>
                <Select
                  id="report-type"
                  className="h-9"
                  value={selectedType}
                  onChange={(e) => {
                    setReportType(e.target.value);
                  }}
                >
                  {offered.map(({ type }) => (
                    <option key={type} value={type}>
                      {t(`reports.types.${type}`, type)}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="report-format" className="leading-6">
                  {t('reports.format')}
                </Label>
                <Select
                  id="report-format"
                  className="h-9"
                  value={selectedFormat}
                  onChange={(e) => {
                    setFormat(e.target.value);
                  }}
                >
                  {formats.map((f) => (
                    <option key={f} value={f}>
                      {t(`reports.formats.${f}`, f)}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label className="leading-6">{t('reports.dateRange')}</Label>
            <div className="flex items-center gap-2">
              <Input
                type="date"
                aria-label={t('common.startDate')}
                value={dateFrom}
                onChange={(e) => {
                  setDateFrom(e.target.value);
                }}
              />
              <span className="text-sm text-muted-foreground">{t('dashboard.to')}</span>
              <Input
                type="date"
                aria-label={t('common.endDate')}
                value={dateTo}
                onChange={(e) => {
                  setDateTo(e.target.value);
                }}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="report-site" className="leading-6">
                {t('reports.site')}
              </Label>
              <Select
                id="report-site"
                className="h-9"
                value={siteId}
                onChange={(e) => {
                  setSiteId(e.target.value);
                  setStationId('');
                }}
              >
                <option value="">{t('common.all')}</option>
                {sitesResponse?.data.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="report-station" className="leading-6">
                {t('reports.station')}
              </Label>
              <Select
                id="report-station"
                className="h-9"
                value={stationId}
                onChange={(e) => {
                  setStationId(e.target.value);
                }}
              >
                <option value="">{t('common.all')}</option>
                {stationsResponse?.data.map((station) => (
                  <option key={station.id} value={station.id}>
                    {station.stationId}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {generateMutation.isError && (
            <p className="text-sm text-destructive">{getErrorMessage(generateMutation.error, t)}</p>
          )}

          <GenerateButton
            type="submit"
            label={generateMutation.isPending ? t('reports.generating') : t('reports.generate')}
            disabled={generateMutation.isPending || selectedType === ''}
          />
        </form>
      </CardContent>
    </Card>
  );
}
