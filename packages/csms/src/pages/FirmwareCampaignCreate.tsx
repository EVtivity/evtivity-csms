// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { TargetFilterFields, type TargetFilterValue } from '@/components/TargetFilterFields';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';

interface Campaign {
  id: string;
  name: string;
  firmwareUrl: string;
  version: string | null;
  status: string;
  createdAt: string;
}

export function FirmwareCampaignCreate(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [firmwareUrl, setFirmwareUrl] = useState('');
  const [version, setVersion] = useState('');
  const [filter, setFilter] = useState<TargetFilterValue>({});
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const createMutation = useMutation({
    mutationFn: (body: {
      name: string;
      firmwareUrl: string;
      version?: string;
      targetFilter?: TargetFilterValue;
    }) => api.post<Campaign>('/v1/firmware-campaigns', body),
    onSuccess: (created) => {
      void navigate(`/firmware-campaigns/${created.id}`);
    },
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = t('validation.required');
    if (!firmwareUrl.trim()) {
      errors.firmwareUrl = t('validation.required');
    } else {
      try {
        new URL(firmwareUrl);
      } catch {
        errors.firmwareUrl = t('validation.invalidUrl');
      }
    }
    return errors;
  }

  const errors = getValidationErrors();

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const body: {
      name: string;
      firmwareUrl: string;
      version?: string;
      targetFilter?: TargetFilterValue;
    } = { name, firmwareUrl };
    if (version.trim() !== '') body.version = version;
    if (Object.keys(filter).length > 0) body.targetFilter = filter;
    createMutation.mutate(body);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to="/settings?tab=firmware" />
        <h1 className="text-2xl md:text-3xl font-bold">{t('firmwareCampaigns.createTitle')}</h1>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="campaign-name">{t('common.name')}</Label>
              <Input
                id="campaign-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
                className={hasSubmitted && errors.name ? 'border-destructive' : ''}
              />
              {hasSubmitted && errors.name && (
                <p className="text-sm text-destructive">{errors.name}</p>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-10 gap-4">
              <div className="space-y-2 md:col-span-7">
                <Label htmlFor="campaign-firmware-url">{t('firmwareCampaigns.firmwareUrl')}</Label>
                <Input
                  id="campaign-firmware-url"
                  placeholder="https://example.com/firmware-v2.bin"
                  value={firmwareUrl}
                  onChange={(e) => {
                    setFirmwareUrl(e.target.value);
                  }}
                  className={hasSubmitted && errors.firmwareUrl ? 'border-destructive' : ''}
                />
                {hasSubmitted && errors.firmwareUrl && (
                  <p className="text-sm text-destructive">{errors.firmwareUrl}</p>
                )}
              </div>
              <div className="space-y-2 md:col-span-3">
                <Label htmlFor="campaign-version">{t('firmwareCampaigns.version')}</Label>
                <Input
                  id="campaign-version"
                  value={version}
                  onChange={(e) => {
                    setVersion(e.target.value);
                  }}
                />
              </div>
            </div>

            <TargetFilterFields
              endpoint="/v1/firmware-campaigns/filter-options"
              queryKeyPrefix={['firmware-campaign-filter-options']}
              value={filter}
              onChange={setFilter}
              idPrefix="fw-create-filter"
            />

            <div className="flex justify-end gap-2">
              <CancelButton
                onClick={() => {
                  void navigate('/settings?tab=firmware');
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
