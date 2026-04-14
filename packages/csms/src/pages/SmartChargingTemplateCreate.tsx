// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { TimeSlotEditor, type SchedulePeriod } from '@/components/smart-charging/TimeSlotEditor';
import { api } from '@/lib/api';

type OcppVersion = '2.1' | '1.6';

const PURPOSES_21 = [
  'ChargingStationMaxProfile',
  'TxDefaultProfile',
  'PriorityCharging',
  'LocalGeneration',
];

const PURPOSES_16 = ['ChargePointMaxProfile', 'TxDefaultProfile'];

interface FilterOptions {
  sites: { id: string; name: string }[];
  vendors: { id: string; name: string }[];
  models: string[];
}

interface CreatedTemplate {
  id: string;
}

export function SmartChargingTemplateCreate(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [ocppVersion, setOcppVersion] = useState<OcppVersion>('2.1');
  const [profilePurpose, setProfilePurpose] = useState('ChargingStationMaxProfile');
  const [profileKind, setProfileKind] = useState('Absolute');
  const [recurrencyKind, setRecurrencyKind] = useState('Daily');
  const [profileId, setProfileId] = useState(100);
  const [stackLevel, setStackLevel] = useState(0);
  const [evseId, setEvseId] = useState(0);
  const [chargingRateUnit, setChargingRateUnit] = useState<'W' | 'A'>('W');
  const [startSchedule, setStartSchedule] = useState('');
  const [duration, setDuration] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [schedulePeriods, setSchedulePeriods] = useState<SchedulePeriod[]>([]);
  const [filterSiteId, setFilterSiteId] = useState('');
  const [filterVendorId, setFilterVendorId] = useState('');
  const [filterModel, setFilterModel] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const { data: filterOptions } = useQuery({
    queryKey: ['smart-charging-filter-options'],
    queryFn: () => api.get<FilterOptions>('/v1/smart-charging/filter-options'),
  });

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<CreatedTemplate>('/v1/smart-charging/templates', body),
    onSuccess: (created) => {
      void navigate(`/smart-charging/${created.id}`);
    },
  });

  const purposes = ocppVersion === '1.6' ? PURPOSES_16 : PURPOSES_21;

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = t('validation.required');
    if (profileKind === 'Recurring' && !startSchedule) {
      errors.startSchedule = t('validation.required');
    }
    return errors;
  }

  const errors = getValidationErrors();

  function handleVersionChange(version: OcppVersion): void {
    if (version === ocppVersion) return;
    setOcppVersion(version);
    const newPurposes = version === '1.6' ? PURPOSES_16 : PURPOSES_21;
    if (!newPurposes.includes(profilePurpose)) {
      setProfilePurpose(newPurposes[0] ?? '');
    }
  }

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;

    const body: Record<string, unknown> = {
      name,
      ocppVersion,
      profilePurpose,
      profileKind,
      profileId,
      stackLevel,
      evseId,
      chargingRateUnit,
      schedulePeriods,
    };
    if (description.trim() !== '') body.description = description;
    if (profileKind === 'Recurring') body.recurrencyKind = recurrencyKind;
    if (startSchedule) body.startSchedule = new Date(startSchedule).toISOString();
    if (duration) body.duration = parseInt(duration, 10);
    if (validFrom) body.validFrom = new Date(validFrom).toISOString();
    if (validTo) body.validTo = new Date(validTo).toISOString();

    const filter: Record<string, string> = {};
    if (filterSiteId) filter.siteId = filterSiteId;
    if (filterVendorId) filter.vendorId = filterVendorId;
    if (filterModel) filter.model = filterModel;
    if (Object.keys(filter).length > 0) body.targetFilter = filter;

    createMutation.mutate(body);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to="/smart-charging" />
        <h1 className="text-2xl font-bold md:text-3xl">{t('smartCharging.createTemplate')}</h1>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="sc-name">{t('common.name')}</Label>
              <Input
                id="sc-name"
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
              <Label htmlFor="sc-description">{t('common.description')}</Label>
              <Input
                id="sc-description"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                }}
              />
            </div>

            <div className="space-y-2">
              <Label>{t('smartCharging.ocppVersion')}</Label>
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
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="sc-purpose">{t('smartCharging.profilePurpose')}</Label>
                <Select
                  id="sc-purpose"
                  value={profilePurpose}
                  onChange={(e) => {
                    setProfilePurpose(e.target.value);
                  }}
                >
                  {purposes.map((p) => (
                    <option key={p} value={p}>
                      {(t as (key: string, opts?: Record<string, unknown>) => string)(
                        `smartCharging.purposes.${p}`,
                        { defaultValue: p },
                      )}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="sc-kind">{t('smartCharging.profileKind')}</Label>
                <Select
                  id="sc-kind"
                  value={profileKind}
                  onChange={(e) => {
                    setProfileKind(e.target.value);
                  }}
                >
                  <option value="Absolute">{t('smartCharging.kinds.Absolute')}</option>
                  <option value="Recurring">{t('smartCharging.kinds.Recurring')}</option>
                </Select>
              </div>
            </div>

            {profileKind === 'Recurring' && (
              <div className="space-y-2">
                <Label htmlFor="sc-recurrency">{t('smartCharging.recurrencyKind')}</Label>
                <Select
                  id="sc-recurrency"
                  value={recurrencyKind}
                  onChange={(e) => {
                    setRecurrencyKind(e.target.value);
                  }}
                >
                  <option value="Daily">{t('smartCharging.recurrence.Daily')}</option>
                  <option value="Weekly">{t('smartCharging.recurrence.Weekly')}</option>
                </Select>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label htmlFor="sc-profile-id">{t('smartCharging.profileId')}</Label>
                <Input
                  id="sc-profile-id"
                  type="number"
                  min={1}
                  value={profileId}
                  onChange={(e) => {
                    setProfileId(parseInt(e.target.value, 10) || 100);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sc-stack-level">{t('smartCharging.stackLevel')}</Label>
                <Input
                  id="sc-stack-level"
                  type="number"
                  min={0}
                  value={stackLevel}
                  onChange={(e) => {
                    setStackLevel(parseInt(e.target.value, 10) || 0);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sc-evse-id">{t('smartCharging.evseId')}</Label>
                <Input
                  id="sc-evse-id"
                  type="number"
                  min={0}
                  value={evseId}
                  onChange={(e) => {
                    setEvseId(parseInt(e.target.value, 10) || 0);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sc-rate-unit">{t('smartCharging.chargingRateUnit')}</Label>
                <Select
                  id="sc-rate-unit"
                  value={chargingRateUnit}
                  onChange={(e) => {
                    setChargingRateUnit(e.target.value as 'W' | 'A');
                  }}
                >
                  <option value="W">W (Watts)</option>
                  <option value="A">A (Amperes)</option>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="sc-start-schedule">{t('smartCharging.startSchedule')}</Label>
                <Input
                  id="sc-start-schedule"
                  type="datetime-local"
                  value={startSchedule}
                  onChange={(e) => {
                    setStartSchedule(e.target.value);
                  }}
                  className={hasSubmitted && errors.startSchedule ? 'border-destructive' : ''}
                />
                {hasSubmitted && errors.startSchedule && (
                  <p className="text-sm text-destructive">{errors.startSchedule}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="sc-valid-from">{t('smartCharging.validFrom')}</Label>
                <Input
                  id="sc-valid-from"
                  type="datetime-local"
                  value={validFrom}
                  onChange={(e) => {
                    setValidFrom(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sc-valid-to">{t('smartCharging.validTo')}</Label>
                <Input
                  id="sc-valid-to"
                  type="datetime-local"
                  value={validTo}
                  onChange={(e) => {
                    setValidTo(e.target.value);
                  }}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="sc-duration">{t('smartCharging.durationSeconds')}</Label>
              <Input
                id="sc-duration"
                type="number"
                min={0}
                value={duration}
                placeholder="86400"
                onChange={(e) => {
                  setDuration(e.target.value);
                }}
                className="w-48"
              />
            </div>

            <TimeSlotEditor
              periods={schedulePeriods}
              onChange={setSchedulePeriods}
              rateUnit={chargingRateUnit}
            />

            <div className="space-y-2 pt-2">
              <h3 className="text-sm font-medium">{t('smartCharging.targetFilter')}</h3>
              <p className="text-xs text-muted-foreground">
                {t('configTemplates.targetFilterHelp')}
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="sc-filter-site">{t('configTemplates.site')}</Label>
                <Select
                  id="sc-filter-site"
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
                <Label htmlFor="sc-filter-vendor">{t('configTemplates.vendor')}</Label>
                <Select
                  id="sc-filter-vendor"
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
                <Label htmlFor="sc-filter-model">{t('configTemplates.model')}</Label>
                <Select
                  id="sc-filter-model"
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
                  void navigate('/smart-charging');
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
