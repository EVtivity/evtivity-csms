// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Upload, Eye, Trash2, Copy } from 'lucide-react';
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
import { LoadingLogo } from '@/components/loading-logo';

interface ChargingProfile {
  id: number;
  source: string;
  evseId: number | null;
  chargingLimitSource: string | null;
  profileData: Record<string, unknown>;
  sentAt: string | null;
  reportedAt: string | null;
  createdAt: string;
  templateId: string | null;
  templateName: string | null;
}

// `profile.id` is the CSMS database row PK. The OCPP profile id (which a station
// uses to identify a profile when clearing) lives inside `profile_data.id`.
// Returns null when the station-reported profile has no numeric id.
function ocppProfileId(profile: ChargingProfile): number | null {
  const raw = profile.profileData['id'];
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return Number(raw);
  return null;
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
    startSchedule?: string;
  };
  scheduleStart?: string;
  evseId?: number;
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
  const [viewProfile, setViewProfile] = useState<ChargingProfile | null>(null);

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
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>{t('stations.chargingProfiles')}</CardTitle>
        <div className="grid grid-cols-2 gap-2 [&>*:last-child:nth-child(odd)]:col-span-2 sm:flex">
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
          <LoadingLogo size="inline" />
        ) : data == null || data.data.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">
            {t('stations.noChargingProfiles')}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('common.source')}</TableHead>
                    <TableHead>EVSE</TableHead>
                    <TableHead>{t('stations.limitSource')}</TableHead>
                    <TableHead>{t('smartCharging.template')}</TableHead>
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
                        {profile.evseId != null ? String(profile.evseId) : 'n/a'}
                      </TableCell>
                      <TableCell className="text-xs">
                        {profile.chargingLimitSource ?? 'n/a'}
                      </TableCell>
                      <TableCell className="text-xs">
                        {profile.templateId != null ? (
                          <Link
                            to={`/smart-charging/${profile.templateId}`}
                            className="text-primary hover:underline"
                          >
                            {profile.templateName ?? profile.templateId}
                          </Link>
                        ) : (
                          'n/a'
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {formatDateTime(profile.createdAt, timezone)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            setViewProfile(profile);
                          }}
                          aria-label={t('common.view')}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={!isOnline || ocppProfileId(profile) == null}
                          onClick={() => {
                            const ocppId = ocppProfileId(profile);
                            if (ocppId != null) setClearProfileId(ocppId);
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
        <DialogContent className="max-w-[95vw] md:max-w-lg">
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

      {/* View raw profile JSON dialog */}
      <Dialog
        open={viewProfile != null}
        onOpenChange={(open) => {
          if (!open) setViewProfile(null);
        }}
      >
        <DialogContent className="max-w-[95vw] md:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('stations.chargingProfileDetails')}</DialogTitle>
          </DialogHeader>
          {viewProfile != null && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">{t('common.source')}: </span>
                  <Badge
                    variant={viewProfile.source === 'csms_set' ? 'default' : 'secondary'}
                    className="ml-1"
                  >
                    {viewProfile.source === 'csms_set' ? 'CSMS' : 'Station'}
                  </Badge>
                </div>
                <div>
                  <span className="text-muted-foreground">EVSE: </span>
                  {viewProfile.evseId != null ? String(viewProfile.evseId) : 'n/a'}
                </div>
                <div>
                  <span className="text-muted-foreground">{t('stations.limitSource')}: </span>
                  {viewProfile.chargingLimitSource ?? 'n/a'}
                </div>
                <div>
                  <span className="text-muted-foreground">{t('smartCharging.template')}: </span>
                  {viewProfile.templateId != null ? (
                    <Link
                      to={`/smart-charging/${viewProfile.templateId}`}
                      className="text-primary hover:underline"
                    >
                      {viewProfile.templateName ?? viewProfile.templateId}
                    </Link>
                  ) : (
                    'n/a'
                  )}
                </div>
              </div>
              <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs font-mono max-h-[60vh]">
                {JSON.stringify(viewProfile.profileData, null, 2)}
              </pre>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (viewProfile != null) {
                  void navigator.clipboard.writeText(
                    JSON.stringify(viewProfile.profileData, null, 2),
                  );
                }
              }}
            >
              <Copy className="h-4 w-4" />
              {t('common.copy')}
            </Button>
            <Button
              onClick={() => {
                setViewProfile(null);
              }}
            >
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Composite Schedule dialog */}
      <Dialog open={compositeDialogOpen} onOpenChange={setCompositeDialogOpen}>
        <DialogContent className="max-w-[95vw] md:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('stations.viewComposite')}</DialogTitle>
          </DialogHeader>
          {compositeMutation.isPending ? (
            <LoadingLogo size="inline" />
          ) : compositeMutation.isError ? (
            <p className="text-sm text-destructive">{t('common.error')}</p>
          ) : compositeSchedule != null ? (
            (() => {
              // Composite schedules can carry the anchor on `schedule.startSchedule`
              // or `scheduleStart`. If neither is present, do NOT fabricate one
              // from `Date.now()` — render offsets directly so the display stays
              // truthful.
              const anchorIso =
                compositeSchedule.schedule?.startSchedule ??
                compositeSchedule.scheduleStart ??
                null;
              const rateUnit = compositeSchedule.schedule?.chargingRateUnit ?? 'W';
              const status = compositeSchedule.status;
              return (
                <div className="space-y-3">
                  {status != null && status !== 'Accepted' && (
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{t('common.status')}:</span>
                      <Badge variant="destructive">{status}</Badge>
                    </div>
                  )}
                  {anchorIso == null && (
                    <p className="text-xs text-muted-foreground">
                      {t('stations.noScheduleAnchor')}
                    </p>
                  )}
                  {periods.length > 0 ? (
                    <>
                      <div className="overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>{t('stations.compositeTime')}</TableHead>
                              <TableHead>
                                {t('smartCharging.powerLimit')} ({rateUnit})
                              </TableHead>
                              <TableHead>{t('smartCharging.phases')}</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {periods.map((period, idx) => {
                              let label: string;
                              if (anchorIso != null) {
                                const ms =
                                  new Date(anchorIso).getTime() + period.startPeriod * 1000;
                                const wallClock = new Date(ms).toLocaleString('en-US', {
                                  timeZone: timezone,
                                  hour: 'numeric',
                                  minute: '2-digit',
                                  month: 'short',
                                  day: 'numeric',
                                });
                                label = `${wallClock}  (+${String(period.startPeriod)}s)`;
                              } else {
                                label = `+${String(period.startPeriod)}s`;
                              }
                              return (
                                <TableRow key={idx}>
                                  <TableCell className="text-xs">{label}</TableCell>
                                  <TableCell className="text-xs">{String(period.limit)}</TableCell>
                                  <TableCell className="text-xs">
                                    {period.numberPhases != null
                                      ? String(period.numberPhases)
                                      : 'n/a'}
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                      <details className="rounded-md border bg-muted/30">
                        <summary className="cursor-pointer px-3 py-2 text-xs font-medium select-none">
                          {t('stations.viewRaw')}
                        </summary>
                        <pre className="overflow-x-auto p-3 text-xs font-mono max-h-[40vh]">
                          {JSON.stringify(compositeSchedule, null, 2)}
                        </pre>
                      </details>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t('stations.noChargingProfiles')}
                    </p>
                  )}
                </div>
              );
            })()
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
