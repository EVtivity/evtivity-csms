// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { Copy, Upload } from 'lucide-react';
import { AddIconButton } from '@/components/add-icon-button';
import { EditButton } from '@/components/edit-button';
import { RemoveButton } from '@/components/remove-button';
import { SaveButton } from '@/components/save-button';
import { CancelButton } from '@/components/cancel-button';
import { RemoveIconButton } from '@/components/remove-icon-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { MatchingStationsCard } from '@/components/MatchingStationsCard';
import { CopyableId } from '@/components/copyable-id';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/timezone';
import { useUserTimezone } from '@/lib/timezone';
import { OCPP_21_VARIABLES, OCPP_16_KEYS } from '@/lib/ocpp-variables';

interface TemplateVariable {
  component: string;
  variable: string;
  value: string;
}

interface TemplateDetail {
  id: string;
  name: string;
  description: string | null;
  ocppVersion: string;
  variables: TemplateVariable[];
  targetFilter: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
}

interface FilterOptions {
  sites: { id: string; name: string }[];
  vendors: { id: string; name: string }[];
  models: string[];
}

interface PushRecord {
  id: string;
  status: string;
  stationCount: number;
  acceptedCount: number;
  rejectedCount: number;
  failedCount: number;
  pendingCount: number;
  createdAt: string;
}

const PUSH_STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'success' | 'outline'> = {
  active: 'default',
  completed: 'secondary',
};

type OcppVersion = '2.1' | '1.6';

