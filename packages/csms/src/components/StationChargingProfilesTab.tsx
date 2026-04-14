// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Upload, Eye, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
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
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Pagination } from '@/components/ui/pagination';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/timezone';

interface ChargingProfile {
  id: number;
  source: string;
  evseId: number | null;
  chargingLimitSource: string | null;
  profileData: Record<string, unknown>;
  sentAt: string | null;
  reportedAt: string | null;
  createdAt: string;
}

interface ChargingProfileTemplate {
  id: string;
  name: string;
  ocppVersion: string;
  profilePurpose: string;
}

interface CompositeSchedulePeriod {
  startPeriod: number;
  limit: number;
  numberPhases?: number;
}

interface CompositeResponse {
  status?: string;
  schedule?: {
    chargingSchedulePeriod?: CompositeSchedulePeriod[];
    chargingRateUnit?: string;
    duration?: number;
  };
}

interface Props {
  stationId: string;
  timezone: string;
  isOnline: boolean;
  ocppProtocol: string | null;
}

export function StationChargingProfilesTab({
  stationId,
  timezone,
  isOnline,
  ocppProtocol,
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const limit = 25;

  // Refresh spinning state
  const [spinning, setSpinning] = useState(false);

  // Dialog states
  const [pushDialogOpen, setPushDialogOpen] = useState(false);
  const [compositeDialogOpen, setCompositeDialogOpen] = useState(false);
  const [clearAllDialogOpen, setClearAllDialogOpen] = useState(false);
  const [clearProfileId, setClearProfileId] = useState<number | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [pushResult, setPushResult] = useState<{
    success: boolean;
    status: string;
    errorInfo?: string;
  } | null>(null);

  const isOcpp16 = ocppProtocol === 'ocpp1.6';

  const { data, isLoading } = useQuery({
    queryKey: ['stations', stationId, 'charging-profiles', page],
    queryFn: () =>
      api.get<{ data: ChargingProfile[]; total: number }>(
        `/v1/stations/${stationId}/charging-profiles?page=${String(page)}&limit=${String(limit)}`,
      ),
  });

  const totalPages = data != null ? Math.ceil(data.total / limit) : 1;

  // Templates for push dialog
  const { data: templates } = useQuery({
    queryKey: ['smart-charging-templates'],
    queryFn: () =>
      api.get<{ data: ChargingProfileTemplate[]; total: number }>(
        '/v1/smart-charging/templates?limit=100',
      ),
    enabled: pushDialogOpen,
  });

  const filteredTemplates = (templates?.data ?? []).filter((tpl) => {
    if (isOcpp16) return tpl.ocppVersion === '1.6';
    return tpl.ocppVersion === '2.1';
  });

  // Refresh mutation
  const refreshMutation = useMutation({
    mutationFn: async () => {
      setSpinning(true);
      const minSpin = new Promise<void>((r) => setTimeout(r, 1000));
      const result = api.post(`/v1/stations/${stationId}/charging-profiles/refresh`, {});
      await Promise.all([result, minSpin]);
      return result;
    },
    onSettled: () => {
      setTimeout(() => {
        setSpinning(false);
        void queryClient.invalidateQueries({
          queryKey: ['stations', stationId, 'charging-profiles'],
        });
      }, 3000);
    },
  });
  const isRefreshing = refreshMutation.isPending || spinning;

  // Push mutation
  const pushMutation = useMutation({
    mutationFn: (templateId: string) =>
      api.post<{ success: boolean; status: string; errorInfo?: string }>(
        `/v1/stations/${stationId}/charging-profiles/push`,
        { templateId },
      ),
    onSuccess: (result) => {
      setPushResult(result);
      void queryClient.invalidateQueries({
        queryKey: ['stations', stationId, 'charging-profiles'],
      });
    },
    onError: () => {
      setPushResult({ success: false, status: 'Failed', errorInfo: 'Request failed' });
    },
  });

  // Composite mutation
  const compositeMutation = useMutation({
    mutationFn: () =>
      api.post<CompositeResponse>(`/v1/stations/${stationId}/charging-profiles/composite`, {
        evseId: 0,
        duration: 86400,
      }),
  });

  // Clear mutation
  const clearMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post(`/v1/stations/${stationId}/charging-profiles/clear`, body),
    onSuccess: () => {
      toast({ title: t('common.success') });
      void queryClient.invalidateQueries({
        queryKey: ['stations', stationId, 'charging-profiles'],
      });
    },
  });

  function handleOpenComposite(): void {
    setCompositeDialogOpen(true);
    compositeMutation.mutate();
  }

  function handleOpenPush(): void {
    setPushDialogOpen(true);
    setSelectedTemplateId('');
    setPushResult(null);
  }

  const compositeSchedule = compositeMutation.data;
  const periods = compositeSchedule?.schedule?.chargingSchedulePeriod ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{t('stations.chargingProfiles')}</CardTitle>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!isOnline || isOcpp16 || isRefreshing}
            onClick={() => {
              refreshMutation.mutate();
            }}
            title={isOcpp16 ? t('stations.notSupportedOcpp16') : undefined}
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {isRefreshing ? t('stations.refreshing') : t('stations.refreshProfiles')}
          </Button>
          <Button variant="outline" size="sm" disabled={!isOnline} onClick={handleOpenPush}>
            <Upload className="h-4 w-4" />
            {t('stations.pushChargingProfile')}
          </Button>
          <Button variant="outline" size="sm" disabled={!isOnline} onClick={handleOpenComposite}>
            <Eye className="h-4 w-4" />
            {t('stations.viewComposite')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!isOnline}
            onClick={() => {
              setClearAllDialogOpen(true);
            }}
            className="text-destructive"
          >
            <Trash2 className="h-4 w-4" />
            {t('stations.clearAllProfiles')}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : data == null || data.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('stations.noChargingProfiles')}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('common.source')}</TableHead>
                    <TableHead>EVSE</TableHead>
                    <TableHead>{t('stations.limitSource')}</TableHead>
                    <TableHead>{t('common.created')}</TableHead>
                    <TableHead className="text-right">{t('common.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.data.map((profile) => (
                    <TableRow key={profile.id}>
                      <TableCell>
                        <Badge variant={profile.source === 'csms_set' ? 'default' : 'secondary'}>
                          {profile.source === 'csms_set' ? 'CSMS' : 'Station'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {profile.evseId != null ? String(profile.evseId) : '--'}
                      </TableCell>
                      <TableCell className="text-xs">
                        {profile.chargingLimitSource ?? '--'}
                      </TableCell>
                      <TableCell className="text-xs">
                        {formatDateTime(profile.createdAt, timezone)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={!isOnline}
                          onClick={() => {
                            setClearProfileId(profile.id);
                          }}
                          aria-label={t('stations.clearProfile')}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
          </>
        )}
      </CardContent>

      {/* Clear All Profiles confirm dialog */}
      <ConfirmDialog
        open={clearAllDialogOpen}
        onOpenChange={setClearAllDialogOpen}
        title={t('stations.clearAllProfiles')}
        description={t('stations.confirmClearAllProfiles')}
        confirmLabel={t('stations.clearAllProfiles')}
        variant="destructive"
        isPending={clearMutation.isPending}
        onConfirm={() => {
          clearMutation.mutate({});
          setClearAllDialogOpen(false);
        }}
      />

      {/* Clear single profile confirm dialog */}
      <ConfirmDialog
        open={clearProfileId != null}
        onOpenChange={(open) => {
          if (!open) setClearProfileId(null);
        }}
        title={t('stations.clearProfile')}
        description={t('stations.confirmClearProfile')}
        confirmLabel={t('stations.clearProfile')}
        variant="destructive"
        isPending={clearMutation.isPending}
        onConfirm={() => {
          if (clearProfileId != null) {
            clearMutation.mutate({ chargingProfileId: clearProfileId });
          }
          setClearProfileId(null);
        }}
      />

      {/* Push Charging Profile dialog */}
      <Dialog open={pushDialogOpen} onOpenChange={setPushDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('stations.pushChargingProfile')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <label htmlFor="push-template-select" className="text-sm font-medium">
                {t('stations.selectTemplate')}
              </label>
              <Select
                id="push-template-select"
                value={selectedTemplateId}
                onChange={(e) => {
                  setSelectedTemplateId(e.target.value);
                  setPushResult(null);
                }}
              >
                <option value="">{t('stations.selectTemplate')}</option>
                {filteredTemplates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.name} ({tpl.profilePurpose})
                  </option>
                ))}
              </Select>
            </div>
            {pushResult != null && (
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{t('stations.pushResult')}:</span>
                <Badge variant={pushResult.success ? 'success' : 'destructive'}>
                  {pushResult.status}
                </Badge>
                {pushResult.errorInfo != null && (
                  <span className="text-xs text-muted-foreground">{pushResult.errorInfo}</span>
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
              {pushMutation.isPending ? t('common.loading') : t('stations.pushChargingProfile')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Composite Schedule dialog */}
      <Dialog open={compositeDialogOpen} onOpenChange={setCompositeDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('stations.viewComposite')}</DialogTitle>
          </DialogHeader>
          {compositeMutation.isPending ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : compositeMutation.isError ? (
            <p className="text-sm text-destructive">{t('common.error')}</p>
          ) : compositeSchedule != null ? (
            <>
              {compositeSchedule.status != null && (
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{t('common.status')}:</span>
                  <Badge
                    variant={compositeSchedule.status === 'Accepted' ? 'success' : 'secondary'}
                  >
                    {compositeSchedule.status}
                  </Badge>
                </div>
              )}
              {periods.length > 0 ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Start (s)</TableHead>
                        <TableHead>
                          Limit ({compositeSchedule.schedule?.chargingRateUnit ?? 'W'})
                        </TableHead>
                        <TableHead>Phases</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {periods.map((period, idx) => (
                        <TableRow key={idx}>
                          <TableCell className="text-xs">{String(period.startPeriod)}</TableCell>
                          <TableCell className="text-xs">{String(period.limit)}</TableCell>
                          <TableCell className="text-xs">
                            {period.numberPhases != null ? String(period.numberPhases) : '--'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t('stations.noChargingProfiles')}</p>
              )}
            </>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCompositeDialogOpen(false);
              }}
            >
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
