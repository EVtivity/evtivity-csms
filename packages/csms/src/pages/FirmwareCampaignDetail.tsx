// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { Play, XCircle } from 'lucide-react';
import { EditButton } from '@/components/edit-button';
import { RemoveButton } from '@/components/remove-button';
import { SaveButton } from '@/components/save-button';
import { CancelButton } from '@/components/cancel-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { MatchingStationsCard } from '@/components/MatchingStationsCard';
import { CopyableId } from '@/components/copyable-id';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/timezone';
import { useUserTimezone } from '@/lib/timezone';

interface CampaignStation {
  id: number;
  stationId: string;
  stationName: string;
  status: string;
  errorInfo: string | null;
  updatedAt: string;
}

interface CampaignDetail {
  id: string;
  name: string;
  firmwareUrl: string;
  version: string | null;
  status: string;
  targetFilter: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
  stations: CampaignStation[];
  stationsTotal: number;
  installedCount: number;
  failedCount: number;
  pendingCount: number;
  downloadingCount: number;
  downloadedCount: number;
  installingCount: number;
}

interface FilterOptions {
  sites: { id: string; name: string }[];
  vendors: { id: string; name: string }[];
  models: string[];
}

const STATUS_VARIANT: Record<
  string,
  'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning'
> = {
  draft: 'outline',
  active: 'warning',
  completed: 'success',
  cancelled: 'secondary',
};

const STATION_STATUS_VARIANT: Record<
  string,
  'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning'
> = {
  pending: 'outline',
  downloading: 'warning',
  downloaded: 'default',
  installing: 'warning',
  installed: 'success',
  failed: 'destructive',
};

