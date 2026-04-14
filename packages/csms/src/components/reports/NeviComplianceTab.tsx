// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useMemo } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL } from '@/lib/config';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { Button } from '@/components/ui/button';
import { CreateButton } from '@/components/create-button';
import { EditButton } from '@/components/edit-button';
import { RemoveButton } from '@/components/remove-button';
import { GenerateButton } from '@/components/generate-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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

// -- Types --

const DOWNTIME_REASONS = [
  'utility_outage',
  'vandalism',
  'natural_disaster',
  'scheduled_maintenance',
  'vehicle_caused',
] as const;

type DowntimeReason = (typeof DOWNTIME_REASONS)[number];

interface NeviReport {
  id: string;
  name: string;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  error?: string;
  format: string;
}

interface NeviStation {
  id: string;
  stationId: string;
}

interface StationData {
  stationId: string;
  stationName: string;
  operatorName: string | null;
  operatorAddress: string | null;
  operatorPhone: string | null;
  operatorEmail: string | null;
  installationCost: number | null;
  gridConnectionCost: number | null;
  maintenanceCostAnnual: number | null;
  maintenanceCostYear: number | null;
  derType: string | null;
  derCapacityKw: number | null;
  derCapacityKwh: number | null;
  programParticipation: string[] | null;
}

interface Downtime {
  id: number;
  stationId: string;
  stationName: string;
  evseId: number;
  reason: DowntimeReason;
  startedAt: string;
  endedAt: string | null;
  notes: string | null;
}

interface DowntimeForm {
  stationId: string;
  evseId: string;
  reason: DowntimeReason;
  startedAt: string;
  endedAt: string;
  notes: string;
}

const EMPTY_DOWNTIME_FORM: DowntimeForm = {
  stationId: '',
  evseId: '',
  reason: 'utility_outage',
  startedAt: '',
  endedAt: '',
  notes: '',
};

// -- Helpers --

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

// -- Sub-components --

