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

interface Campaign {
  id: string;
  name: string;
  firmwareUrl: string;
  version: string | null;
  status: string;
  createdAt: string;
}

interface FilterOptions {
  sites: { id: string; name: string }[];
  vendors: { id: string; name: string }[];
  models: string[];
}

export function FirmwareCampaignCreate(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [firmwareUrl, setFirmwareUrl] = useState('');
  const [version, setVersion] = useState('');
  const [filterSiteId, setFilterSiteId] = useState('');
  const [filterVendorId, setFilterVendorId] = useState('');
  const [filterModel, setFilterModel] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const { data: filterOptions } = useQuery({
    queryKey: ['firmware-campaign-filter-options'],
    queryFn: () => api.get<FilterOptions>('/v1/firmware-campaigns/filter-options'),
  });

  const createMutation = useMutation({
    mutationFn: (body: {
      name: string;
      firmwareUrl: string;
      version?: string;
      targetFilter?: { siteId?: string; vendorId?: string; model?: string };
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
      targetFilter?: { siteId?: string; vendorId?: string; model?: string };
    } = { name, firmwareUrl };
    if (version.trim() !== '') body.version = version;
    const filter: { siteId?: string; vendorId?: string; model?: string } = {};
    if (filterSiteId) filter.siteId = filterSiteId;
    if (filterVendorId) filter.vendorId = filterVendorId;
    if (filterModel) filter.model = filterModel;
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
            <div className="space-y-2">
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
            <div className="space-y-2">
              <Label htmlFor="campaign-version">{t('firmwareCampaigns.version')}</Label>
              <Input
                id="campaign-version"
                value={version}
                onChange={(e) => {
                  setVersion(e.target.value);
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
              <div className="space-y-2">
                <Label htmlFor="filter-site">{t('firmwareCampaigns.site')}</Label>
                <Select
                  id="filter-site"
                  value={filterSiteId}
                  onChange={(e) => {
                    setFilterSiteId(e.target.value);
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
              <div className="space-y-2">
                <Label htmlFor="filter-vendor">{t('firmwareCampaigns.vendor')}</Label>
                <Select
                  id="filter-vendor"
                  value={filterVendorId}
                  onChange={(e) => {
                    setFilterVendorId(e.target.value);
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
              <div className="space-y-2">
                <Label htmlFor="filter-model">{t('firmwareCampaigns.model')}</Label>
                <Select
                  id="filter-model"
                  value={filterModel}
                  onChange={(e) => {
                    setFilterModel(e.target.value);
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
