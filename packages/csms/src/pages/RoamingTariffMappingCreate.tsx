// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

interface Tariff {
  id: string;
  name: string;
  currency: string;
}

interface TariffMapping {
  id: number;
  tariffId: string;
  ocpiTariffId: string;
  currency: string;
}

export function RoamingTariffMappingCreate(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [selectedTariffId, setSelectedTariffId] = useState('');
  const [ocpiTariffId, setOcpiTariffId] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const { data: tariffList } = useQuery({
    queryKey: ['tariffs-list'],
    queryFn: () => api.get<{ data: Tariff[]; total: number }>('/v1/pricing/tariffs'),
  });

  const createMutation = useMutation({
    mutationFn: (data: {
      tariffId: string;
      ocpiTariffId: string;
      currency: string;
      ocpiTariffData: Record<string, unknown>;
    }) => api.post<TariffMapping>('/v1/ocpi/tariff-mappings', data),
    onSuccess: (created) => {
      void navigate(`/roaming/tariffs/${String(created.id)}`);
    },
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!selectedTariffId) errors.selectedTariffId = t('validation.required');
    if (!ocpiTariffId.trim()) errors.ocpiTariffId = t('validation.required');
    return errors;
  }

  const errors = getValidationErrors();

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    createMutation.mutate({
      tariffId: selectedTariffId,
      ocpiTariffId,
      currency,
      ocpiTariffData: {},
    });
  }

  const availableTariffs = tariffList?.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to="/roaming/tariffs" />
        <h1 className="text-2xl font-bold md:text-3xl">{t('roaming.tariffs.createMapping')}</h1>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="mapping-tariff">{t('roaming.tariffs.internalTariff')}</Label>
              <Select
                id="mapping-tariff"
                value={selectedTariffId}
                onChange={(e) => {
                  setSelectedTariffId(e.target.value);
                }}
                className={hasSubmitted && errors.selectedTariffId ? 'border-destructive' : ''}
              >
                <option value="">{t('roaming.tariffs.selectTariff')}</option>
                {availableTariffs.map((tariff) => (
                  <option key={tariff.id} value={tariff.id}>
                    {tariff.name}
                  </option>
                ))}
              </Select>
              {hasSubmitted && errors.selectedTariffId && (
                <p className="text-xs text-destructive">{errors.selectedTariffId}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="mapping-ocpi-id">{t('roaming.tariffs.ocpiTariffId')}</Label>
              <Input
                id="mapping-ocpi-id"
                value={ocpiTariffId}
                onChange={(e) => {
                  setOcpiTariffId(e.target.value);
                }}
                placeholder="TARIFF-001"
                className={hasSubmitted && errors.ocpiTariffId ? 'border-destructive' : ''}
              />
              {hasSubmitted && errors.ocpiTariffId && (
                <p className="text-xs text-destructive">{errors.ocpiTariffId}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="mapping-currency">{t('roaming.tariffs.currency')}</Label>
              <Input
                id="mapping-currency"
                value={currency}
                onChange={(e) => {
                  setCurrency(e.target.value.toUpperCase().slice(0, 3));
                }}
                placeholder="USD"
                maxLength={3}
              />
            </div>
            {createMutation.isError && (
              <p className="text-sm text-destructive">{getErrorMessage(createMutation.error, t)}</p>
            )}
            <div className="flex justify-end gap-2">
              <CancelButton
                onClick={() => {
                  void navigate('/roaming/tariffs');
                }}
              />
              <CreateButton
                label={t('common.create')}
                type="submit"
                disabled={createMutation.isPending}
              />
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