export function ConfigTemplateDetail(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editOcppVersion, setEditOcppVersion] = useState<OcppVersion>('2.1');
  const [editVariables, setEditVariables] = useState<TemplateVariable[]>([]);
  const [editFilterSiteId, setEditFilterSiteId] = useState('');
  const [editFilterVendorId, setEditFilterVendorId] = useState('');
  const [editFilterModel, setEditFilterModel] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const [pushHistoryPage, setPushHistoryPage] = useState(1);
  const pushHistoryLimit = 10;

  const { data: template, isLoading } = useQuery({
    queryKey: ['config-templates', id],
    queryFn: () => api.get<TemplateDetail>(`/v1/config-templates/${id ?? ''}`),
    enabled: id != null,
  });

  const { data: filterOptions } = useQuery({
    queryKey: ['config-template-filter-options'],
    queryFn: () => api.get<FilterOptions>('/v1/config-templates/filter-options'),
  });

  const { data: pushHistory } = useQuery({
    queryKey: ['config-templates', id, 'pushes', pushHistoryPage],
    queryFn: () =>
      api.get<{ data: PushRecord[]; total: number }>(
        `/v1/config-templates/${id ?? ''}/pushes?page=${String(pushHistoryPage)}&limit=${String(pushHistoryLimit)}`,
      ),
    enabled: id != null,
    refetchInterval: 5000,
  });

  const updateMutation = useMutation({
    mutationFn: (body: {
      name?: string;
      description?: string;
      ocppVersion?: OcppVersion;
      variables?: TemplateVariable[];
      targetFilter?: { siteId?: string; vendorId?: string; model?: string } | null;
    }) => api.patch(`/v1/config-templates/${id ?? ''}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['config-templates', id] });
      void queryClient.invalidateQueries({
        queryKey: ['config-templates', id, 'matching-stations'],
      });
      setEditing(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/v1/config-templates/${id ?? ''}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['config-templates'] });
      void navigate('/settings?tab=configuration');
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: () => api.post<TemplateDetail>(`/v1/config-templates/${id ?? ''}/duplicate`, {}),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['config-templates'] });
      void navigate(`/station-configurations/${data.id}`);
    },
  });

  const pushMutation = useMutation({
    mutationFn: () =>
      api.post<{ success: boolean; pushId: string }>(`/v1/config-templates/${id ?? ''}/push`, {}),
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
    return errors;
  }

  const validationErrors = getValidationErrors();

  function startEdit(): void {
    if (template == null) return;
    setEditName(template.name);
    setEditDescription(template.description ?? '');
    setEditOcppVersion(template.ocppVersion as OcppVersion);
    setEditVariables([...template.variables]);
    setEditFilterSiteId(template.targetFilter?.siteId ?? '');
    setEditFilterVendorId(template.targetFilter?.vendorId ?? '');
    setEditFilterModel(template.targetFilter?.model ?? '');
    setHasSubmitted(false);
    setEditing(true);
  }

  function addVariable(): void {
    setEditVariables((prev) => [...prev, { component: '', variable: '', value: '' }]);
  }

  function updateVariable(index: number, field: keyof TemplateVariable, val: string): void {
    setEditVariables((prev) => {
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
    setEditVariables((prev) => prev.filter((_, i) => i !== index));
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

  if (isLoading) {
    return <p className="text-muted-foreground">{t('common.loading')}</p>;
  }

  if (template == null) {
    return <p className="text-destructive">{t('configTemplates.notFound')}</p>;
  }

  const variables = template.variables;
  const templateVersion = template.ocppVersion;

  const hasFilter =
    template.targetFilter != null &&
    (template.targetFilter.siteId != null ||
      template.targetFilter.vendorId != null ||
      template.targetFilter.model != null);

  const componentNames = Object.keys(OCPP_21_VARIABLES).sort();

  return (
    <div className="px-4 py-4 md:px-6 md:py-6 space-y-6">
      <div className="flex items-center gap-4">
        <BackButton to="/settings?tab=configuration" />
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{template.name}</h1>
          <CopyableId id={template.id} />
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('common.details')}</CardTitle>
          <div className="flex gap-2">
            {!editing && <EditButton label={t('common.edit')} onClick={startEdit} />}
            {!editing && (
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
            <Button
              variant="outline"
              className="gap-1.5"
              disabled={variables.length === 0}
              onClick={() => {
                setPushOpen(true);
              }}
            >
              <Upload className="h-4 w-4" />
              {t('configTemplates.pushConfig')}
            </Button>
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
                  targetFilter?: { siteId?: string; vendorId?: string; model?: string } | null;
                } = {
                  name: editName,
                  ocppVersion: editOcppVersion,
                  variables:
                    editOcppVersion === '1.6'
                      ? editVariables.filter((v) => v.variable)
                      : editVariables.filter((v) => v.component && v.variable),
                };
                if (editDescription !== '') body.description = editDescription;
                const filter: { siteId?: string; vendorId?: string; model?: string } = {};
                if (editFilterSiteId) filter.siteId = editFilterSiteId;
                if (editFilterVendorId) filter.vendorId = editFilterVendorId;
                if (editFilterModel) filter.model = editFilterModel;
                body.targetFilter = Object.keys(filter).length > 0 ? filter : null;
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
                <div className="flex items-center justify-between">
                  <Label>{t('configTemplates.variables')}</Label>
                  <AddIconButton title={t('common.add')} onClick={addVariable} size="sm" />
                </div>
                {editVariables.map((v, i) =>
                  editOcppVersion === '1.6' ? (
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
                <div className="grid gap-2">
                  <Label htmlFor="edit-filter-site-select">{t('configTemplates.site')}</Label>
                  <Select
                    id="edit-filter-site-select"
                    value={editFilterSiteId}
                    onChange={(e) => {
                      setEditFilterSiteId(e.target.value);
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
                <div className="grid gap-2">
                  <Label htmlFor="edit-filter-vendor-select">{t('configTemplates.vendor')}</Label>
                  <Select
                    id="edit-filter-vendor-select"
                    value={editFilterVendorId}
                    onChange={(e) => {
                      setEditFilterVendorId(e.target.value);
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
                <div className="grid gap-2">
                  <Label htmlFor="edit-filter-model-select">{t('configTemplates.model')}</Label>
                  <Select
                    id="edit-filter-model-select"
                    value={editFilterModel}
                    onChange={(e) => {
                      setEditFilterModel(e.target.value);
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
            <div className="space-y-4">
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">{t('common.description')}</dt>
                  <dd className="font-medium">{template.description ?? '--'}</dd>
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

      <Card>
        <CardHeader>
          <CardTitle>{t('configTemplates.pushHistory')}</CardTitle>
        </CardHeader>
        <CardContent>
          {(pushHistory?.total ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">{t('configTemplates.noPushes')}</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('common.timestamp')}</TableHead>
                      <TableHead>{t('common.status')}</TableHead>
                      <TableHead>{t('nav.stations')}</TableHead>
                      <TableHead>{t('configTemplates.accepted')}</TableHead>
                      <TableHead>{t('configTemplates.rejected')}</TableHead>
                      <TableHead>{t('configTemplates.failed')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pushHistory?.data.map((push) => (
                      <TableRow
                        key={push.id}
                        className="cursor-pointer"
                        data-testid={`config-push-row-${push.id}`}
                        onClick={() => {
                          void navigate(`/station-configuration-pushes/${push.id}`);
                        }}
                      >
                        <TableCell className="text-xs" data-testid="row-click-target">
                          {formatDateTime(push.createdAt, timezone)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={PUSH_STATUS_VARIANT[push.status] ?? 'outline'}>
                            {push.status}
                          </Badge>
                        </TableCell>
                        <TableCell>{push.stationCount}</TableCell>
                        <TableCell>{push.acceptedCount}</TableCell>
                        <TableCell>
                          {push.rejectedCount > 0 ? (
                            <span className="text-warning">{push.rejectedCount}</span>
                          ) : (
                            0
                          )}
                        </TableCell>
                        <TableCell>
                          {push.failedCount > 0 ? (
                            <span className="text-destructive">{push.failedCount}</span>
                          ) : (
                            0
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Pagination
                page={pushHistoryPage}
                totalPages={Math.ceil((pushHistory?.total ?? 0) / pushHistoryLimit)}
                onPageChange={setPushHistoryPage}
              />
            </>
          )}
        </CardContent>
      </Card>

      <MatchingStationsCard
        endpoint={`/v1/config-templates/${id ?? ''}/matching-stations`}
        queryKey={['config-templates', id ?? '', 'matching-stations']}
        subtitle={t('configTemplates.subtitle')}
      />

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
        isPending={pushMutation.isPending}
        onConfirm={() => {
          pushMutation.mutate();
        }}
      />
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
    </div>
  );
}
