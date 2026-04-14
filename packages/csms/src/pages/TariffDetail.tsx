// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { Trash2 } from 'lucide-react';
import { EditButton } from '@/components/edit-button';
import { RemoveButton } from '@/components/remove-button';
import { CopyableId } from '@/components/copyable-id';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

interface TariffRestrictions {
  timeRange?: { startTime: string; endTime: string };
  daysOfWeek?: number[];
  dateRange?: { startDate: string; endDate: string };
  holidays?: boolean;
  energyThresholdKwh?: number;
}

interface Tariff {
  id: string;
  pricingGroupId: string;
  name: string;
  currency: string;
  pricePerKwh: string | null;
  pricePerMinute: string | null;
  pricePerSession: string | null;
  isActive: boolean;
  idleFeePricePerMinute: string | null;
  taxRate: string | null;
  restrictions: TariffRestrictions | null;
  priority: number;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

function deriveRestrictionType(restrictions: TariffRestrictions | null): string {
  if (restrictions == null) return 'default';
  if (restrictions.energyThresholdKwh != null) return 'energy';
  if (restrictions.holidays === true) return 'holiday';
  if (restrictions.dateRange != null) return 'seasonal';
  if (restrictions.daysOfWeek != null) return 'dayTime';
  if (restrictions.timeRange != null) return 'time';
  return 'default';
}

export function TariffDetail(): React.JSX.Element {
  const { id, tariffId } = useParams<{ id: string; tariffId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const timezone = useUserTimezone();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [pricePerKwh, setPricePerKwh] = useState('');
  const [pricePerMinute, setPricePerMinute] = useState('');
  const [pricePerSession, setPricePerSession] = useState('');
  const [idleFeePricePerMinute, setIdleFeePricePerMinute] = useState('');
  const [taxRate, setTaxRate] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Restriction edit state
  const [restrictionType, setRestrictionType] = useState('default');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [selectedDays, setSelectedDays] = useState<number[]>([]);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [thresholdKwh, setThresholdKwh] = useState('');

  const dayLabels = [
    t('pricing.sunday'),
    t('pricing.monday'),
    t('pricing.tuesday'),
    t('pricing.wednesday'),
    t('pricing.thursday'),
    t('pricing.friday'),
    t('pricing.saturday'),
  ];

  const { data: tariff, isLoading } = useQuery({
    queryKey: ['tariffs', id, tariffId],
    queryFn: () => api.get<Tariff>(`/v1/pricing-groups/${id ?? ''}/tariffs/${tariffId ?? ''}`),
    enabled: id != null && tariffId != null,
  });

  const updateMutation = useMutation({
    mutationFn: (body: {
      name?: string;
      pricePerKwh?: string | null;
      pricePerMinute?: string | null;
      pricePerSession?: string | null;
      idleFeePricePerMinute?: string | null;
      taxRate?: string | null;
      isActive?: boolean;
      restrictions?: Record<string, unknown> | null;
      isDefault?: boolean;
    }) => api.patch<Tariff>(`/v1/pricing-groups/${id ?? ''}/tariffs/${tariffId ?? ''}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tariffs', id, tariffId] });
      void queryClient.invalidateQueries({ queryKey: ['tariffs', id] });
      setEditing(false);
      setHasSubmitted(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      api.delete<undefined>(`/v1/pricing-groups/${id ?? ''}/tariffs/${tariffId ?? ''}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tariffs', id] });
      void navigate(`/pricing/${id ?? ''}?tab=tariffs`);
    },
  });

  function toggleDay(day: number): void {
    setSelectedDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
    );
  }

  function buildRestrictions(): {
    restrictions: Record<string, unknown> | null;
    isDefault: boolean;
  } {
    if (restrictionType === 'default') {
      return { restrictions: null, isDefault: true };
    }
    if (restrictionType === 'time') {
      return { restrictions: { timeRange: { startTime, endTime } }, isDefault: false };
    }
    if (restrictionType === 'dayTime') {
      const r: Record<string, unknown> = { daysOfWeek: selectedDays };
      if (startTime !== '' && endTime !== '') r.timeRange = { startTime, endTime };
      return { restrictions: r, isDefault: false };
    }
    if (restrictionType === 'seasonal') {
      return { restrictions: { dateRange: { startDate, endDate } }, isDefault: false };
    }
    if (restrictionType === 'holiday') {
      return { restrictions: { holidays: true }, isDefault: false };
    }
    if (restrictionType === 'energy') {
      return {
        restrictions: { energyThresholdKwh: parseFloat(thresholdKwh) },
        isDefault: false,
      };
    }
    return { restrictions: null, isDefault: false };
  }

  function startEdit(): void {
    if (tariff == null) return;
    setName(tariff.name);
    setPricePerKwh(tariff.pricePerKwh ?? '');
    setPricePerMinute(tariff.pricePerMinute ?? '');
    setPricePerSession(tariff.pricePerSession ?? '');
    setIdleFeePricePerMinute(tariff.idleFeePricePerMinute ?? '');
    setTaxRate(tariff.taxRate ?? '');
    setIsActive(tariff.isActive);

    const type = deriveRestrictionType(tariff.restrictions);
    setRestrictionType(type);
    if (type === 'time' || type === 'dayTime') {
      setStartTime(tariff.restrictions?.timeRange?.startTime ?? '');
      setEndTime(tariff.restrictions?.timeRange?.endTime ?? '');
    } else {
      setStartTime('');
      setEndTime('');
    }
    if (type === 'dayTime') {
      setSelectedDays(tariff.restrictions?.daysOfWeek ?? []);
    } else {
      setSelectedDays([]);
    }
    if (type === 'seasonal') {
      setStartDate(tariff.restrictions?.dateRange?.startDate ?? '');
      setEndDate(tariff.restrictions?.dateRange?.endDate ?? '');
    } else {
      setStartDate('');
      setEndDate('');
    }
    if (type === 'energy') {
      setThresholdKwh(
        tariff.restrictions?.energyThresholdKwh != null
          ? String(tariff.restrictions.energyThresholdKwh)
          : '',
      );
    } else {
      setThresholdKwh('');
    }

    setHasSubmitted(false);
    setEditing(true);
  }

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = t('validation.required');
    return errors;
  }

