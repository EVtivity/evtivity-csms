// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { BackButton } from '@/components/back-button';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { TargetFilterFields, type TargetFilterValue } from '@/components/TargetFilterFields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { api, getApiErrorFieldDetails } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { useHasAllSiteAccess } from '@/lib/auth';
import {
  TemplateVariableRows,
  duplicateVariableIndexes,
  isBootOwnedRefusal,
  templateVariablesForSave,
} from '@/components/config-template/TemplateVariableRows';
import type { TemplateVariable } from '@/components/config-template/TemplateVariableRows';

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
  const hasAllSiteAccess = useHasAllSiteAccess();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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
      void queryClient.invalidateQueries({ queryKey: ['config-templates'] });
      void navigate(`/station-configurations/${created.id}`);
    },
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = t('validation.required');
    // A template without a site or station targets every site.
    if (!hasAllSiteAccess && filter.siteId == null && filter.stationId == null) {
      errors.targetFilter = t('validation.selectRequired');
    }
    if (duplicateVariableIndexes(variables, ocppVersion).size > 0) {
      errors.variables = t('configTemplates.duplicateVariable');
    }
    return errors;
  }

  const errors = { ...getValidationErrors(), ...getApiErrorFieldDetails(createMutation.error) };

  function addVariable(): void {
    setVariables((prev) => [...prev, { component: '', variable: '', value: '' }]);
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
      variables: templateVariablesForSave(variables, ocppVersion),
    };
    if (description.trim() !== '') body.description = description;
    if (Object.keys(filter).length > 0) body.targetFilter = filter;
    createMutation.mutate(body);
  }

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
              <Label htmlFor="template-name" className="leading-6">
                {t('common.name')}
              </Label>
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
              <Label htmlFor="template-description" className="leading-6">
                {t('common.description')}
              </Label>
              <Input
                id="template-description"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                }}
              />
            </div>

            <div className="space-y-2">
              <Label className="leading-6">{t('configTemplates.ocppVersion')}</Label>
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
              <div className="flex items-center justify-between gap-2">
                <Label className="whitespace-nowrap">{t('configTemplates.variables')}</Label>
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
              <TemplateVariableRows
                idPrefix="create"
                ocppVersion={ocppVersion}
                variables={variables}
                onChange={setVariables}
                bootOwnedRefused={isBootOwnedRefusal(createMutation.error)}
                showDuplicates={hasSubmitted}
              />
            </div>

            <TargetFilterFields
              endpoint="/v1/config-templates/filter-options"
              queryKeyPrefix={['config-template-filter-options']}
              value={filter}
              onChange={setFilter}
              idPrefix="ct-create-filter"
              showDataPlan
            />
            {hasSubmitted && errors.targetFilter && (
              <p className="text-sm text-destructive">{errors.targetFilter}</p>
            )}

            {createMutation.isError && (
              <p className="text-sm text-destructive">{getErrorMessage(createMutation.error, t)}</p>
            )}

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
