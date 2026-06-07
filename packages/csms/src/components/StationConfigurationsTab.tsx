// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Pencil, RefreshCw, RotateCcw, Upload } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { SearchInput } from '@/components/search-input';
import { Pagination } from '@/components/ui/pagination';
import { api, getApiErrorMessage } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { LoadingLogo } from '@/components/loading-logo';

interface StationVariable {
  id: number;
  component: string;
  instance: string | null;
  evseId: number | null;
  connectorId: number | null;
  variable: string;
  variableInstance: string | null;
  value: string | null;
  attributeType: string;
  source: string;
}

interface ConfigTemplate {
  id: string;
  name: string;
  ocppVersion: string;
  stationId: string | null;
}

interface PushResult {
  success: boolean;
  results: Array<{ component: string; variable: string; status: string }>;
}

interface Props {
  stationId: string;
  stationOcppId: string;
  isOnline: boolean;
  ocppProtocol: string | null;
}

export function StationConfigurationsTab({
  stationId,
  stationOcppId,
  isOnline,
  ocppProtocol,
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const limit = 25;

  const [spinning, setSpinning] = useState(false);
  const refreshMutation = useMutation({
    mutationFn: async () => {
      setSpinning(true);
      const minSpin = new Promise<void>((r) => setTimeout(r, 1000));
      const result = api.post(`/v1/stations/${stationId}/configurations/refresh`, {});
      await Promise.all([result, minSpin]);
      return result;
    },
    onSettled: () => {
      setTimeout(() => {
        setSpinning(false);
        void queryClient.invalidateQueries({ queryKey: ['stations', stationId, 'configurations'] });
      }, 3000);
    },
  });
  const isRefreshing = refreshMutation.isPending || spinning;

  // Push config dialog state
  const [pushDialogOpen, setPushDialogOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [pushResult, setPushResult] = useState<PushResult | null>(null);
  const [rebootConfirmOpen, setRebootConfirmOpen] = useState(false);

  const isOcpp16 = ocppProtocol === 'ocpp1.6';

  const { data: configTemplates } = useQuery({
    queryKey: ['config-templates-list'],
    queryFn: () =>
      api.get<{ data: ConfigTemplate[]; total: number }>('/v1/config-templates?limit=100'),
  });

  const defaultTemplate = (configTemplates?.data ?? []).find((tpl) => tpl.stationId === stationId);

  const filteredTemplates = (configTemplates?.data ?? [])
    .filter((tpl) => {
      const versionMatch = isOcpp16 ? tpl.ocppVersion === '1.6' : tpl.ocppVersion === '2.1';
      if (!versionMatch) return false;
      // Exclude other stations' default templates. Templates without an owning
      // station (general templates) remain visible.
      if (tpl.stationId != null && tpl.stationId !== stationId) return false;
      return true;
    })
    .sort((a, b) => {
      if (a.id === defaultTemplate?.id) return -1;
      if (b.id === defaultTemplate?.id) return 1;
      return a.name.localeCompare(b.name);
    });

  const pushMutation = useMutation({
    mutationFn: (templateId: string) =>
      api.post<PushResult>(`/v1/stations/${stationId}/configurations/push`, { templateId }),
    onSuccess: (result) => {
      setPushResult(result);
      if (result.success) {
        toast({ title: t('common.success') });
      }
      void queryClient.invalidateQueries({ queryKey: ['stations', stationId, 'configurations'] });
    },
    onError: () => {
      setPushResult({
        success: false,
        results: [{ component: '', variable: 'n/a', status: 'Failed' }],
      });
    },
  });

  const rebootMutation = useMutation({
    mutationFn: async () => {
      const path = isOcpp16 ? '/v1/ocpp/commands/v16/Reset' : '/v1/ocpp/commands/v21/Reset';
      const payload = isOcpp16
        ? { stationId: stationOcppId, type: 'Soft' }
        : { stationId: stationOcppId, type: 'OnIdle' };
      const result = await api.post<{
        status?: string;
        response?: { status?: string };
      }>(path, payload);
      const ocppStatus = result.response?.status;
      if (ocppStatus != null && ocppStatus !== 'Accepted' && ocppStatus !== 'Scheduled') {
        throw new Error(t('stations.rebootRejectedStatus', { status: ocppStatus }));
      }
      return result;
    },
    onSuccess: () => {
      toast({ title: t('stations.rebootSuccess'), variant: 'success' });
      setRebootConfirmOpen(false);
    },
    onError: (err) => {
      const apiMessage = getApiErrorMessage(err);
      const message =
        apiMessage ?? (err instanceof Error ? err.message : t('stations.rebootFailed'));
      toast({ title: t('stations.rebootFailed'), description: message, variant: 'destructive' });
    },
  });

  function handleOpenPush(): void {
    setPushDialogOpen(true);
    setSelectedTemplateId(defaultTemplate?.id ?? '');
    setPushResult(null);
  }

  const { data, isLoading } = useQuery({
    queryKey: ['stations', stationId, 'configurations', page, search],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (search !== '') params.set('search', search);
      return api.get<{ data: StationVariable[]; total: number }>(
        `/v1/stations/${stationId}/variables?${params.toString()}`,
      );
    },
  });

  const totalPages = data != null ? Math.ceil(data.total / limit) : 1;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>{t('stations.configurations')}</CardTitle>
        <div className="grid grid-cols-2 gap-2 [&>*:last-child:nth-child(odd)]:col-span-2 sm:flex">
          <SearchInput
            value={search}
            onDebouncedChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder={t('common.search')}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!isOnline || isRefreshing}
            onClick={() => {
              refreshMutation.mutate();
            }}
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {isRefreshing ? t('stations.refreshing') : t('stations.refreshConfigurations')}
          </Button>
          {defaultTemplate != null && (
            <Link to={`/station-configurations/${defaultTemplate.id}`}>
              <Button variant="outline" size="sm">
                <Pencil className="h-4 w-4" />
                {t('stations.editStationConfiguration')}
              </Button>
            </Link>
          )}
          <Button variant="outline" size="sm" disabled={!isOnline} onClick={handleOpenPush}>
            <Upload className="h-4 w-4" />
            {t('stations.pushConfiguration')}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <LoadingLogo size="inline" />
        ) : data == null || data.data.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">
            {t('stations.noConfigurations')}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('stations.component')}</TableHead>
                    <TableHead>{t('stations.variable')}</TableHead>
                    <TableHead>{t('common.value')}</TableHead>
                    <TableHead>{t('common.type')}</TableHead>
                    <TableHead>{t('common.source')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.data.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="text-xs">
                        {v.component}
                        {v.instance != null ? ` (${v.instance})` : ''}
                        {v.evseId != null ? ` EVSE ${String(v.evseId)}` : ''}
                        {v.connectorId != null ? ` Con ${String(v.connectorId)}` : ''}
                      </TableCell>
                      <TableCell className="text-xs">
                        {v.variable}
                        {v.variableInstance != null ? ` (${v.variableInstance})` : ''}
                      </TableCell>
                      <TableCell className="text-xs max-w-xs truncate">
                        {v.value ?? 'n/a'}
                      </TableCell>
                      <TableCell className="text-xs">{v.attributeType}</TableCell>
                      <TableCell className="text-xs">{v.source}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
          </>
        )}
      </CardContent>

      {/* Push Configuration dialog */}
      <Dialog open={pushDialogOpen} onOpenChange={setPushDialogOpen}>
        <DialogContent className="max-w-[95vw] md:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('stations.pushConfiguration')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <label htmlFor="push-config-template-select" className="text-sm font-medium">
                {t('stations.selectConfigTemplate')}
              </label>
              <Select
                id="push-config-template-select"
                value={selectedTemplateId}
                onChange={(e) => {
                  setSelectedTemplateId(e.target.value);
                  setPushResult(null);
                }}
              >
                <option value="">{t('stations.selectConfigTemplate')}</option>
                {filteredTemplates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.name}
                  </option>
                ))}
              </Select>
            </div>
            {pushResult != null && (
              <div className="grid gap-2">
                <span className="text-sm font-medium">{t('stations.pushConfigResult')}:</span>
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant={pushResult.success ? 'success' : 'destructive'} className="w-fit">
                    {pushResult.success ? 'Accepted' : 'Rejected'}
                  </Badge>
                  {pushResult.success && isOnline && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setRebootConfirmOpen(true);
                      }}
                    >
                      <RotateCcw className="h-4 w-4" />
                      {t('stations.rebootStation')}
                    </Button>
                  )}
                </div>
                {pushResult.results.length > 0 && (
                  <div className="overflow-x-auto max-h-60">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {!isOcpp16 && <TableHead>{t('stations.component')}</TableHead>}
                          <TableHead>{t('stations.variable')}</TableHead>
                          <TableHead>{t('common.status')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pushResult.results.map((r, idx) => (
                          <TableRow key={idx}>
                            {!isOcpp16 && <TableCell className="text-xs">{r.component}</TableCell>}
                            <TableCell className="text-xs">{r.variable}</TableCell>
                            <TableCell>
                              <Badge variant={r.status === 'Accepted' ? 'success' : 'destructive'}>
                                {r.status}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPushDialogOpen(false);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              disabled={selectedTemplateId === '' || pushMutation.isPending}
              onClick={() => {
                pushMutation.mutate(selectedTemplateId);
              }}
            >
              {pushMutation.isPending ? t('common.loading') : t('stations.pushConfiguration')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={rebootConfirmOpen}
        onOpenChange={setRebootConfirmOpen}
        variant="default"
        title={t('stations.rebootStation')}
        description={t('stations.confirmRebootStation', { stationId })}
        confirmLabel={t('stations.rebootStation')}
        isPending={rebootMutation.isPending}
        onConfirm={() => {
          rebootMutation.mutate();
        }}
      />
    </Card>
  );
}
