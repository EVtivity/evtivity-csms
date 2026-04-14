// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { AddIconButton } from '@/components/add-icon-button';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { RemoveIconButton } from '@/components/remove-icon-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { OCPP_21_VARIABLES, OCPP_16_KEYS } from '@/lib/ocpp-variables';

interface TemplateVariable {
  component: string;
  variable: string;
  value: string;
}

interface ConfigTemplate {
  id: string;
  name: string;
  description: string | null;
  ocppVersion: string;
  variables: TemplateVariable[];
  targetFilter: Record<string, string> | null;
  createdAt: string;
}

interface FilterOptions {
  sites: { id: string; name: string }[];
  vendors: { id: string; name: string }[];
  models: string[];
}

type OcppVersion = '2.1' | '1.6';

export function ConfigTemplateCreate(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [ocppVersion, setOcppVersion] = useState<OcppVersion>('2.1');
  const [variables, setVariables] = useState<TemplateVariable[]>([]);
  const [filterSiteId, setFilterSiteId] = useState('');
  const [filterVendorId, setFilterVendorId] = useState('');
  const [filterModel, setFilterModel] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const { data: filterOptions } = useQuery({
    queryKey: ['config-template-filter-options'],
    queryFn: () => api.get<FilterOptions>('/v1/config-templates/filter-options'),
  });

  const createMutation = useMutation({
    mutationFn: (body: {
      name: string;
      description?: string;
      ocppVersion: OcppVersion;
      variables: TemplateVariable[];
      targetFilter?: { siteId?: string; vendorId?: string; model?: string };
    }) => api.post<ConfigTemplate>('/v1/config-templates', body),
    onSuccess: (created) => {
      void navigate(`/station-configurations/${created.id}`);
    },
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = t('validation.required');
    return errors;
  }

  const errors = getValidationErrors();

  function addVariable(): void {
    setVariables((prev) => [...prev, { component: '', variable: '', value: '' }]);
  }

  function updateVariable(index: number, field: keyof TemplateVariable, val: string): void {
    setVariables((prev) => {
      const next = [...prev];
      const existing = next[index];
      if (existing != null) {
        const updated = { ...existing, [field]: val };
        if (field === 'component') updated.variable = '';
        next[index] = updated;
      }
      return next;
    });
  }

  function removeVariable(index: number): void {
    setVariables((prev) => prev.filter((_, i) => i !== index));
  }

  function handleVersionChange(version: OcppVersion): void {
    if (version === ocppVersion) return;
    setOcppVersion(version);
    setVariables([]);
  }

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const body: {
      name: string;
      description?: string;
      ocppVersion: OcppVersion;
      variables: TemplateVariable[];
      targetFilter?: { siteId?: string; vendorId?: string; model?: string };
    } = {
      name,
      ocppVersion,
      variables:
        ocppVersion === '1.6'
          ? variables.filter((v) => v.variable)
          : variables.filter((v) => v.component && v.variable),
    };
    if (description.trim() !== '') body.description = description;
    const filter: { siteId?: string; vendorId?: string; model?: string } = {};
    if (filterSiteId) filter.siteId = filterSiteId;
    if (filterVendorId) filter.vendorId = filterVendorId;
    if (filterModel) filter.model = filterModel;
    if (Object.keys(filter).length > 0) body.targetFilter = filter;
    createMutation.mutate(body);
  }

  const componentNames = Object.keys(OCPP_21_VARIABLES).sort();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to="/settings?tab=configuration" />
        <h1 className="text-2xl font-bold md:text-3xl">{t('configTemplates.createTitle')}</h1>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="template-name">{t('common.name')}</Label>
              <Input
                id="template-name"
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
              <Label htmlFor="template-description">{t('common.description')}</Label>
              <Input
                id="template-description"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                }}
              />
            </div>

            <div className="space-y-2">
              <Label>{t('configTemplates.ocppVersion')}</Label>
              <div className="flex gap-1">
                <Button
                  type="button"
                  variant={ocppVersion === '2.1' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => {
                    handleVersionChange('2.1');
                  }}
                >
                  OCPP 2.1
                </Button>
                <Button
                  type="button"
                  variant={ocppVersion === '1.6' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => {
                    handleVersionChange('1.6');
                  }}
                >
                  OCPP 1.6
                </Button>
              </div>
              {variables.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('configTemplates.versionSwitchWarning')}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t('configTemplates.variables')}</Label>
                <AddIconButton title={t('common.add')} onClick={addVariable} size="sm" />
              </div>
              {variables.map((v, i) =>
                ocppVersion === '1.6' ? (
                  <div key={i} className="grid grid-cols-2 gap-2 items-end">
                    <Select
                      aria-label={t('configTemplates.selectKey')}
                      value={v.variable}
                      onChange={(e) => {
                        updateVariable(i, 'variable', e.target.value);
                      }}
                    >
                      <option value="">{t('configTemplates.selectKey')}</option>
                      {OCPP_16_KEYS.map((key) => (
                        <option key={key} value={key}>
                          {key}
                        </option>
                      ))}
                    </Select>
                    <div className="flex gap-2">
                      <Input
                        placeholder={t('common.value')}
                        value={v.value}
                        onChange={(e) => {
                          updateVariable(i, 'value', e.target.value);
                        }}
                      />
                      <RemoveIconButton
                        title={t('common.delete')}
                        size="sm"
                        onClick={() => {
                          removeVariable(i);
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <div key={i} className="grid grid-cols-3 gap-2 items-end">
                    <Select
                      aria-label={t('configTemplates.selectComponent')}
                      value={v.component}
                      onChange={(e) => {
                        updateVariable(i, 'component', e.target.value);
                      }}
                    >
                      <option value="">{t('configTemplates.selectComponent')}</option>
                      {componentNames.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </Select>
                    <Select
                      aria-label={t('configTemplates.selectVariable')}
                      value={v.variable}
                      onChange={(e) => {
                        updateVariable(i, 'variable', e.target.value);
                      }}
                    >
                      <option value="">{t('configTemplates.selectVariable')}</option>
                      {(OCPP_21_VARIABLES[v.component] ?? []).map((varName) => (
                        <option key={varName} value={varName}>
                          {varName}
                        </option>
                      ))}
                    </Select>
                    <div className="flex gap-2">
                      <Input
                        placeholder={t('common.value')}
                        value={v.value}
                        onChange={(e) => {
                          updateVariable(i, 'value', e.target.value);
                        }}
                      />
                      <RemoveIconButton
                        title={t('common.delete')}
                        size="sm"
                        onClick={() => {
                          removeVariable(i);
                        }}
                      />
                    </div>
                  </div>
                ),
              )}
            </div>

            <div className="space-y-2 pt-2">
              <h3 className="text-sm font-medium">{t('configTemplates.targetFilter')}</h3>
              <p className="text-xs text-muted-foreground">
                {t('configTemplates.targetFilterHelp')}
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="filter-site">{t('configTemplates.site')}</Label>
                <Select
                  id="filter-site"
                  value={filterSiteId}
                  onChange={(e) => {
                    setFilterSiteId(e.target.value);
                  }}
                >
                  <option value="">{t('configTemplates.allSites')}</option>
                  {filterOptions?.sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="filter-vendor">{t('configTemplates.vendor')}</Label>
                <Select
                  id="filter-vendor"
                  value={filterVendorId}
                  onChange={(e) => {
                    setFilterVendorId(e.target.value);
                  }}
                >
                  <option value="">{t('configTemplates.allVendors')}</option>
                  {filterOptions?.vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="filter-model">{t('configTemplates.model')}</Label>
                <Select
                  id="filter-model"
                  value={filterModel}
                  onChange={(e) => {
                    setFilterModel(e.target.value);
                  }}
                >
                  <option value="">{t('configTemplates.allModels')}</option>
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
                  void navigate('/settings?tab=configuration');
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
