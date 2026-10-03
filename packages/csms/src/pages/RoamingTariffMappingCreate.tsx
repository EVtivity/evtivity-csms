// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { Card, CardContent } from '@/components/ui/card';
import {
  EMPTY_TARIFF_MAPPING,
  TariffMappingFields,
  tariffMappingBody,
  tariffMappingErrors,
} from '@/components/roaming/TariffMappingFields';
import type {
  TariffMappingBody,
  TariffMappingValues,
} from '@/components/roaming/TariffMappingFields';
import { api, getApiErrorFieldDetails } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

interface TariffMapping {
  id: number;
}

export function RoamingTariffMappingCreate(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [values, setValues] = useState<TariffMappingValues>(EMPTY_TARIFF_MAPPING);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const createMutation = useMutation({
    mutationFn: (body: TariffMappingBody) =>
      api.post<TariffMapping>('/v1/ocpi/tariff-mappings', body),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['ocpi-tariff-mappings'] });
      void navigate(`/roaming/tariffs/${String(created.id)}`);
    },
  });

  const errors = tariffMappingErrors(values, createMutation.error, t);
  // Field errors from the API show next to their field.
  const fieldError = Object.keys(getApiErrorFieldDetails(createMutation.error)).length > 0;

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(tariffMappingErrors(values, null, t)).length > 0) return;
    createMutation.mutate(tariffMappingBody(values));
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to="/roaming/tariffs" />
        <h1 className="text-2xl font-bold md:text-3xl">{t('roaming.tariffs.createMapping')}</h1>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <TariffMappingFields
              idPrefix="mapping"
              values={values}
              onChange={(next) => {
                createMutation.reset();
                setValues(next);
              }}
              errors={hasSubmitted ? errors : {}}
            />
            {createMutation.isError && !fieldError && (
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
