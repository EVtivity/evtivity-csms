// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Upload } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';

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
}

interface PushResult {
  success: boolean;
  results: Array<{ variable: string; status: string }>;
}

interface Props {
  stationId: string;
  isOnline: boolean;
  ocppProtocol: string | null;
}

export function StationConfigurationsTab({
  stationId,
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

  const isOcpp16 = ocppProtocol === 'ocpp1.6';

  const { data: configTemplates } = useQuery({
    queryKey: ['config-templates-list'],
    queryFn: () =>
      api.get<{ data: ConfigTemplate[]; total: number }>('/v1/config-templates?limit=100'),
    enabled: pushDialogOpen,
  });

  const filteredTemplates = (configTemplates?.data ?? []).filter((tpl) => {
    if (isOcpp16) return tpl.ocppVersion === '1.6';
    return tpl.ocppVersion === '2.1';
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
      setPushResult({ success: false, results: [{ variable: '--', status: 'Failed' }] });
    },
  });

  function handleOpenPush(): void {
    setPushDialogOpen(true);
    setSelectedTemplateId('');
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
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{t('stations.configurations')}</CardTitle>
        <div className="flex items-center gap-2">
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
          <Button variant="outline" size="sm" disabled={!isOnline} onClick={handleOpenPush}>
            <Upload className="h-4 w-4" />
            {t('stations.pushConfiguration')}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : data == null || data.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('stations.noConfigurations')}</p>
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
                      <TableCell className="text-xs max-w-xs truncate">{v.value ?? '--'}</TableCell>
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
        <DialogContent className="max-w-lg">
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
                <Badge variant={pushResult.success ? 'success' : 'destructive'} className="w-fit">
                  {pushResult.success ? 'Accepted' : 'Rejected'}
                </Badge>
                {pushResult.results.length > 0 && (
                  <div className="overflow-x-auto max-h-60">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('stations.variable')}</TableHead>
                          <TableHead>{t('common.status')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pushResult.results.map((r, idx) => (
                          <TableRow key={idx}>
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
    </Card>
  );
}
