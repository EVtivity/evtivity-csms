// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { Copy, Upload } from 'lucide-react';
import { EditButton } from '@/components/edit-button';
import { RemoveButton } from '@/components/remove-button';
import { SaveButton } from '@/components/save-button';
import { CancelButton } from '@/components/cancel-button';
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
import { TimeSlotEditor, type SchedulePeriod } from '@/components/smart-charging/TimeSlotEditor';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/timezone';
import { useUserTimezone } from '@/lib/timezone';

type OcppVersion = '2.1' | '1.6';

const PURPOSES_21 = [
  'ChargingStationMaxProfile',
  'TxDefaultProfile',
  'PriorityCharging',
  'LocalGeneration',
];

const PURPOSES_16 = ['ChargePointMaxProfile', 'TxDefaultProfile'];

interface TemplateDetail {
  id: string;
  name: string;
  description: string | null;
  ocppVersion: string;
  profilePurpose: string;
  profileKind: string;
  recurrencyKind: string | null;
  profileId: number;
  stackLevel: number;
  evseId: number;
  chargingRateUnit: string;
  schedulePeriods: SchedulePeriod[];
  startSchedule: string | null;
  duration: number | null;
  validFrom: string | null;
  validTo: string | null;
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

function secondsToTimeString(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function SmartChargingTemplateDetail(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editOcppVersion, setEditOcppVersion] = useState<OcppVersion>('2.1');
  const [editPurpose, setEditPurpose] = useState('');
  const [editKind, setEditKind] = useState('');
  const [editRecurrency, setEditRecurrency] = useState('');
  const [editProfileId, setEditProfileId] = useState(100);
  const [editStackLevel, setEditStackLevel] = useState(0);
  const [editEvseId, setEditEvseId] = useState(0);
  const [editRateUnit, setEditRateUnit] = useState<'W' | 'A'>('W');
  const [editPeriods, setEditPeriods] = useState<SchedulePeriod[]>([]);
  const [editStartSchedule, setEditStartSchedule] = useState('');
  const [editDuration, setEditDuration] = useState('');
  const [editValidFrom, setEditValidFrom] = useState('');
  const [editValidTo, setEditValidTo] = useState('');
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
    queryKey: ['smart-charging-templates', id],
    queryFn: () => api.get<TemplateDetail>(`/v1/smart-charging/templates/${id ?? ''}`),
    enabled: id != null,
  });

  const { data: filterOptions } = useQuery({
    queryKey: ['smart-charging-filter-options'],
    queryFn: () => api.get<FilterOptions>('/v1/smart-charging/filter-options'),
  });

  const { data: pushHistory } = useQuery({
    queryKey: ['smart-charging-templates', id, 'pushes', pushHistoryPage],
    queryFn: () =>
      api.get<{ data: PushRecord[]; total: number }>(
        `/v1/smart-charging/templates/${id ?? ''}/pushes?page=${String(pushHistoryPage)}&limit=${String(pushHistoryLimit)}`,
      ),
    enabled: id != null,
    refetchInterval: 5000,
  });

  const updateMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch(`/v1/smart-charging/templates/${id ?? ''}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['smart-charging-templates', id] });
      void queryClient.invalidateQueries({
        queryKey: ['smart-charging-templates', id, 'matching-stations'],
      });
      setEditing(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/v1/smart-charging/templates/${id ?? ''}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['smart-charging-templates'] });
      void navigate('/smart-charging');
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: () =>
      api.post<TemplateDetail>(`/v1/smart-charging/templates/${id ?? ''}/duplicate`, {}),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['smart-charging-templates'] });
      void navigate(`/smart-charging/${data.id}`);
    },
  });

  const pushMutation = useMutation({
    mutationFn: () =>
      api.post<{ success: boolean; pushId: string }>(
        `/v1/smart-charging/templates/${id ?? ''}/push`,
        {},
      ),
    onSuccess: (data) => {
      setPushOpen(false);
      void queryClient.invalidateQueries({
        queryKey: ['smart-charging-templates', id, 'pushes'],
      });
      if (data.pushId) {
        void navigate(`/smart-charging/pushes/${data.pushId}`);
      }
    },
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!editName.trim()) errors.editName = t('validation.required');
    return errors;
  }

  const validationErrors = getValidationErrors();

  function formatDatetimeLocal(iso: string | null): string {
    if (iso == null) return '';
    const d = new Date(iso);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function startEdit(): void {
    if (template == null) return;
    setEditName(template.name);
    setEditDescription(template.description ?? '');
    setEditOcppVersion(template.ocppVersion as OcppVersion);
    setEditPurpose(template.profilePurpose);
    setEditKind(template.profileKind);
    setEditRecurrency(template.recurrencyKind ?? 'Daily');
    setEditProfileId(template.profileId);
    setEditStackLevel(template.stackLevel);
    setEditEvseId(template.evseId);
    setEditRateUnit(template.chargingRateUnit as 'W' | 'A');
    setEditPeriods([...template.schedulePeriods]);
    setEditStartSchedule(formatDatetimeLocal(template.startSchedule));
    setEditDuration(template.duration != null ? String(template.duration) : '');
    setEditValidFrom(formatDatetimeLocal(template.validFrom));
    setEditValidTo(formatDatetimeLocal(template.validTo));
    setEditFilterSiteId(template.targetFilter?.siteId ?? '');
    setEditFilterVendorId(template.targetFilter?.vendorId ?? '');
    setEditFilterModel(template.targetFilter?.model ?? '');
    setHasSubmitted(false);
    setEditing(true);
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
    return <p className="text-destructive">{t('smartCharging.notFound')}</p>;
  }

  const hasFilter =
    template.targetFilter != null &&
    (template.targetFilter.siteId != null ||
      template.targetFilter.vendorId != null ||
      template.targetFilter.model != null);

  const editPurposes = editOcppVersion === '1.6' ? PURPOSES_16 : PURPOSES_21;

  return (
    <div className="px-4 py-4 md:px-6 md:py-6 space-y-6">
      <div className="flex items-center gap-4">
        <BackButton to="/smart-charging" />
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
              onClick={() => {
                setPushOpen(true);
              }}
            >
              <Upload className="h-4 w-4" />
              {t('smartCharging.push')}
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
                const body: Record<string, unknown> = {
                  name: editName,
                  ocppVersion: editOcppVersion,
                  profilePurpose: editPurpose,
                  profileKind: editKind,
                  profileId: editProfileId,
                  stackLevel: editStackLevel,
                  evseId: editEvseId,
                  chargingRateUnit: editRateUnit,
                  schedulePeriods: editPeriods,
                };
                if (editDescription !== '') body.description = editDescription;
                else body.description = null;
                if (editKind === 'Recurring') body.recurrencyKind = editRecurrency;
                else body.recurrencyKind = null;
                if (editStartSchedule)
                  body.startSchedule = new Date(editStartSchedule).toISOString();
                else body.startSchedule = null;
                if (editDuration) body.duration = parseInt(editDuration, 10);
                else body.duration = null;
                if (editValidFrom) body.validFrom = new Date(editValidFrom).toISOString();
                else body.validFrom = null;
                if (editValidTo) body.validTo = new Date(editValidTo).toISOString();
                else body.validTo = null;
                const filter: Record<string, string> = {};
                if (editFilterSiteId) filter.siteId = editFilterSiteId;
                if (editFilterVendorId) filter.vendorId = editFilterVendorId;
                if (editFilterModel) filter.model = editFilterModel;
                body.targetFilter = Object.keys(filter).length > 0 ? filter : null;
                updateMutation.mutate(body);
              }}
            >
              <div className="grid gap-2">
                <Label htmlFor="scd-edit-name">{t('common.name')}</Label>
                <Input
                  id="scd-edit-name"
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
                <Label htmlFor="scd-edit-description">{t('common.description')}</Label>
                <Input
                  id="scd-edit-description"
                  value={editDescription}
                  onChange={(e) => {
                    setEditDescription(e.target.value);
                  }}
                />
              </div>

              <div className="grid gap-2">
                <Label>{t('smartCharging.ocppVersion')}</Label>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    variant={editOcppVersion === '2.1' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => {
                      setEditOcppVersion('2.1');
                      if (!PURPOSES_21.includes(editPurpose)) {
                        setEditPurpose(PURPOSES_21[0] ?? '');
                      }
                    }}
                  >
                    OCPP 2.1
                  </Button>
                  <Button
                    type="button"
                    variant={editOcppVersion === '1.6' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => {
                      setEditOcppVersion('1.6');
                      if (!PURPOSES_16.includes(editPurpose)) {
                        setEditPurpose(PURPOSES_16[0] ?? '');
                      }
                    }}
                  >
                    OCPP 1.6
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="edit-purpose-select">{t('smartCharging.profilePurpose')}</Label>
                  <Select
                    id="edit-purpose-select"
                    value={editPurpose}
                    onChange={(e) => {
                      setEditPurpose(e.target.value);
                    }}
                  >
                    {editPurposes.map((p) => (
                      <option key={p} value={p}>
                        {(t as (key: string, opts?: Record<string, unknown>) => string)(
                          `smartCharging.purposes.${p}`,
                          { defaultValue: p },
                        )}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="edit-kind-select">{t('smartCharging.profileKind')}</Label>
                  <Select
                    id="edit-kind-select"
                    value={editKind}
                    onChange={(e) => {
                      setEditKind(e.target.value);
                    }}
                  >
                    <option value="Absolute">{t('smartCharging.kinds.Absolute')}</option>
                    <option value="Recurring">{t('smartCharging.kinds.Recurring')}</option>
                  </Select>
                </div>
              </div>

              {editKind === 'Recurring' && (
                <div className="grid gap-2">
                  <Label htmlFor="edit-recurrency-select">
                    {t('smartCharging.recurrencyKind')}
                  </Label>
                  <Select
                    id="edit-recurrency-select"
                    value={editRecurrency}
                    onChange={(e) => {
                      setEditRecurrency(e.target.value);
                    }}
                  >
                    <option value="Daily">{t('smartCharging.recurrence.Daily')}</option>
                    <option value="Weekly">{t('smartCharging.recurrence.Weekly')}</option>
                  </Select>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="scd-edit-profile-id">{t('smartCharging.profileId')}</Label>
                  <Input
                    id="scd-edit-profile-id"
                    type="number"
                    min={1}
                    value={editProfileId}
                    onChange={(e) => {
                      setEditProfileId(parseInt(e.target.value, 10) || 100);
                    }}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="scd-edit-stack-level">{t('smartCharging.stackLevel')}</Label>
                  <Input
                    id="scd-edit-stack-level"
                    type="number"
                    min={0}
                    value={editStackLevel}
                    onChange={(e) => {
                      setEditStackLevel(parseInt(e.target.value, 10) || 0);
                    }}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="scd-edit-evse-id">{t('smartCharging.evseId')}</Label>
                  <Input
                    id="scd-edit-evse-id"
                    type="number"
                    min={0}
                    value={editEvseId}
                    onChange={(e) => {
                      setEditEvseId(parseInt(e.target.value, 10) || 0);
                    }}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="edit-rate-unit-select">
                    {t('smartCharging.chargingRateUnit')}
                  </Label>
                  <Select
                    id="edit-rate-unit-select"
                    value={editRateUnit}
                    onChange={(e) => {
                      setEditRateUnit(e.target.value as 'W' | 'A');
                    }}
                  >
                    <option value="W">W (Watts)</option>
                    <option value="A">A (Amperes)</option>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="scd-edit-start-schedule">
                    {t('smartCharging.startSchedule')}
                  </Label>
                  <Input
                    id="scd-edit-start-schedule"
                    type="datetime-local"
                    value={editStartSchedule}
                    onChange={(e) => {
                      setEditStartSchedule(e.target.value);
                    }}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="scd-edit-valid-from">{t('smartCharging.validFrom')}</Label>
                  <Input
                    id="scd-edit-valid-from"
                    type="datetime-local"
                    value={editValidFrom}
                    onChange={(e) => {
                      setEditValidFrom(e.target.value);
                    }}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="scd-edit-valid-to">{t('smartCharging.validTo')}</Label>
                  <Input
                    id="scd-edit-valid-to"
                    type="datetime-local"
                    value={editValidTo}
                    onChange={(e) => {
                      setEditValidTo(e.target.value);
                    }}
                  />
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="scd-edit-duration">{t('smartCharging.durationSeconds')}</Label>
                <Input
                  id="scd-edit-duration"
                  type="number"
                  min={0}
                  value={editDuration}
                  placeholder="86400"
                  onChange={(e) => {
                    setEditDuration(e.target.value);
                  }}
                  className="w-48"
                />
              </div>

              <TimeSlotEditor
                periods={editPeriods}
                onChange={setEditPeriods}
                rateUnit={editRateUnit}
              />

              <div className="space-y-2 pt-2">
                <h3 className="text-sm font-medium">{t('smartCharging.targetFilter')}</h3>
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
                  <dt className="text-muted-foreground">{t('smartCharging.ocppVersion')}</dt>
                  <dd className="font-medium">OCPP {template.ocppVersion}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('smartCharging.profilePurpose')}</dt>
                  <dd className="font-medium">
                    {(t as (key: string, opts?: Record<string, unknown>) => string)(
                      `smartCharging.purposes.${template.profilePurpose}`,
                      { defaultValue: template.profilePurpose },
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('smartCharging.profileKind')}</dt>
                  <dd className="font-medium">
                    {(t as (key: string, opts?: Record<string, unknown>) => string)(
                      `smartCharging.kinds.${template.profileKind}`,
                      { defaultValue: template.profileKind },
                    )}
                    {template.recurrencyKind != null && (
                      <span className="text-muted-foreground">
                        {' '}
                        (
                        {(t as (key: string, opts?: Record<string, unknown>) => string)(
                          `smartCharging.recurrence.${template.recurrencyKind}`,
                          { defaultValue: template.recurrencyKind },
                        )}
                        )
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('smartCharging.profileId')}</dt>
                  <dd className="font-medium">{template.profileId}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('smartCharging.stackLevel')}</dt>
                  <dd className="font-medium">{template.stackLevel}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('smartCharging.evseId')}</dt>
                  <dd className="font-medium">{template.evseId}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('smartCharging.chargingRateUnit')}</dt>
                  <dd className="font-medium">{template.chargingRateUnit}</dd>
                </div>
                {template.startSchedule != null && (
                  <div>
                    <dt className="text-muted-foreground">{t('smartCharging.startSchedule')}</dt>
                    <dd className="font-medium">
                      {formatDateTime(template.startSchedule, timezone)}
                    </dd>
                  </div>
                )}
                {template.duration != null && (
                  <div>
                    <dt className="text-muted-foreground">{t('smartCharging.duration')}</dt>
                    <dd className="font-medium">{template.duration}s</dd>
                  </div>
                )}
                {template.validFrom != null && (
                  <div>
                    <dt className="text-muted-foreground">{t('smartCharging.validFrom')}</dt>
                    <dd className="font-medium">{formatDateTime(template.validFrom, timezone)}</dd>
                  </div>
                )}
                {template.validTo != null && (
                  <div>
                    <dt className="text-muted-foreground">{t('smartCharging.validTo')}</dt>
                    <dd className="font-medium">{formatDateTime(template.validTo, timezone)}</dd>
                  </div>
                )}
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
                  {t('smartCharging.schedulePeriods')} ({template.schedulePeriods.length})
                </h3>
                {template.schedulePeriods.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('smartCharging.noTemplates')}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('smartCharging.startTime')}</TableHead>
                          <TableHead>
                            {t('smartCharging.powerLimit')} ({template.chargingRateUnit})
                          </TableHead>
                          <TableHead>{t('smartCharging.phases')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {template.schedulePeriods.map((period, i) => (
                          <TableRow key={i}>
                            <TableCell className="text-xs">
                              {secondsToTimeString(period.startPeriod)}
                            </TableCell>
                            <TableCell className="text-xs">{period.limit}</TableCell>
                            <TableCell className="text-xs">{period.numberPhases ?? '--'}</TableCell>
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
          <CardTitle>{t('smartCharging.pushHistory')}</CardTitle>
        </CardHeader>
        <CardContent>
          {(pushHistory?.total ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">{t('smartCharging.noPushes')}</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('common.timestamp')}</TableHead>
                      <TableHead>{t('common.status')}</TableHead>
                      <TableHead>{t('nav.stations')}</TableHead>
                      <TableHead>{t('smartCharging.accepted')}</TableHead>
                      <TableHead>{t('smartCharging.rejected')}</TableHead>
                      <TableHead>{t('smartCharging.failed')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pushHistory?.data.map((push) => (
                      <TableRow
                        key={push.id}
                        className="cursor-pointer"
                        data-testid={`smart-charging-push-row-${push.id}`}
                        onClick={() => {
                          void navigate(`/smart-charging/pushes/${push.id}`);
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
        endpoint={`/v1/smart-charging/templates/${id ?? ''}/matching-stations`}
        queryKey={['smart-charging-templates', id ?? '', 'matching-stations']}
        subtitle={t('smartCharging.templates')}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('smartCharging.confirmDelete')}
        description={t('smartCharging.confirmDeleteDescription')}
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
        title={t('smartCharging.confirmPush')}
        description={t('smartCharging.confirmPushDescription')}
        confirmLabel={t('smartCharging.push')}
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