function EvChartExportSection(): React.JSX.Element {
  const { t } = useTranslation();
  const [quarter, setQuarter] = useState('1');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [neviReportId, setNeviReportId] = useState<string | null>(null);

  const generateMutation = useMutation({
    mutationFn: () =>
      api.post<NeviReport>('/v1/reports/generate', {
        name: `NEVI EV-ChART Q${quarter} ${year}`,
        reportType: 'nevi',
        format: 'xlsx',
        filters: { quarter: Number(quarter), year: Number(year) },
      }),
    onSuccess: (report) => {
      setNeviReportId(report.id);
    },
  });

  const { data: neviReport } = useQuery({
    queryKey: ['report', neviReportId],
    queryFn: () => api.get<NeviReport>(`/v1/reports/${neviReportId ?? ''}`),
    enabled: neviReportId != null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === 'pending' || status === 'generating') return 3000;
      return false;
    },
  });

  function handleGenerate(): void {
    setNeviReportId(null);
    generateMutation.mutate();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('nevi.generateChart')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-end gap-4">
          <div className="space-y-2">
            <Label htmlFor="nevi-quarter-select">{t('nevi.quarter')}</Label>
            <Select
              id="nevi-quarter-select"
              value={quarter}
              onChange={(e) => {
                setQuarter(e.target.value);
              }}
              className="h-9"
            >
              <option value="1">Q1</option>
              <option value="2">Q2</option>
              <option value="3">Q3</option>
              <option value="4">Q4</option>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="nevi-year">{t('nevi.year')}</Label>
            <Input
              id="nevi-year"
              type="number"
              value={year}
              onChange={(e) => {
                setYear(e.target.value);
              }}
              className="w-28"
            />
          </div>
          <GenerateButton
            label={generateMutation.isPending ? t('nevi.generating') : t('nevi.generateChart')}
            onClick={handleGenerate}
            disabled={generateMutation.isPending}
          />
        </div>

        {generateMutation.isError && (
          <p className="text-sm text-destructive">{getErrorMessage(generateMutation.error, t)}</p>
        )}

        {neviReport != null && (
          <div className="pt-2">
            {(neviReport.status === 'pending' || neviReport.status === 'generating') && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                <span>{t('nevi.generating')}</span>
              </div>
            )}
            {neviReport.status === 'completed' && (
              <Button
                variant="outline"
                onClick={() => {
                  void downloadReport(neviReport.id, neviReport.name + '.xlsx');
                }}
              >
                {t('common.download')}
              </Button>
            )}
            {neviReport.status === 'failed' && (
              <p className="text-sm text-destructive">{neviReport.error ?? t('errors.unknown')}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const STATION_PAGE_SIZE = 10;

function StationDataSection(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editStation, setEditStation] = useState<NeviStation | null>(null);
  const [stationPage, setStationPage] = useState(1);

  const [operatorName, setOperatorName] = useState('');
  const [operatorAddress, setOperatorAddress] = useState('');
  const [operatorPhone, setOperatorPhone] = useState('');
  const [operatorEmail, setOperatorEmail] = useState('');
  const [installationCost, setInstallationCost] = useState('');
  const [gridConnectionCost, setGridConnectionCost] = useState('');
  const [maintenanceCostAnnual, setMaintenanceCostAnnual] = useState('');
  const [maintenanceCostYear, setMaintenanceCostYear] = useState('');
  const [derType, setDerType] = useState('');
  const [derCapacityKw, setDerCapacityKw] = useState('');
  const [derCapacityKwh, setDerCapacityKwh] = useState('');
  const [programParticipation, setProgramParticipation] = useState('');

  const { data: stationsResp } = useQuery({
    queryKey: ['nevi-stations-list'],
    queryFn: () => api.get<{ data: NeviStation[] }>('/v1/stations?limit=100'),
  });

  const { data: stationDataResp } = useQuery({
    queryKey: ['nevi-station-data'],
    queryFn: () => api.get<{ data: StationData[] }>('/v1/nevi/station-data'),
  });

  const stations = stationsResp?.data ?? [];
  const stationDataList = stationDataResp?.data ?? [];
  const stationDataMap = useMemo(() => {
    const map = new Map<string, StationData>();
    for (const sd of stationDataList) {
      map.set(sd.stationId, sd);
    }
    return map;
  }, [stationDataList]);

  const saveMutation = useMutation({
    mutationFn: (data: { stationId: string; body: Record<string, unknown> }) =>
      api.put(`/v1/nevi/station-data/${data.stationId}`, data.body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['nevi-station-data'] });
      setEditStation(null);
    },
  });

  function openEdit(station: NeviStation): void {
    const existing = stationDataMap.get(station.id);
    setOperatorName(existing?.operatorName ?? '');
    setOperatorAddress(existing?.operatorAddress ?? '');
    setOperatorPhone(existing?.operatorPhone ?? '');
    setOperatorEmail(existing?.operatorEmail ?? '');
    setInstallationCost(
      existing?.installationCost != null ? String(existing.installationCost) : '',
    );
    setGridConnectionCost(
      existing?.gridConnectionCost != null ? String(existing.gridConnectionCost) : '',
    );
    setMaintenanceCostAnnual(
      existing?.maintenanceCostAnnual != null ? String(existing.maintenanceCostAnnual) : '',
    );
    setMaintenanceCostYear(
      existing?.maintenanceCostYear != null ? String(existing.maintenanceCostYear) : '',
    );
    setDerType(existing?.derType ?? '');
    setDerCapacityKw(existing?.derCapacityKw != null ? String(existing.derCapacityKw) : '');
    setDerCapacityKwh(existing?.derCapacityKwh != null ? String(existing.derCapacityKwh) : '');
    setProgramParticipation(existing?.programParticipation?.join(', ') ?? '');
    saveMutation.reset();
    setEditStation(station);
  }

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    if (editStation == null) return;
    saveMutation.mutate({
      stationId: editStation.id,
      body: {
        operatorName: operatorName || null,
        operatorAddress: operatorAddress || null,
        operatorPhone: operatorPhone || null,
        operatorEmail: operatorEmail || null,
        installationCost: installationCost !== '' ? Number(installationCost) : null,
        gridConnectionCost: gridConnectionCost !== '' ? Number(gridConnectionCost) : null,
        maintenanceCostAnnual: maintenanceCostAnnual !== '' ? Number(maintenanceCostAnnual) : null,
        maintenanceCostYear: maintenanceCostYear !== '' ? Number(maintenanceCostYear) : null,
        derType: derType || null,
        derCapacityKw: derCapacityKw !== '' ? Number(derCapacityKw) : null,
        derCapacityKwh: derCapacityKwh !== '' ? Number(derCapacityKwh) : null,
        programParticipation:
          programParticipation.trim() !== ''
            ? programParticipation
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : null,
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('nevi.stationDataTab')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('nevi.station')}</TableHead>
                <TableHead>{t('nevi.operatorName')}</TableHead>
                <TableHead>{t('nevi.installationCost')}</TableHead>
                <TableHead>{t('nevi.maintenanceCostAnnual')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {stations.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    {t('nevi.noStationData')}
                  </TableCell>
                </TableRow>
              )}
              {stations
                .slice((stationPage - 1) * STATION_PAGE_SIZE, stationPage * STATION_PAGE_SIZE)
                .map((station) => {
                  const sd = stationDataMap.get(station.id);
                  return (
                    <TableRow key={station.id}>
                      <TableCell>{station.stationId}</TableCell>
                      <TableCell>{sd?.operatorName ?? '-'}</TableCell>
                      <TableCell>
                        {sd?.installationCost != null ? String(sd.installationCost) : '-'}
                      </TableCell>
                      <TableCell>
                        {sd?.maintenanceCostAnnual != null ? String(sd.maintenanceCostAnnual) : '-'}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            openEdit(station);
                          }}
                        >
                          {t('nevi.editStationData')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </div>

        {stations.length > STATION_PAGE_SIZE && (
          <Pagination
            page={stationPage}
            totalPages={Math.ceil(stations.length / STATION_PAGE_SIZE)}
            onPageChange={setStationPage}
          />
        )}

        <Dialog
          open={editStation != null}
          onOpenChange={(open) => {
            if (!open) setEditStation(null);
          }}
        >
          <DialogContent className="max-w-sm md:max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {t('nevi.editStationData')} - {editStation?.stationId}
              </DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSave} className="space-y-6">
              <div className="space-y-3">
                <h3 className="text-sm font-medium">{t('nevi.operatorName')}</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="nevi-operator-name">{t('nevi.operatorName')}</Label>
                    <Input
                      id="nevi-operator-name"
                      value={operatorName}
                      onChange={(e) => {
                        setOperatorName(e.target.value);
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="nevi-operator-address">{t('nevi.operatorAddress')}</Label>
                    <Input
                      id="nevi-operator-address"
                      value={operatorAddress}
                      onChange={(e) => {
                        setOperatorAddress(e.target.value);
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="nevi-operator-phone">{t('nevi.operatorPhone')}</Label>
                    <Input
                      id="nevi-operator-phone"
                      value={operatorPhone}
                      onChange={(e) => {
                        setOperatorPhone(e.target.value);
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="nevi-operator-email">{t('nevi.operatorEmail')}</Label>
                    <Input
                      id="nevi-operator-email"
                      type="email"
                      value={operatorEmail}
                      onChange={(e) => {
                        setOperatorEmail(e.target.value);
                      }}
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <h3 className="text-sm font-medium">{t('nevi.installationCost')}</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="nevi-installation-cost">{t('nevi.installationCost')}</Label>
                    <Input
                      id="nevi-installation-cost"
                      type="number"
                      value={installationCost}
                      onChange={(e) => {
                        setInstallationCost(e.target.value);
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="nevi-grid-connection-cost">
                      {t('nevi.gridConnectionCost')}
                    </Label>
                    <Input
                      id="nevi-grid-connection-cost"
                      type="number"
                      value={gridConnectionCost}
                      onChange={(e) => {
                        setGridConnectionCost(e.target.value);
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="nevi-maintenance-cost-annual">
                      {t('nevi.maintenanceCostAnnual')}
                    </Label>
                    <Input
                      id="nevi-maintenance-cost-annual"
                      type="number"
                      value={maintenanceCostAnnual}
                      onChange={(e) => {
                        setMaintenanceCostAnnual(e.target.value);
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="nevi-maintenance-cost-year">
                      {t('nevi.maintenanceCostYear')}
                    </Label>
                    <Input
                      id="nevi-maintenance-cost-year"
                      type="number"
                      value={maintenanceCostYear}
                      onChange={(e) => {
                        setMaintenanceCostYear(e.target.value);
                      }}
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <h3 className="text-sm font-medium">{t('nevi.derType')}</h3>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1">
                    <Label htmlFor="nevi-der-type">{t('nevi.derType')}</Label>
                    <Input
                      id="nevi-der-type"
                      value={derType}
                      onChange={(e) => {
                        setDerType(e.target.value);
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="nevi-der-capacity-kw">{t('nevi.derCapacityKw')}</Label>
                    <Input
                      id="nevi-der-capacity-kw"
                      type="number"
                      value={derCapacityKw}
                      onChange={(e) => {
                        setDerCapacityKw(e.target.value);
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="nevi-der-capacity-kwh">{t('nevi.derCapacityKwh')}</Label>
                    <Input
                      id="nevi-der-capacity-kwh"
                      type="number"
                      value={derCapacityKwh}
                      onChange={(e) => {
                        setDerCapacityKwh(e.target.value);
                      }}
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <h3 className="text-sm font-medium">{t('nevi.programParticipation')}</h3>
                <div className="space-y-1">
                  <Label htmlFor="nevi-program-participation">
                    {t('nevi.programParticipation')}
                  </Label>
                  <Input
                    id="nevi-program-participation"
                    value={programParticipation}
                    onChange={(e) => {
                      setProgramParticipation(e.target.value);
                    }}
                    placeholder="Program A, Program B"
                  />
                </div>
              </div>

              {saveMutation.isError && (
                <p className="text-sm text-destructive">{getErrorMessage(saveMutation.error, t)}</p>
              )}

              <DialogFooter>
                <CancelButton
                  onClick={() => {
                    setEditStation(null);
                  }}
                />
                <SaveButton isPending={saveMutation.isPending} />
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function ExcludedDowntimeSection(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const queryClient = useQueryClient();

  const [stationFilter, setStationFilter] = useState('');
  const [fromFilter, setFromFilter] = useState('');
  const [toFilter, setToFilter] = useState('');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [form, setForm] = useState<DowntimeForm>(EMPTY_DOWNTIME_FORM);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const extraParams: Record<string, string> = {};
  if (stationFilter) extraParams['stationId'] = stationFilter;
  if (fromFilter) extraParams['from'] = fromFilter;
  if (toFilter) extraParams['to'] = toFilter;

  const {
    data: downtimeRecords,
    isLoading,
    page,
    totalPages,
    setPage,
  } = usePaginatedQuery<Downtime>('excluded-downtime', '/v1/nevi/excluded-downtime', extraParams);

  const { data: stationsResp } = useQuery({
    queryKey: ['nevi-downtime-stations'],
    queryFn: () => api.get<{ data: NeviStation[] }>('/v1/stations?limit=100'),
  });

  const stations = stationsResp?.data ?? [];

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post('/v1/nevi/excluded-downtime', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['excluded-downtime'] });
      setDialogOpen(false);
      setForm(EMPTY_DOWNTIME_FORM);
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: { id: number; body: Record<string, unknown> }) =>
      api.patch(`/v1/nevi/excluded-downtime/${String(data.id)}`, data.body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['excluded-downtime'] });
      setDialogOpen(false);
      setEditId(null);
      setForm(EMPTY_DOWNTIME_FORM);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/v1/nevi/excluded-downtime/${String(id)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['excluded-downtime'] });
    },
  });

  function openCreate(): void {
    setEditId(null);
    setForm(EMPTY_DOWNTIME_FORM);
    setHasSubmitted(false);
    createMutation.reset();
    updateMutation.reset();
    setDialogOpen(true);
  }

  function openEdit(record: Downtime): void {
    setEditId(record.id);
    setForm({
      stationId: record.stationId,
      evseId: String(record.evseId),
      reason: record.reason,
      startedAt: record.startedAt.slice(0, 16),
      endedAt: record.endedAt != null ? record.endedAt.slice(0, 16) : '',
      notes: record.notes ?? '',
    });
    setHasSubmitted(false);
    createMutation.reset();
    updateMutation.reset();
    setDialogOpen(true);
  }

  function getDowntimeValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (form.stationId === '') {
      errors.stationId = t('validation.selectRequired');
    }
    if (form.evseId.trim() === '') {
      errors.evseId = t('validation.required');
    }
    if (form.startedAt.trim() === '') {
      errors.startedAt = t('validation.required');
    }
    return errors;
  }

  const downtimeErrors = getDowntimeValidationErrors();

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(downtimeErrors).length > 0) return;
    const body: Record<string, unknown> = {
      stationId: form.stationId,
      evseId: Number(form.evseId),
      reason: form.reason,
      startedAt: new Date(form.startedAt).toISOString(),
      endedAt: form.endedAt !== '' ? new Date(form.endedAt).toISOString() : null,
      notes: form.notes || null,
    };

    if (editId != null) {
      updateMutation.mutate({ id: editId, body });
    } else {
      createMutation.mutate(body);
    }
  }

  const activeMutation = editId != null ? updateMutation : createMutation;

  function updateForm(field: keyof DowntimeForm, value: string): void {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{t('nevi.excludedDowntime')}</CardTitle>
        <CreateButton label={t('nevi.createDowntime')} onClick={openCreate} />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1">
            <Label htmlFor="nevi-station-filter">{t('nevi.station')}</Label>
            <Select
              id="nevi-station-filter"
              value={stationFilter}
              onChange={(e) => {
                setStationFilter(e.target.value);
                setPage(1);
              }}
              className="h-9"
            >
              <option value="">{t('common.all')}</option>
              {stations.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.stationId}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="nevi-downtime-filter-from">{t('nevi.startedAt')}</Label>
            <Input
              id="nevi-downtime-filter-from"
              type="date"
              aria-label="Start date"
              value={fromFilter}
              onChange={(e) => {
                setFromFilter(e.target.value);
                setPage(1);
              }}
              className="w-40"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="nevi-downtime-filter-to">{t('nevi.endedAt')}</Label>
            <Input
              id="nevi-downtime-filter-to"
              type="date"
              aria-label="End date"
              value={toFilter}
              onChange={(e) => {
                setToFilter(e.target.value);
                setPage(1);
              }}
              className="w-40"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('nevi.station')}</TableHead>
                <TableHead>{t('nevi.evseId')}</TableHead>
                <TableHead>{t('nevi.reason')}</TableHead>
                <TableHead>{t('nevi.startedAt')}</TableHead>
                <TableHead>{t('nevi.endedAt')}</TableHead>
                <TableHead>{t('nevi.notes')}</TableHead>
                <TableHead />
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
              {downtimeRecords?.map((record) => (
                <TableRow key={record.id}>
                  <TableCell>{record.stationName}</TableCell>
                  <TableCell>{record.evseId}</TableCell>
                  <TableCell>{t(`nevi.reasons.${record.reason}`, record.reason)}</TableCell>
                  <TableCell>{formatDateTime(record.startedAt, timezone)}</TableCell>
                  <TableCell>
                    {record.endedAt != null ? formatDateTime(record.endedAt, timezone) : '-'}
                  </TableCell>
                  <TableCell className="max-w-[200px] truncate">{record.notes ?? '-'}</TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <EditButton
                        label={t('nevi.editDowntime')}
                        onClick={() => {
                          openEdit(record);
                        }}
                      />
                      <RemoveButton
                        label={t('nevi.deleteDowntime')}
                        onClick={() => {
                          setDeleteId(record.id);
                        }}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {downtimeRecords?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    {t('nevi.noDowntime')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

        <Dialog
          open={dialogOpen}
          onOpenChange={(open) => {
            if (!open) {
              setDialogOpen(false);
              setEditId(null);
              setForm(EMPTY_DOWNTIME_FORM);
              setHasSubmitted(false);
            }
          }}
        >
          <DialogContent className="max-w-sm md:max-w-lg">
            <DialogHeader>
              <DialogTitle>
                {editId != null ? t('nevi.editDowntime') : t('nevi.addDowntime')}
              </DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} noValidate className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="nevi-downtime-station">{t('nevi.station')}</Label>
                <Select
                  id="nevi-downtime-station"
                  value={form.stationId}
                  onChange={(e) => {
                    updateForm('stationId', e.target.value);
                  }}
                  className={
                    hasSubmitted && downtimeErrors.stationId ? 'h-9 border-destructive' : 'h-9'
                  }
                >
                  <option value="">{t('common.select')}</option>
                  {stations.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.stationId}
                    </option>
                  ))}
                </Select>
                {hasSubmitted && downtimeErrors.stationId && (
                  <p className="text-sm text-destructive">{downtimeErrors.stationId}</p>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="nevi-downtime-evse-id">{t('nevi.evseId')}</Label>
                <Input
                  id="nevi-downtime-evse-id"
                  type="number"
                  value={form.evseId}
                  onChange={(e) => {
                    updateForm('evseId', e.target.value);
                  }}
                  className={hasSubmitted && downtimeErrors.evseId ? 'border-destructive' : ''}
                />
                {hasSubmitted && downtimeErrors.evseId && (
                  <p className="text-sm text-destructive">{downtimeErrors.evseId}</p>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="nevi-downtime-reason">{t('nevi.reason')}</Label>
                <Select
                  id="nevi-downtime-reason"
                  value={form.reason}
                  onChange={(e) => {
                    updateForm('reason', e.target.value);
                  }}
                  className="h-9"
                >
                  {DOWNTIME_REASONS.map((reason) => (
                    <option key={reason} value={reason}>
                      {t(`nevi.reasons.${reason}`, reason)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="nevi-downtime-started-at">{t('nevi.startedAt')}</Label>
                <Input
                  id="nevi-downtime-started-at"
                  type="datetime-local"
                  value={form.startedAt}
                  onChange={(e) => {
                    updateForm('startedAt', e.target.value);
                  }}
                  className={hasSubmitted && downtimeErrors.startedAt ? 'border-destructive' : ''}
                />
                {hasSubmitted && downtimeErrors.startedAt && (
                  <p className="text-sm text-destructive">{downtimeErrors.startedAt}</p>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="nevi-downtime-ended-at">{t('nevi.endedAt')}</Label>
                <Input
                  id="nevi-downtime-ended-at"
                  type="datetime-local"
                  value={form.endedAt}
                  onChange={(e) => {
                    updateForm('endedAt', e.target.value);
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label>{t('nevi.notes')}</Label>
                <textarea
                  className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                  value={form.notes}
                  onChange={(e) => {
                    updateForm('notes', e.target.value);
                  }}
                />
              </div>

              {activeMutation.isError && (
                <p className="text-sm text-destructive">
                  {getErrorMessage(activeMutation.error, t)}
                </p>
              )}

              <DialogFooter>
                <CancelButton
                  onClick={() => {
                    setDialogOpen(false);
                    setEditId(null);
                    setForm(EMPTY_DOWNTIME_FORM);
                  }}
                />
                <SaveButton isPending={activeMutation.isPending} />
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <ConfirmDialog
          open={deleteId != null}
          onOpenChange={(open) => {
            if (!open) setDeleteId(null);
          }}
          title={t('nevi.deleteDowntime')}
          description={t('nevi.downtimeDeleted')}
          confirmLabel={t('nevi.deleteDowntime')}
          confirmIcon={<Trash2 className="h-4 w-4" />}
          onConfirm={() => {
            if (deleteId != null) {
              deleteMutation.mutate(deleteId);
            }
          }}
        />
      </CardContent>
    </Card>
  );
}

// -- Main Component --

export function NeviComplianceTab(): React.JSX.Element {
  const { t } = useTranslation();
  const [neviSubTab, setNeviSubTab] = useState('ev-chart');

  return (
    <Tabs value={neviSubTab} onValueChange={setNeviSubTab}>
      <TabsList>
        <TabsTrigger value="ev-chart">{t('nevi.exportTab')}</TabsTrigger>
        <TabsTrigger value="station-data">{t('nevi.stationDataTab')}</TabsTrigger>
        <TabsTrigger value="downtime">{t('nevi.downtimeTab')}</TabsTrigger>
      </TabsList>

      <TabsContent value="ev-chart">
        <EvChartExportSection />
      </TabsContent>
      <TabsContent value="station-data">
        <StationDataSection />
      </TabsContent>
      <TabsContent value="downtime">
        <ExcludedDowntimeSection />
      </TabsContent>
    </Tabs>
  );
}