  const validationErrors = getValidationErrors();

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(validationErrors).length > 0) return;
    const { restrictions, isDefault } = buildRestrictions();
    updateMutation.mutate({
      name,
      pricePerKwh: pricePerKwh.trim() !== '' ? pricePerKwh : null,
      pricePerMinute: pricePerMinute.trim() !== '' ? pricePerMinute : null,
      pricePerSession: pricePerSession.trim() !== '' ? pricePerSession : null,
      idleFeePricePerMinute: idleFeePricePerMinute.trim() !== '' ? idleFeePricePerMinute : null,
      taxRate: taxRate.trim() !== '' ? taxRate : null,
      isActive,
      restrictions,
      isDefault,
    });
  }

  function formatRestrictionSummary(restrictions: TariffRestrictions | null): string {
    if (restrictions == null) return t('pricing.noRestrictions');
    if (restrictions.energyThresholdKwh != null) {
      return `Above ${String(restrictions.energyThresholdKwh)} kWh`;
    }
    if (restrictions.holidays === true) return t('pricing.holiday');
    if (restrictions.dateRange != null) {
      return `${restrictions.dateRange.startDate} - ${restrictions.dateRange.endDate}`;
    }
    const parts: string[] = [];
    if (restrictions.daysOfWeek != null) {
      const names = restrictions.daysOfWeek
        .map((d) => dayLabels[d])
        .filter((s): s is string => s != null);
      parts.push(names.join(', '));
    }
    if (restrictions.timeRange != null) {
      parts.push(`${restrictions.timeRange.startTime} - ${restrictions.timeRange.endTime}`);
    }
    return parts.join(' ') || '--';
  }

  const isOverlapError =
    updateMutation.error instanceof ApiError && updateMutation.error.status === 409;

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  }

  if (tariff == null) {
    return <p className="text-sm text-destructive">{t('pricing.tariffDetails')}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <BackButton to={`/pricing/${id ?? ''}?tab=tariffs`} />
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{tariff.name}</h1>
          <CopyableId id={tariff.id} />
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('common.details')}</CardTitle>
          <div className="flex gap-2">
            {!editing && <EditButton label={t('common.edit')} onClick={startEdit} />}
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
              onSubmit={handleSave}
              noValidate
              className="grid grid-cols-1 md:grid-cols-2 gap-4"
            >
              <div className="space-y-2">
                <Label htmlFor="edit-name">{t('common.name')}</Label>
                <Input
                  id="edit-name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                  }}
                  className={hasSubmitted && validationErrors.name ? 'border-destructive' : ''}
                />
                {hasSubmitted && validationErrors.name && (
                  <p className="text-sm text-destructive">{validationErrors.name}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-is-active">{t('common.status')}</Label>
                <Select
                  id="edit-is-active"
                  value={isActive ? 'true' : 'false'}
                  onChange={(e) => {
                    setIsActive(e.target.value === 'true');
                  }}
                >
                  <option value="true">{t('pricing.active')}</option>
                  <option value="false">{t('pricing.inactive')}</option>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-kwh">{t('pricing.pricePerKwh')}</Label>
                <Input
                  id="edit-kwh"
                  value={pricePerKwh}
                  onChange={(e) => {
                    setPricePerKwh(e.target.value);
                  }}
                  placeholder="0.25"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-min">{t('pricing.pricePerMinute')}</Label>
                <Input
                  id="edit-min"
                  value={pricePerMinute}
                  onChange={(e) => {
                    setPricePerMinute(e.target.value);
                  }}
                  placeholder="0.05"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-session">{t('pricing.pricePerSession')}</Label>
                <Input
                  id="edit-session"
                  value={pricePerSession}
                  onChange={(e) => {
                    setPricePerSession(e.target.value);
                  }}
                  placeholder="1.00"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-idle-fee">{t('pricing.idleFeePricePerMinute')}</Label>
                <Input
                  id="edit-idle-fee"
                  value={idleFeePricePerMinute}
                  onChange={(e) => {
                    setIdleFeePricePerMinute(e.target.value);
                  }}
                  placeholder="0.10"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-tax-rate">{t('pricing.taxRate')}</Label>
                <Input
                  id="edit-tax-rate"
                  value={taxRate}
                  onChange={(e) => {
                    setTaxRate(e.target.value);
                  }}
                  placeholder="0.08"
                />
                <p className="text-xs text-muted-foreground">{t('pricing.taxRateHelper')}</p>
              </div>

              <div className="col-span-full border-t pt-4 space-y-4">
                <p className="text-sm font-medium">{t('pricing.restrictions')}</p>
                <div className="space-y-2">
                  <Label htmlFor="edit-restriction-type">{t('pricing.tariffType')}</Label>
                  <Select
                    id="edit-restriction-type"
                    value={restrictionType}
                    onChange={(e) => {
                      setRestrictionType(e.target.value);
                    }}
                  >
                    <option value="default">{t('pricing.noRestrictions')}</option>
                    <option value="time">{t('pricing.timeRange')}</option>
                    <option value="dayTime">{t('pricing.dayOfWeek')}</option>
                    <option value="seasonal">{t('pricing.dateRange')}</option>
                    <option value="holiday">{t('pricing.holiday')}</option>
                    <option value="energy">{t('pricing.energyThreshold')}</option>
                  </Select>
                </div>

                {(restrictionType === 'time' || restrictionType === 'dayTime') && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="edit-start-time">{t('pricing.startTime')}</Label>
                      <Input
                        id="edit-start-time"
                        type="time"
                        value={startTime}
                        onChange={(e) => {
                          setStartTime(e.target.value);
                        }}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-end-time">{t('pricing.endTime')}</Label>
                      <Input
                        id="edit-end-time"
                        type="time"
                        value={endTime}
                        onChange={(e) => {
                          setEndTime(e.target.value);
                        }}
                      />
                    </div>
                  </div>
                )}

                {restrictionType === 'dayTime' && (
                  <div className="space-y-2">
                    <Label>{t('pricing.dayOfWeek')}</Label>
                    <div className="flex flex-wrap gap-3">
                      {dayLabels.map((label, idx) => (
                        <label
                          key={idx}
                          className="flex items-center gap-1.5 text-sm cursor-pointer"
                        >
                          <Checkbox
                            checked={selectedDays.includes(idx)}
                            onChange={() => {
                              toggleDay(idx);
                            }}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {restrictionType === 'seasonal' && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="edit-start-date">{t('pricing.startDate')}</Label>
                      <Input
                        id="edit-start-date"
                        value={startDate}
                        onChange={(e) => {
                          setStartDate(e.target.value);
                        }}
                        placeholder="MM-DD"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-end-date">{t('pricing.endDate')}</Label>
                      <Input
                        id="edit-end-date"
                        value={endDate}
                        onChange={(e) => {
                          setEndDate(e.target.value);
                        }}
                        placeholder="MM-DD"
                      />
                    </div>
                  </div>
                )}

                {restrictionType === 'holiday' && (
                  <p className="text-sm text-muted-foreground">{t('pricing.holidayDescription')}</p>
                )}

                {restrictionType === 'energy' && (
                  <div className="space-y-2">
                    <Label htmlFor="edit-threshold">{t('pricing.thresholdKwh')}</Label>
                    <Input
                      id="edit-threshold"
                      type="number"
                      min="0"
                      step="0.1"
                      value={thresholdKwh}
                      onChange={(e) => {
                        setThresholdKwh(e.target.value);
                      }}
                      placeholder="50"
                    />
                  </div>
                )}
              </div>

              {isOverlapError && (
                <div className="col-span-full">
                  <p className="text-sm text-destructive">{t('pricing.overlapError')}</p>
                </div>
              )}

              <div className="col-span-full flex justify-end gap-2">
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
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-muted-foreground">{t('common.name')}</dt>
                <dd className="font-medium">{tariff.name}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.status')}</dt>
                <dd className="font-medium">
                  {tariff.isActive ? (
                    <Badge variant="success">{t('pricing.active')}</Badge>
                  ) : (
                    <Badge variant="outline">{t('pricing.inactive')}</Badge>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('pricing.currency')}</dt>
                <dd className="font-medium">{tariff.currency}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('pricing.tariffType')}</dt>
                <dd className="font-medium flex items-center gap-2">
                  {formatRestrictionSummary(tariff.restrictions)}
                  {tariff.isDefault && (
                    <Badge variant="secondary">{t('pricing.defaultTariff')}</Badge>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('pricing.priority')}</dt>
                <dd className="font-medium">{tariff.priority}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('pricing.pricePerKwh')}</dt>
                <dd className="font-medium">{tariff.pricePerKwh ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('pricing.pricePerMinute')}</dt>
                <dd className="font-medium">{tariff.pricePerMinute ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('pricing.pricePerSession')}</dt>
                <dd className="font-medium">{tariff.pricePerSession ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('pricing.idleFeePricePerMinute')}</dt>
                <dd className="font-medium">{tariff.idleFeePricePerMinute ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('pricing.taxRate')}</dt>
                <dd className="font-medium">{tariff.taxRate ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.created')}</dt>
                <dd className="font-medium">{formatDateTime(tariff.createdAt, timezone)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.lastUpdated')}</dt>
                <dd className="font-medium">{formatDateTime(tariff.updatedAt, timezone)}</dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('common.delete')}
        description={t('pricing.confirmDeleteTariffDesc')}
        confirmLabel={t('common.delete')}
        confirmIcon={<Trash2 className="h-4 w-4" />}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          deleteMutation.mutate();
        }}
      />
    </div>
  );
}
