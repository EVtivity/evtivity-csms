// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react';
import { CancelButton } from '@/components/cancel-button';
import { EditButton } from '@/components/edit-button';
import { RemoveButton } from '@/components/remove-button';
import { SaveButton } from '@/components/save-button';
import { StartButton } from '@/components/start-button';
import { TargetFilterFields, type TargetFilterValue } from '@/components/TargetFilterFields';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

export interface CampaignDetail {
  id: string;
  name: string;
  firmwareUrl: string;
  version: string | null;
  status: string;
  targetFilter: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
}

interface FilterOptions {
  sites: { id: string; name: string }[];
  vendors: { id: string; name: string }[];
  models: string[];
  stations: { id: string; stationId: string }[];
}

interface Props {
  campaign: CampaignDetail;
}

export function FirmwareCampaignDetailsTab({ campaign }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const id = campaign.id;

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editFirmwareUrl, setEditFirmwareUrl] = useState('');
  const [editVersion, setEditVersion] = useState('');
  const [editFilter, setEditFilter] = useState<TargetFilterValue>({});
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Lookup options for resolving filter ids -> display names in the read view.
  const { data: filterOptions } = useQuery({
    queryKey: ['firmware-campaign-filter-options'],
    queryFn: () => api.get<FilterOptions>('/v1/firmware-campaigns/filter-options'),
  });

  const updateMutation = useMutation({
    mutationFn: (body: {
      name?: string;
      firmwareUrl?: string;
      version?: string;
      targetFilter?: TargetFilterValue | null;
    }) => api.patch(`/v1/firmware-campaigns/${id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['firmware-campaigns', id] });
      setEditing(false);
    },
  });

  const startMutation = useMutation({
    mutationFn: () => api.post(`/v1/firmware-campaigns/${id}/start`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['firmware-campaigns', id] });
      setStartOpen(false);
      void navigate(`/firmware-campaigns/${id}/progress`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/v1/firmware-campaigns/${id}`),
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
    setEditName(campaign.name);
    setEditFirmwareUrl(campaign.firmwareUrl);
    setEditVersion(campaign.version ?? '');
    setEditFilter({
      ...(campaign.targetFilter?.siteId != null ? { siteId: campaign.targetFilter.siteId } : {}),
      ...(campaign.targetFilter?.vendorId != null
        ? { vendorId: campaign.targetFilter.vendorId }
        : {}),
      ...(campaign.targetFilter?.model != null ? { model: campaign.targetFilter.model } : {}),
      ...(campaign.targetFilter?.stationId != null
        ? { stationId: campaign.targetFilter.stationId }
        : {}),
    });
    setHasSubmitted(false);
    setEditing(true);
  }

  function resolveSiteName(siteId: string): string {
    return filterOptions?.sites.find((s) => s.id === siteId)?.name ?? siteId;
  }

  function resolveVendorName(vendorId: string): string {
    return filterOptions?.vendors.find((v) => v.id === vendorId)?.name ?? vendorId;
  }

  function resolveStationName(stationId: string): string {
    return filterOptions?.stations.find((s) => s.id === stationId)?.stationId ?? stationId;
  }

  const hasFilter =
    campaign.targetFilter != null &&
    (campaign.targetFilter.siteId != null ||
      campaign.targetFilter.vendorId != null ||
      campaign.targetFilter.model != null ||
      campaign.targetFilter.stationId != null);

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>{t('common.details')}</CardTitle>
          <div className="grid grid-cols-2 gap-2 [&>*:last-child:nth-child(odd)]:col-span-2 sm:flex">
            {campaign.status === 'draft' && !editing && (
              <EditButton label={t('common.edit')} onClick={startEdit} />
            )}
            {campaign.status === 'draft' && !editing && (
              <StartButton
                label={t('firmwareCampaigns.startCampaign')}
                onClick={() => {
                  setStartOpen(true);
                }}
              />
            )}
            {campaign.status === 'draft' && !editing && (
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
                  targetFilter?: TargetFilterValue | null;
                } = {
                  name: editName,
                  firmwareUrl: editFirmwareUrl,
                };
                if (editVersion !== '') body.version = editVersion;
                body.targetFilter = Object.keys(editFilter).length > 0 ? editFilter : null;
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
              <div className="grid grid-cols-1 md:grid-cols-10 gap-4">
                <div className="grid gap-2 md:col-span-7">
                  <Label htmlFor="fcd-edit-firmware-url">
                    {t('firmwareCampaigns.firmwareUrl')}
                  </Label>
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
                <div className="grid gap-2 md:col-span-3">
                  <Label htmlFor="fcd-edit-version">{t('firmwareCampaigns.version')}</Label>
                  <Input
                    id="fcd-edit-version"
                    value={editVersion}
                    onChange={(e) => {
                      setEditVersion(e.target.value);
                    }}
                  />
                </div>
              </div>

              <TargetFilterFields
                endpoint="/v1/firmware-campaigns/filter-options"
                queryKeyPrefix={['firmware-campaign-filter-options']}
                value={editFilter}
                onChange={setEditFilter}
                idPrefix="fw-edit-filter"
              />

              <div className="flex justify-end gap-2">
                <CancelButton
                  onClick={() => {
                    setEditing(false);
                    setHasSubmitted(false);
                  }}
                />
                <SaveButton isPending={updateMutation.isPending} />
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
                <dd className="font-medium">{campaign.version ?? 'n/a'}</dd>
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
                  {campaign.targetFilter?.stationId != null && (
                    <div>
                      <dt className="text-muted-foreground">{t('configTemplates.station')}</dt>
                      <dd className="font-medium">
                        {resolveStationName(campaign.targetFilter.stationId)}
                      </dd>
                    </div>
                  )}
                </>
              )}
            </dl>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={startOpen}
        onOpenChange={setStartOpen}
        title={t('firmwareCampaigns.confirmStart')}
        description={t('firmwareCampaigns.confirmStartDescription')}
        confirmLabel={t('firmwareCampaigns.startCampaign')}
        confirmIcon={<Play className="h-4 w-4" />}
        variant="default"
        isPending={startMutation.isPending}
        onConfirm={() => {
          startMutation.mutate();
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
    </>
  );
}