export function FirmwareCampaignDetail(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editFirmwareUrl, setEditFirmwareUrl] = useState('');
  const [editVersion, setEditVersion] = useState('');
  const [editFilterSiteId, setEditFilterSiteId] = useState('');
  const [editFilterVendorId, setEditFilterVendorId] = useState('');
  const [editFilterModel, setEditFilterModel] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [progressPage, setProgressPage] = useState(1);
  const progressLimit = 10;

  const { data: campaign, isLoading } = useQuery({
    queryKey: ['firmware-campaigns', id, progressPage],
    queryFn: () =>
      api.get<CampaignDetail>(
        `/v1/firmware-campaigns/${id ?? ''}?page=${String(progressPage)}&limit=${String(progressLimit)}`,
      ),
    enabled: id != null,
  });

  const { data: filterOptions } = useQuery({
    queryKey: ['firmware-campaign-filter-options'],
    queryFn: () => api.get<FilterOptions>('/v1/firmware-campaigns/filter-options'),
  });

  const updateMutation = useMutation({
    mutationFn: (body: {
      name?: string;
      firmwareUrl?: string;
      version?: string;
      targetFilter?: { siteId?: string; vendorId?: string; model?: string } | null;
    }) => api.patch(`/v1/firmware-campaigns/${id ?? ''}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['firmware-campaigns', id] });
      setEditing(false);
    },
  });

  const startMutation = useMutation({
    mutationFn: () => api.post(`/v1/firmware-campaigns/${id ?? ''}/start`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['firmware-campaigns', id] });
      setStartOpen(false);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.post(`/v1/firmware-campaigns/${id ?? ''}/cancel`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['firmware-campaigns', id] });
      setCancelOpen(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/v1/firmware-campaigns/${id ?? ''}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['firmware-campaigns'] });
      void navigate('/settings?tab=firmware');
    },
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!editName.trim()) errors.editName = t('validation.required');
    if (!editFirmwareUrl.trim()) {
      errors.editFirmwareUrl = t('validation.required');
    } else {
      try {
        new URL(editFirmwareUrl);
      } catch {
        errors.editFirmwareUrl = t('validation.invalidUrl');
      }
    }
    return errors;
  }

  const validationErrors = getValidationErrors();

  function startEdit(): void {
    if (campaign == null) return;
    setEditName(campaign.name);
    setEditFirmwareUrl(campaign.firmwareUrl);
    setEditVersion(campaign.version ?? '');
    setEditFilterSiteId(campaign.targetFilter?.siteId ?? '');
    setEditFilterVendorId(campaign.targetFilter?.vendorId ?? '');
    setEditFilterModel(campaign.targetFilter?.model ?? '');
    setHasSubmitted(false);
    setEditing(true);
  }

  function resolveSiteName(siteId: string): string {
    return filterOptions?.sites.find((s) => s.id === siteId)?.name ?? siteId;
  }

  function resolveVendorName(vendorId: string): string {
    return filterOptions?.vendors.find((v) => v.id === vendorId)?.name ?? vendorId;
  }

  if (isLoading) {
    return <p className="text-muted-foreground">{t('common.loading')}</p>;
  }

  if (campaign == null) {
    return <p className="text-destructive">{t('firmwareCampaigns.notFound')}</p>;
  }

  const stations = campaign.stations;
  const totalStations = campaign.stationsTotal;
  const completedStations = campaign.installedCount + campaign.failedCount;
  const failedStations = campaign.failedCount;
  const progressTotalPages = Math.ceil(totalStations / progressLimit);

  const hasFilter =
    campaign.targetFilter != null &&
    (campaign.targetFilter.siteId != null ||
      campaign.targetFilter.vendorId != null ||
      campaign.targetFilter.model != null);

  return (
    <div className="px-4 py-4 md:px-6 md:py-6 space-y-6">
      <div className="flex items-center gap-4">
        <BackButton to="/settings?tab=firmware" />
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{campaign.name}</h1>
          <CopyableId id={campaign.id} />
        </div>
        <Badge variant={STATUS_VARIANT[campaign.status] ?? 'outline'}>{campaign.status}</Badge>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('common.details')}</CardTitle>
          <div className="flex gap-2">
            {campaign.status === 'draft' && !editing && (
              <EditButton label={t('common.edit')} onClick={startEdit} />
            )}
            {campaign.status === 'draft' && (
              <Button
                className="gap-1.5"
                onClick={() => {
                  setStartOpen(true);
                }}
              >
                <Play className="h-4 w-4" />
                {t('firmwareCampaigns.start')}
              </Button>
            )}
            {campaign.status === 'active' && (
              <Button
                variant="outline"
                className="gap-1.5"
                onClick={() => {
                  setCancelOpen(true);
                }}
              >
                <XCircle className="h-4 w-4" />
                {t('common.cancel')}
              </Button>
            )}
            {campaign.status === 'draft' && (
              <RemoveButton
                label={t('common.delete')}
                onClick={() => {
                  setDeleteOpen(true);
                }}
              />
            )}
          </div>
        </CardHeader>
        <CardContent>
          {editing ? (
            <form
              className="grid gap-4"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                setHasSubmitted(true);
                if (Object.keys(validationErrors).length > 0) return;
                const body: {
                  name?: string;
                  firmwareUrl?: string;
                  version?: string;
                  targetFilter?: { siteId?: string; vendorId?: string; model?: string } | null;
                } = {
                  name: editName,
                  firmwareUrl: editFirmwareUrl,
                };
                if (editVersion !== '') body.version = editVersion;
                const filter: { siteId?: string; vendorId?: string; model?: string } = {};
                if (editFilterSiteId) filter.siteId = editFilterSiteId;
                if (editFilterVendorId) filter.vendorId = editFilterVendorId;
                if (editFilterModel) filter.model = editFilterModel;
                body.targetFilter = Object.keys(filter).length > 0 ? filter : null;
                updateMutation.mutate(body);
              }}
            >
              <div className="grid gap-2">
                <Label htmlFor="fcd-edit-name">{t('common.name')}</Label>
                <Input
                  id="fcd-edit-name"
                  value={editName}
                  onChange={(e) => {
                    setEditName(e.target.value);
                  }}
                  className={hasSubmitted && validationErrors.editName ? 'border-destructive' : ''}
                />
                {hasSubmitted && validationErrors.editName && (
                  <p className="text-sm text-destructive">{validationErrors.editName}</p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="fcd-edit-firmware-url">{t('firmwareCampaigns.firmwareUrl')}</Label>
                <Input
                  id="fcd-edit-firmware-url"
                  value={editFirmwareUrl}
                  onChange={(e) => {
                    setEditFirmwareUrl(e.target.value);
                  }}
                  className={
                    hasSubmitted && validationErrors.editFirmwareUrl ? 'border-destructive' : ''
                  }
                />
                {hasSubmitted && validationErrors.editFirmwareUrl && (
                  <p className="text-sm text-destructive">{validationErrors.editFirmwareUrl}</p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="fcd-edit-version">{t('firmwareCampaigns.version')}</Label>
                <Input
                  id="fcd-edit-version"
                  value={editVersion}
                  onChange={(e) => {
                    setEditVersion(e.target.value);
                  }}
                />
              </div>

              <div className="space-y-2 pt-2">
                <h3 className="text-sm font-medium">{t('firmwareCampaigns.targetFilter')}</h3>
                <p className="text-xs text-muted-foreground">
                  {t('firmwareCampaigns.targetFilterHelp')}
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="edit-fw-filter-site">{t('firmwareCampaigns.site')}</Label>
                  <Select
                    id="edit-fw-filter-site"
                    value={editFilterSiteId}
                    onChange={(e) => {
                      setEditFilterSiteId(e.target.value);
                    }}
                  >
                    <option value="">{t('firmwareCampaigns.allSites')}</option>
                    {filterOptions?.sites.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="edit-fw-filter-vendor">{t('firmwareCampaigns.vendor')}</Label>
                  <Select
                    id="edit-fw-filter-vendor"
                    value={editFilterVendorId}
                    onChange={(e) => {
                      setEditFilterVendorId(e.target.value);
                    }}
                  >
                    <option value="">{t('firmwareCampaigns.allVendors')}</option>
                    {filterOptions?.vendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="edit-fw-filter-model">{t('firmwareCampaigns.model')}</Label>
                  <Select
                    id="edit-fw-filter-model"
                    value={editFilterModel}
                    onChange={(e) => {
                      setEditFilterModel(e.target.value);
                    }}
                  >
                    <option value="">{t('firmwareCampaigns.allModels')}</option>
                    {filterOptions?.models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>

              <div className="flex gap-2">
                <SaveButton isPending={updateMutation.isPending} />
                <CancelButton
                  onClick={() => {
                    setEditing(false);
                    setHasSubmitted(false);
                  }}
                />
              </div>
            </form>
          ) : (
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-muted-foreground">{t('firmwareCampaigns.firmwareUrl')}</dt>
                <dd className="font-medium break-all">{campaign.firmwareUrl}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('firmwareCampaigns.version')}</dt>
                <dd className="font-medium">{campaign.version ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.created')}</dt>
                <dd className="font-medium">{formatDateTime(campaign.createdAt, timezone)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.lastUpdated')}</dt>
                <dd className="font-medium">{formatDateTime(campaign.updatedAt, timezone)}</dd>
              </div>
              {hasFilter && (
                <>
                  {campaign.targetFilter?.siteId != null && (
                    <div>
                      <dt className="text-muted-foreground">{t('firmwareCampaigns.site')}</dt>
                      <dd className="font-medium">
                        {resolveSiteName(campaign.targetFilter.siteId)}
                      </dd>
                    </div>
                  )}
                  {campaign.targetFilter?.vendorId != null && (
                    <div>
                      <dt className="text-muted-foreground">{t('firmwareCampaigns.vendor')}</dt>
                      <dd className="font-medium">
                        {resolveVendorName(campaign.targetFilter.vendorId)}
                      </dd>
                    </div>
                  )}
                  {campaign.targetFilter?.model != null && (
                    <div>
                      <dt className="text-muted-foreground">{t('firmwareCampaigns.model')}</dt>
                      <dd className="font-medium">{campaign.targetFilter.model}</dd>
                    </div>
                  )}
                </>
              )}
            </dl>
          )}
        </CardContent>
      </Card>

      {campaign.status !== 'draft' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('firmwareCampaigns.progress')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-6 mb-4 text-sm">
              <div>
                <span className="text-muted-foreground">
                  {t('firmwareCampaigns.totalStations')}:{' '}
                </span>
                <span className="font-medium">{totalStations}</span>
              </div>
              <div>
                <span className="text-muted-foreground">
                  {t('firmwareCampaigns.completedStations')}:{' '}
                </span>
                <span className="font-medium">{completedStations}</span>
              </div>
              {failedStations > 0 && (
                <div>
                  <span className="text-muted-foreground">
                    {t('firmwareCampaigns.failedStations')}:{' '}
                  </span>
                  <span className="font-medium text-destructive">{failedStations}</span>
                </div>
              )}
            </div>

            {totalStations > 0 && (
              <div className="w-full bg-muted rounded-full h-2 mb-4">
                <div
                  className="bg-primary rounded-full h-2 transition-all"
                  style={{ width: `${String((completedStations / totalStations) * 100)}%` }}
                />
              </div>
            )}

            {stations.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('firmwareCampaigns.noStationsTargeted')}
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('nav.stations')}</TableHead>
                        <TableHead>{t('common.status')}</TableHead>
                        <TableHead>{t('firmwareCampaigns.error')}</TableHead>
                        <TableHead>{t('common.lastUpdated')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {stations.map((station) => (
                        <TableRow key={station.id}>
                          <TableCell className="font-medium">{station.stationName}</TableCell>
                          <TableCell>
                            <Badge variant={STATION_STATUS_VARIANT[station.status] ?? 'outline'}>
                              {station.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs">{station.errorInfo ?? '--'}</TableCell>
                          <TableCell className="text-xs">
                            {formatDateTime(station.updatedAt, timezone)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <Pagination
                  page={progressPage}
                  totalPages={progressTotalPages}
                  onPageChange={setProgressPage}
                />
              </>
            )}
          </CardContent>
        </Card>
      )}

      <MatchingStationsCard
        endpoint={`/v1/firmware-campaigns/${id ?? ''}/matching-stations`}
        queryKey={['firmware-campaigns', id ?? '', 'matching-stations']}
        subtitle={t('firmwareCampaigns.subtitle')}
        showFirmwareVersion
      />

      <ConfirmDialog
        open={startOpen}
        onOpenChange={setStartOpen}
        title={t('firmwareCampaigns.confirmStart')}
        description={t('firmwareCampaigns.confirmStartDescription')}
        confirmLabel={t('firmwareCampaigns.start')}
        isPending={startMutation.isPending}
        onConfirm={() => {
          startMutation.mutate();
        }}
      />

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t('firmwareCampaigns.confirmCancel')}
        description={t('firmwareCampaigns.confirmCancelDescription')}
        confirmLabel={t('common.cancel')}
        variant="destructive"
        isPending={cancelMutation.isPending}
        onConfirm={() => {
          cancelMutation.mutate();
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('firmwareCampaigns.confirmDelete')}
        description={t('firmwareCampaigns.confirmDeleteDescription')}
        confirmLabel={t('common.delete')}
        variant="destructive"
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          deleteMutation.mutate();
        }}
      />
    </div>
  );
}
