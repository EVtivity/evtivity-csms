// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Copy, Plus, Upload } from 'lucide-react';
import { CancelButton } from '@/components/cancel-button';
import { EditButton } from '@/components/edit-button';
import { PushButton } from '@/components/push-button';
import { RemoveButton } from '@/components/remove-button';
import { SaveButton } from '@/components/save-button';
import { TargetFilterFields, type TargetFilterValue } from '@/components/TargetFilterFields';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { isDataPlan } from '@evtivity/lib/station-data-plan';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { useHasAllSiteAccess } from '@/lib/auth';
import {
  TemplateVariableRows,
  duplicateVariableIndexes,
  isBootOwnedRefusal,
  templateVariablesForSave,
} from '@/components/config-template/TemplateVariableRows';
import type { TemplateVariable } from '@/components/config-template/TemplateVariableRows';

export interface TemplateDetail {
  id: string;
  name: string;
  description: string | null;
  ocppVersion: string;
  variables: TemplateVariable[];
  targetFilter: Record<string, string> | null;
  stationId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FilterOptions {
  sites: { id: string; name: string }[];
  vendors: { id: string; name: string }[];
  models: string[];
  stations: { id: string; stationId: string }[];
}

type OcppVersion = '2.1' | '1.6';

interface Props {
  template: TemplateDetail;
}

export function ConfigTemplateDetailsTab({ template }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const hasAllSiteAccess = useHasAllSiteAccess();
  const timezone = useUserTimezone();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const id = template.id;

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editOcppVersion, setEditOcppVersion] = useState<OcppVersion>('2.1');
  const [editVariables, setEditVariables] = useState<TemplateVariable[]>([]);
  const [editFilter, setEditFilter] = useState<TargetFilterValue>({});
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);

  // Look up the filter options once (no cascading) so the read-only view can
  // render display names for the saved targetFilter ids.
  const { data: filterOptions } = useQuery({
    queryKey: ['config-template-filter-options'],
    queryFn: () => api.get<FilterOptions>('/v1/config-templates/filter-options'),
  });

  // Count online matching stations to gate the Push Config button. Push only
  // succeeds against online stations, so an empty online set should disable
  // the action up front instead of letting the operator fire a no-op push.
  const { data: matchingOnline } = useQuery({
    queryKey: ['config-templates', id, 'matching-stations', 'online-count'],
    queryFn: () =>
      api.get<{ total: number }>(
        `/v1/config-templates/${id}/matching-stations?status=online&page=1&limit=1`,
      ),
  });

  const updateMutation = useMutation({
    mutationFn: (body: {
      name?: string;
      description?: string;
      ocppVersion?: OcppVersion;
      variables?: TemplateVariable[];
      targetFilter?: TargetFilterValue | null;
    }) => api.patch(`/v1/config-templates/${id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['config-templates', id] });
      void queryClient.invalidateQueries({
        queryKey: ['config-templates', id, 'matching-stations'],
      });
      setEditing(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/v1/config-templates/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['config-templates'] });
      void navigate('/settings?tab=configuration');
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: () => api.post<TemplateDetail>(`/v1/config-templates/${id}/duplicate`, {}),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['config-templates'] });
      void navigate(`/station-configurations/${data.id}`);
    },
  });

  const pushMutation = useMutation({
    mutationFn: () =>
      api.post<{ success: boolean; pushId: string }>(`/v1/config-templates/${id}/push`, {}),
    onSuccess: (data) => {
      setPushOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['config-templates', id, 'pushes'] });
      if (data.pushId) {
        void navigate(`/station-configuration-pushes/${data.pushId}`);
      }
    },
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!editName.trim()) errors.editName = t('validation.required');
    if (duplicateVariableIndexes(editVariables, editOcppVersion).size > 0) {
      errors.variables = t('configTemplates.duplicateVariable');
    }
    return errors;
  }

  const validationErrors = getValidationErrors();

  function startEdit(): void {
    setEditName(template.name);
    setEditDescription(template.description ?? '');
    setEditOcppVersion(template.ocppVersion as OcppVersion);
    setEditVariables([...template.variables]);
    setEditFilter({
      ...(template.targetFilter?.siteId != null ? { siteId: template.targetFilter.siteId } : {}),
      ...(template.targetFilter?.vendorId != null
        ? { vendorId: template.targetFilter.vendorId }
        : {}),
      ...(template.targetFilter?.model != null ? { model: template.targetFilter.model } : {}),
      ...(template.targetFilter?.stationId != null
        ? { stationId: template.targetFilter.stationId }
        : {}),
      ...(isDataPlan(template.targetFilter?.dataPlan)
        ? { dataPlan: template.targetFilter.dataPlan }
        : {}),
    });
    setHasSubmitted(false);
    updateMutation.reset();
    setEditing(true);
  }

  function addVariable(): void {
    setEditVariables((prev) => [...prev, { component: '', variable: '', value: '' }]);
  }

  function handleEditVersionChange(version: OcppVersion): void {
    if (version === editOcppVersion) return;
    setEditOcppVersion(version);
    setEditVariables([]);
  }

  function resolveSiteName(siteId: string): string {
    return filterOptions?.sites.find((s) => s.id === siteId)?.name ?? siteId;
  }

  function resolveVendorName(vendorId: string): string {
    return filterOptions?.vendors.find((v) => v.id === vendorId)?.name ?? vendorId;
  }

  function resolveStationName(stationId: string): string {
    return filterOptions?.stations.find((s) => s.id === stationId)?.stationId ?? stationId;
  }

  const variables = template.variables;
  const templateVersion = template.ocppVersion;
  const hasFilter =
    template.targetFilter != null &&
    (template.targetFilter.siteId != null ||
      template.targetFilter.vendorId != null ||
      template.targetFilter.model != null ||
      template.targetFilter.stationId != null ||
      isDataPlan(template.targetFilter.dataPlan));
  const hasInstances = variables.some(
    (v) => v.variableInstance != null && v.variableInstance !== '',
  );
  // A template bound to a station targets that station only: its target
  // filter is not editable (the API refuses it).
  const isStationTemplate = template.stationId != null;
  // A template without a site or station targets every site: only all-site
  // users manage it (the API answers others 404).
  const canManageTemplate =
    hasAllSiteAccess ||
    isStationTemplate ||
    template.targetFilter?.siteId != null ||
    template.targetFilter?.stationId != null;

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>{t('common.details')}</CardTitle>
          <div className="flex flex-wrap gap-2 *:grow sm:*:grow-0">
            {!editing && canManageTemplate && (
              <EditButton label={t('common.edit')} onClick={startEdit} />
            )}
            {!editing && canManageTemplate && (
              <Button
                variant="outline"
                className="gap-1.5"
                disabled={duplicateMutation.isPending}
                onClick={() => {
                  setDuplicateOpen(true);
                }}
              >
                <Copy className="h-4 w-4" />
                {t('common.duplicate')}
              </Button>
            )}
            {!editing && canManageTemplate && (
              <PushButton
                label={t('configTemplates.pushConfig')}
                disabled={variables.length === 0 || (matchingOnline?.total ?? 0) === 0}
                onClick={() => {
                  setPushOpen(true);
                }}
              />
            )}
            {!editing && canManageTemplate && (
              <RemoveButton
                label={t('common.delete')}
                onClick={() => {
                  setDeleteOpen(true);
                }}
              />
            )}
          </div>
        </CardHeader>
        <CardContent>
          {editing ? (
            <form
              className="grid gap-4"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                setHasSubmitted(true);
                if (Object.keys(validationErrors).length > 0) return;
                const body: {
                  name?: string;
                  description?: string;
                  ocppVersion?: OcppVersion;
                  variables?: TemplateVariable[];
                  targetFilter?: TargetFilterValue | null;
                } = {
                  name: editName,
                  ocppVersion: editOcppVersion,
                  variables: templateVariablesForSave(editVariables, editOcppVersion),
                };
                if (editDescription !== '') body.description = editDescription;
                if (!isStationTemplate) {
                  body.targetFilter = Object.keys(editFilter).length > 0 ? editFilter : null;
                }
                updateMutation.mutate(body);
              }}
            >
              <div className="grid gap-2">
                <Label htmlFor="ctd-edit-name">{t('common.name')}</Label>
                <Input
                  id="ctd-edit-name"
                  value={editName}
                  onChange={(e) => {
                    setEditName(e.target.value);
                  }}
                  className={hasSubmitted && validationErrors.editName ? 'border-destructive' : ''}
                />
                {hasSubmitted && validationErrors.editName && (
                  <p className="text-sm text-destructive">{validationErrors.editName}</p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ctd-edit-description">{t('common.description')}</Label>
                <Input
                  id="ctd-edit-description"
                  value={editDescription}
                  onChange={(e) => {
                    setEditDescription(e.target.value);
                  }}
                />
              </div>

              <div className="grid gap-2">
                <Label>{t('configTemplates.ocppVersion')}</Label>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    variant={editOcppVersion === '2.1' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => {
                      handleEditVersionChange('2.1');
                    }}
                  >
                    OCPP 2.1
                  </Button>
                  <Button
                    type="button"
                    variant={editOcppVersion === '1.6' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => {
                      handleEditVersionChange('1.6');
                    }}
                  >
                    OCPP 1.6
                  </Button>
                </div>
                {editVariables.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t('configTemplates.versionSwitchWarning')}
                  </p>
                )}
              </div>

              <div className="grid gap-2">
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
                  idPrefix="detail"
                  ocppVersion={editOcppVersion}
                  variables={editVariables}
                  onChange={setEditVariables}
                  bootOwnedRefused={isBootOwnedRefusal(updateMutation.error)}
                  showDuplicates={hasSubmitted}
                />
              </div>

              {!isStationTemplate && (
                <TargetFilterFields
                  endpoint="/v1/config-templates/filter-options"
                  queryKeyPrefix={['config-template-filter-options']}
                  value={editFilter}
                  onChange={setEditFilter}
                  idPrefix="ct-edit-filter"
                  showDataPlan
                />
              )}

              {updateMutation.isError && (
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
                  <dt className="text-muted-foreground">{t('common.description')}</dt>
                  <dd className="font-medium">{template.description ?? 'n/a'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('configTemplates.ocppVersion')}</dt>
                  <dd className="font-medium">OCPP {templateVersion}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('common.created')}</dt>
                  <dd className="font-medium">{formatDateTime(template.createdAt, timezone)}</dd>
                </div>
                {hasFilter && (
                  <>
                    {template.targetFilter?.siteId != null && (
                      <div>
                        <dt className="text-muted-foreground">{t('configTemplates.site')}</dt>
                        <dd className="font-medium">
                          {resolveSiteName(template.targetFilter.siteId)}
                        </dd>
                      </div>
                    )}
                    {template.targetFilter?.vendorId != null && (
                      <div>
                        <dt className="text-muted-foreground">{t('configTemplates.vendor')}</dt>
                        <dd className="font-medium">
                          {resolveVendorName(template.targetFilter.vendorId)}
                        </dd>
                      </div>
                    )}
                    {template.targetFilter?.model != null && (
                      <div>
                        <dt className="text-muted-foreground">{t('configTemplates.model')}</dt>
                        <dd className="font-medium">{template.targetFilter.model}</dd>
                      </div>
                    )}
                    {template.targetFilter?.stationId != null && (
                      <div>
                        <dt className="text-muted-foreground">{t('configTemplates.station')}</dt>
                        <dd className="font-medium">
                          {resolveStationName(template.targetFilter.stationId)}
                        </dd>
                      </div>
                    )}
                    {isDataPlan(template.targetFilter?.dataPlan) && (
                      <div>
                        <dt className="text-muted-foreground">{t('dataPlan.title')}</dt>
                        <dd className="font-medium">
                          {t(`dataPlan.plans.${template.targetFilter.dataPlan}`)}
                        </dd>
                      </div>
                    )}
                  </>
                )}
              </dl>

              <div>
                <h3 className="text-sm font-medium mb-2">
                  {t('configTemplates.variables')} ({variables.length})
                </h3>
                {variables.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t('configTemplates.noVariables')}
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {templateVersion !== '1.6' && (
                            <TableHead>{t('configTemplates.component')}</TableHead>
                          )}
                          <TableHead>
                            {templateVersion === '1.6'
                              ? t('configTemplates.configKey')
                              : t('configTemplates.variable')}
                          </TableHead>
                          {templateVersion !== '1.6' && hasInstances && (
                            <TableHead>{t('configTemplates.variableInstance')}</TableHead>
                          )}
                          <TableHead>{t('common.value')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {variables.map((v, i) => (
                          <TableRow key={i}>
                            {templateVersion !== '1.6' && (
                              <TableCell className="text-xs">{v.component}</TableCell>
                            )}
                            <TableCell className="text-xs">{v.variable}</TableCell>
                            {templateVersion !== '1.6' && hasInstances && (
                              <TableCell className="text-xs">{v.variableInstance ?? ''}</TableCell>
                            )}
                            <TableCell className="text-xs">{v.value}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('configTemplates.confirmDelete')}
        description={t('configTemplates.confirmDeleteDescription')}
        confirmLabel={t('common.delete')}
        variant="destructive"
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          deleteMutation.mutate();
        }}
      />

      <ConfirmDialog
        open={pushOpen}
        onOpenChange={setPushOpen}
        title={t('configTemplates.confirmPush')}
        description={t('configTemplates.confirmPushDescription')}
        confirmLabel={t('configTemplates.pushConfig')}
        confirmIcon={<Upload className="h-4 w-4" />}
        variant="default"
        isPending={pushMutation.isPending}
        onConfirm={() => {
          pushMutation.mutate();
          return false;
        }}
      >
        {pushMutation.isError && (
          <p className="text-sm text-destructive">{getErrorMessage(pushMutation.error, t)}</p>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={duplicateOpen}
        onOpenChange={setDuplicateOpen}
        title={t('common.confirmDuplicate')}
        description={t('common.confirmDuplicateDescription')}
        confirmLabel={t('common.duplicate')}
        isPending={duplicateMutation.isPending}
        onConfirm={() => {
          duplicateMutation.mutate();
        }}
      />
    </>
  );
}
