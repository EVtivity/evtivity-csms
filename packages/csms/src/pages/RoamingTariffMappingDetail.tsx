// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { Trash2 } from 'lucide-react';
import { EditButton } from '@/components/edit-button';
import { RemoveButton } from '@/components/remove-button';
import { CopyableId } from '@/components/copyable-id';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  TariffMappingFields,
  tariffMappingBody,
  tariffMappingErrors,
  tariffMappingValues,
  EMPTY_TARIFF_MAPPING,
} from '@/components/roaming/TariffMappingFields';
import type {
  TariffMappingBody,
  TariffMappingValues,
} from '@/components/roaming/TariffMappingFields';
import { api, getApiErrorFieldDetails } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { LoadingLogo } from '@/components/loading-logo';

interface TariffMapping {
  id: number;
  tariffId: string | null;
  pricingGroupId: string | null;
  partnerId: string | null;
  ocpiTariffId: string;
  createdAt: string;
  updatedAt: string;
  tariffName: string | null;
  pricingGroupName: string | null;
  partnerName: string | null;
}

export function RoamingTariffMappingDetail(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<TariffMappingValues>(EMPTY_TARIFF_MAPPING);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data: mapping, isLoading } = useQuery({
    queryKey: ['ocpi-tariff-mappings', id],
    queryFn: () => api.get<TariffMapping>(`/v1/ocpi/tariff-mappings/${id ?? ''}`),
    enabled: id != null,
  });

  const updateMutation = useMutation({
    mutationFn: (body: TariffMappingBody) =>
      api.patch<TariffMapping>(`/v1/ocpi/tariff-mappings/${id ?? ''}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ocpi-tariff-mappings'] });
      setEditing(false);
      setHasSubmitted(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete<undefined>(`/v1/ocpi/tariff-mappings/${id ?? ''}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ocpi-tariff-mappings'] });
      void navigate('/roaming/tariffs');
    },
  });

  function startEdit(): void {
    if (mapping == null) return;
    updateMutation.reset();
    setValues(tariffMappingValues(mapping));
    setHasSubmitted(false);
    setEditing(true);
  }

  const validationErrors = tariffMappingErrors(values, updateMutation.error, t);
  // Field errors from the API show next to their field.
  const fieldError = Object.keys(getApiErrorFieldDetails(updateMutation.error)).length > 0;

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(tariffMappingErrors(values, null, t)).length > 0) return;
    updateMutation.mutate(tariffMappingBody(values));
  }

  if (isLoading) {
    return <LoadingLogo />;
  }

  if (mapping == null) {
    return <p className="text-sm text-destructive">{t('roaming.tariffs.mappingDetails')}</p>;
  }

  const displayName = mapping.ocpiTariffId;
  const sourceName = mapping.pricingGroupName ?? mapping.tariffName ?? '-';

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <BackButton to="/roaming/tariffs" />
        <div>
          <h1 className="text-2xl font-bold md:text-3xl">{displayName}</h1>
          <CopyableId id={String(mapping.id)} />
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>{t('common.details')}</CardTitle>
          <div className="grid grid-cols-2 gap-2 [&>*:last-child:nth-child(odd)]:col-span-2 sm:flex">
            {!editing && <EditButton label={t('common.edit')} onClick={startEdit} />}
            <RemoveButton
              label={t('common.delete')}
              onClick={() => {
                setDeleteOpen(true);
              }}
            />
          </div>
        </CardHeader>
        <CardContent>
          {editing ? (
            <form onSubmit={handleSave} noValidate className="space-y-4">
              <TariffMappingFields
                idPrefix="edit-mapping"
                values={values}
                onChange={(next) => {
                  updateMutation.reset();
                  setValues(next);
                }}
                errors={hasSubmitted ? validationErrors : {}}
              />
              {updateMutation.isError && !fieldError && (
                <p className="text-sm text-destructive">
                  {getErrorMessage(updateMutation.error, t)}
                </p>
              )}
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
            <div className="space-y-4">
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">{t('roaming.tariffs.publishedFrom')}</dt>
                  <dd className="font-medium">
                    {mapping.pricingGroupId != null
                      ? t('roaming.tariffs.sourcePricingGroup')
                      : t('roaming.tariffs.sourceTariff')}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    {mapping.pricingGroupId != null
                      ? t('roaming.tariffs.pricingGroup')
                      : t('roaming.tariffs.internalTariff')}
                  </dt>
                  <dd className="font-medium">{sourceName}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('roaming.tariffs.ocpiTariffId')}</dt>
                  <dd className="font-medium">{mapping.ocpiTariffId}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('roaming.tariffs.partner')}</dt>
                  <dd className="font-medium">
                    {mapping.partnerName ?? t('roaming.tariffs.allPartners')}
                  </dd>
                </div>
              </dl>
              <p className="text-xs text-muted-foreground">{t('roaming.tariffs.generatedHint')}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('common.delete')}
        description={t('roaming.tariffs.confirmDeleteMapping')}
        confirmLabel={t('common.delete')}
        confirmIcon={<Trash2 className="h-4 w-4" />}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          deleteMutation.mutate();
        }}
      />
    </div>
  );
}
