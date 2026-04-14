// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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

interface DriverToken {
  id: string;
  driverId: string;
  idToken: string;
  tokenType: string;
  isActive: boolean;
  createdAt: string;
}

const TOKEN_TYPES = [
  'DirectPayment',
  'eMAID',
  'EVCCID',
  'ISO14443',
  'ISO15693',
  'KeyCode',
  'MacAddress',
  'VIN',
] as const;

export function DriverTokenCreate(): React.JSX.Element {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [idToken, setIdToken] = useState('');
  const [tokenType, setTokenType] = useState('ISO14443');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const createMutation = useMutation({
    mutationFn: (body: { idToken: string; tokenType: string }) =>
      api.post<DriverToken>(`/v1/drivers/${id ?? ''}/tokens`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['drivers', id, 'tokens'] });
      void navigate(`/drivers/${id ?? ''}?tab=tokens`);
    },
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!idToken.trim()) errors.idToken = t('validation.required');
    if (!tokenType.trim()) errors.tokenType = t('validation.required');
    return errors;
  }

  const errors = getValidationErrors();

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    createMutation.mutate({ idToken, tokenType });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to={`/drivers/${id ?? ''}?tab=tokens`} />
        <h1 className="text-2xl md:text-3xl font-bold">{t('tokens.createToken')}</h1>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="idToken">{t('tokens.idToken')}</Label>
              <Input
                id="idToken"
                value={idToken}
                onChange={(e) => {
                  setIdToken(e.target.value);
                }}
                className={hasSubmitted && errors.idToken ? 'border-destructive' : ''}
              />
              {hasSubmitted && errors.idToken && (
                <p className="text-sm text-destructive">{errors.idToken}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="tokenType">{t('tokens.tokenType')}</Label>
              <Select
                id="tokenType"
                value={tokenType}
                onChange={(e) => {
                  setTokenType(e.target.value);
                }}
              >
                {TOKEN_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </Select>
            </div>
            {createMutation.isError && (
              <p className="text-sm text-destructive">{getErrorMessage(createMutation.error, t)}</p>
            )}
            <div className="flex justify-end gap-2">
              <CancelButton
                onClick={() => {
                  void navigate(`/drivers/${id ?? ''}?tab=tokens`);
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
