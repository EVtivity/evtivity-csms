// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { BackButton } from '@/components/back-button';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { RemoveIconButton } from '@/components/remove-icon-button';
import { TargetFilterFields, type TargetFilterValue } from '@/components/TargetFilterFields';
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

type OcppVersion = '2.1' | '1.6';

export function ConfigTemplateCreate(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [ocppVersion, setOcppVersion] = useState<OcppVersion>('2.1');
  const [variables, setVariables] = useState<TemplateVariable[]>([]);
  const [filter, setFilter] = useState<TargetFilterValue>({});
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const createMutation = useMutation({
    mutationFn: (body: {
      name: string;
      description?: string;
      ocppVersion: OcppVersion;
      variables: TemplateVariable[];
      targetFilter?: TargetFilterValue;
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
      targetFilter?: TargetFilterValue;
    } = {
      name,
      ocppVersion,
      variables:
        ocppVersion === '1.6'
          ? variables.filter((v) => v.variable)
          : variables.filter((v) => v.component && v.variable),
    };
    if (description.trim() !== '') body.description = description;
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
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={addVariable}
                >
                  <Plus className="h-4 w-4" />
                  {t('configTemplates.addVariable')}
                </Button>
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
                    <div className="grid grid-cols-2 gap-2 [&>*:last-child:nth-child(odd)]:col-span-2 sm:flex">
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
                    <Input
                      list={`create-comp-suggestions-${String(i)}`}
                      aria-label={t('configTemplates.selectComponent')}
                      placeholder={t('configTemplates.selectComponent')}
                      value={v.component}
                      onChange={(e) => {
                        updateVariable(i, 'component', e.target.value);
                      }}
                    />
                    <datalist id={`create-comp-suggestions-${String(i)}`}>
                      {componentNames.map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                    <Input
                      list={`create-var-suggestions-${String(i)}`}
                      aria-label={t('configTemplates.selectVariable')}
                      placeholder={t('configTemplates.selectVariable')}
                      value={v.variable}
                      onChange={(e) => {
                        updateVariable(i, 'variable', e.target.value);
                      }}
                    />
                    <datalist id={`create-var-suggestions-${String(i)}`}>
                      {(OCPP_21_VARIABLES[v.component] ?? []).map((varName) => (
                        <option key={varName} value={varName} />
                      ))}
                    </datalist>
                    <div className="grid grid-cols-2 gap-2 [&>*:last-child:nth-child(odd)]:col-span-2 sm:flex">
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

            <TargetFilterFields
              endpoint="/v1/config-templates/filter-options"
              queryKeyPrefix={['config-template-filter-options']}
              value={filter}
              onChange={setFilter}
              idPrefix="ct-create-filter"
            />

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
