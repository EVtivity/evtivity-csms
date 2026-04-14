// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

interface TariffMapping {
  id: number;
  tariffId: string;
  partnerId: string | null;
  ocpiTariffId: string;
  currency: string;
  createdAt: string;
  updatedAt: string;
  tariffName: string | null;
  partnerName: string | null;
}

export function RoamingTariffMappingDetail(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const [editing, setEditing] = useState(false);
  const [ocpiTariffId, setOcpiTariffId] = useState('');
  const [currency, setCurrency] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data: mapping, isLoading } = useQuery({
    queryKey: ['ocpi-tariff-mappings', id],
    queryFn: () => api.get<TariffMapping>(`/v1/ocpi/tariff-mappings/${id ?? ''}`),
    enabled: id != null,
  });

  const updateMutation = useMutation({
    mutationFn: (body: { ocpiTariffId?: string; currency?: string }) =>
      api.patch<TariffMapping>(`/v1/ocpi/tariff-mappings/${id ?? ''}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ocpi-tariff-mappings', id] });
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
    setOcpiTariffId(mapping.ocpiTariffId);
    setCurrency(mapping.currency);
    setHasSubmitted(false);
    setEditing(true);
  }

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!ocpiTariffId.trim()) errors.ocpiTariffId = t('validation.required');
    return errors;
  }

  const validationErrors = getValidationErrors();

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(validationErrors).length > 0) return;
    updateMutation.mutate({
      ocpiTariffId,
      currency,
    });
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  }

  if (mapping == null) {
    return <p className="text-sm text-destructive">{t('roaming.tariffs.mappingDetails')}</p>;
  }

  const displayName = mapping.tariffName ?? mapping.ocpiTariffId;

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
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('common.details')}</CardTitle>
          <div className="flex gap-2">
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
              <div className="space-y-2">
                <Label htmlFor="edit-ocpi-tariff-id">{t('roaming.tariffs.ocpiTariffId')}</Label>
                <Input
                  id="edit-ocpi-tariff-id"
                  value={ocpiTariffId}
                  onChange={(e) => {
                    setOcpiTariffId(e.target.value);
                  }}
                  className={
                    hasSubmitted && validationErrors.ocpiTariffId ? 'border-destructive' : ''
                  }
                />
                {hasSubmitted && validationErrors.ocpiTariffId && (
                  <p className="text-sm text-destructive">{validationErrors.ocpiTariffId}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-currency">{t('roaming.tariffs.currency')}</Label>
                <Input
                  id="edit-currency"
                  value={currency}
                  onChange={(e) => {
                    setCurrency(e.target.value.toUpperCase().slice(0, 3));
                  }}
                  maxLength={3}
                />
              </div>
              {updateMutation.isError && (
                <p className="text-sm text-destructive">
                  {getErrorMessage(updateMutation.error, t)}
                </p>
              )}
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
                <dt className="text-muted-foreground">{t('roaming.tariffs.internalTariff')}</dt>
                <dd className="font-medium">{mapping.tariffName ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('roaming.tariffs.ocpiTariffId')}</dt>
                <dd className="font-medium">{mapping.ocpiTariffId}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('roaming.tariffs.currency')}</dt>
                <dd className="font-medium">{mapping.currency}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('roaming.tariffs.partner')}</dt>
                <dd className="font-medium">
                  {mapping.partnerName ?? t('roaming.tariffs.allPartners')}
                </dd>
              </div>
            </dl>
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
