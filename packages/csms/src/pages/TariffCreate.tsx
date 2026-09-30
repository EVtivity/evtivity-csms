// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { Checkbox } from '@/components/ui/checkbox';
import { DecimalInput } from '@/components/ui/decimal-input';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { api, ApiError, getApiErrorFieldDetails } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

interface Tariff {
  id: string;
  pricingGroupId: string;
  name: string;
  pricePerKwh: string | null;
  pricePerMinute: string | null;
  pricePerSession: string | null;
  isActive: boolean;
  idleFeePricePerMinute: string | null;
  reservationFeePerMinute: string | null;
  taxRate: string | null;
  restrictions: Record<string, unknown> | null;
  priority: number;
  isDefault: boolean;
}

export function TariffCreate(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const [name, setName] = useState('');
  const [pricePerKwh, setPricePerKwh] = useState('');
  const [pricePerMinute, setPricePerMinute] = useState('');
  const [pricePerSession, setPricePerSession] = useState('');
  const [idleFeePricePerMinute, setIdleFeePricePerMinute] = useState('');
  const [reservationFeePerMinute, setReservationFeePerMinute] = useState('');
  const [taxRate, setTaxRate] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  // Restriction state
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

  const createMutation = useMutation({
    mutationFn: (body: {
      name: string;
      pricePerKwh?: string;
      pricePerMinute?: string;
      pricePerSession?: string;
      idleFeePricePerMinute?: string;
      reservationFeePerMinute?: string;
      taxRate?: string;
      restrictions?: Record<string, unknown> | null;
      isDefault?: boolean;
    }) => api.post<Tariff>(`/v1/pricing-groups/${id ?? ''}/tariffs`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pricing-groups', id ?? ''] });
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

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = t('validation.required');
    const prices = {
      pricePerKwh,
      pricePerMinute,
      pricePerSession,
      idleFeePricePerMinute,
      reservationFeePerMinute,
    };
    for (const [field, value] of Object.entries(prices)) {
      if (value.trim() !== '' && !Number.isFinite(Number(value))) {
        errors[field] = t('validation.invalidNumber');
      }
    }
    // Tax rate is a decimal fraction (0.19 = 19%), capped at 1 by the API.
    if (taxRate.trim() !== '') {
      if (!Number.isFinite(Number(taxRate))) errors.taxRate = t('validation.invalidNumber');
      else if (Number(taxRate) > 1) errors.taxRate = t('validation.max', { max: 1 });
    }
    return errors;
  }

  const errors = { ...getValidationErrors(), ...getApiErrorFieldDetails(createMutation.error) };

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const body: {
      name: string;
      pricePerKwh?: string;
      pricePerMinute?: string;
      pricePerSession?: string;
      idleFeePricePerMinute?: string;
      reservationFeePerMinute?: string;
      taxRate?: string;
      restrictions?: Record<string, unknown> | null;
      isDefault?: boolean;
    } = { name };
    if (pricePerKwh.trim() !== '') body.pricePerKwh = pricePerKwh;
    if (pricePerMinute.trim() !== '') body.pricePerMinute = pricePerMinute;
    if (pricePerSession.trim() !== '') body.pricePerSession = pricePerSession;
    if (idleFeePricePerMinute.trim() !== '') body.idleFeePricePerMinute = idleFeePricePerMinute;
    if (reservationFeePerMinute.trim() !== '')
      body.reservationFeePerMinute = reservationFeePerMinute;
    if (taxRate.trim() !== '') body.taxRate = taxRate;
    const { restrictions, isDefault } = buildRestrictions();
    body.restrictions = restrictions;
    body.isDefault = isDefault;
    createMutation.mutate(body);
  }

  const conflictMessage =
    createMutation.error instanceof ApiError && createMutation.error.status === 409
      ? getErrorMessage(createMutation.error, t)
      : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to={`/pricing/${id ?? ''}?tab=tariffs`} />
        <h1 className="text-2xl font-bold md:text-3xl">{t('pricing.createTariff')}</h1>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form
            onSubmit={handleSubmit}
            noValidate
            className="grid grid-cols-1 md:grid-cols-2 gap-4"
          >
            <div className="space-y-2">
              <Label htmlFor="tariff-name">{t('common.name')}</Label>
              <Input
                id="tariff-name"
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
              <Label htmlFor="tariff-kwh">{t('pricing.pricePerKwh')}</Label>
              <DecimalInput
                id="tariff-kwh"
                value={pricePerKwh}
                onChange={setPricePerKwh}
                placeholder="0.25"
                className={hasSubmitted && errors.pricePerKwh ? 'border-destructive' : ''}
              />
              {hasSubmitted && errors.pricePerKwh && (
                <p className="text-sm text-destructive">{errors.pricePerKwh}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="tariff-min">{t('pricing.pricePerMinute')}</Label>
              <DecimalInput
                id="tariff-min"
                value={pricePerMinute}
                onChange={setPricePerMinute}
                placeholder="0.05"
                className={hasSubmitted && errors.pricePerMinute ? 'border-destructive' : ''}
              />
              {hasSubmitted && errors.pricePerMinute && (
                <p className="text-sm text-destructive">{errors.pricePerMinute}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="tariff-session">{t('pricing.pricePerSession')}</Label>
              <DecimalInput
                id="tariff-session"
                value={pricePerSession}
                onChange={setPricePerSession}
                placeholder="1.00"
                className={hasSubmitted && errors.pricePerSession ? 'border-destructive' : ''}
              />
              {hasSubmitted && errors.pricePerSession && (
                <p className="text-sm text-destructive">{errors.pricePerSession}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="tariff-idle-fee">{t('pricing.idleFeePricePerMinute')}</Label>
              <DecimalInput
                id="tariff-idle-fee"
                value={idleFeePricePerMinute}
                onChange={setIdleFeePricePerMinute}
                placeholder="0.10"
                className={hasSubmitted && errors.idleFeePricePerMinute ? 'border-destructive' : ''}
              />
              {hasSubmitted && errors.idleFeePricePerMinute && (
                <p className="text-sm text-destructive">{errors.idleFeePricePerMinute}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="tariff-reservation-fee">{t('pricing.reservationFeePerMinute')}</Label>
              <DecimalInput
                id="tariff-reservation-fee"
                value={reservationFeePerMinute}
                onChange={setReservationFeePerMinute}
                placeholder="0.05"
                className={
                  hasSubmitted && errors.reservationFeePerMinute ? 'border-destructive' : ''
                }
              />
              {hasSubmitted && errors.reservationFeePerMinute && (
                <p className="text-sm text-destructive">{errors.reservationFeePerMinute}</p>
              )}
              <p className="text-xs text-muted-foreground">{t('pricing.reservationFeeHelper')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="tariff-tax-rate">{t('pricing.taxRate')}</Label>
              <DecimalInput
                id="tariff-tax-rate"
                value={taxRate}
                onChange={setTaxRate}
                placeholder="0.08"
                className={hasSubmitted && errors.taxRate ? 'border-destructive' : ''}
              />
              {hasSubmitted && errors.taxRate && (
                <p className="text-sm text-destructive">{errors.taxRate}</p>
              )}
              <p className="text-xs text-muted-foreground">{t('pricing.taxRateHelper')}</p>
            </div>

            <div className="col-span-full border-t pt-4 space-y-4">
              <p className="text-sm font-medium">{t('pricing.restrictions')}</p>
              <div className="space-y-2">
                <Label htmlFor="tariff-restriction-type">{t('pricing.tariffType')}</Label>
                <Select
                  id="tariff-restriction-type"
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
                    <Label htmlFor="tariff-start-time">{t('pricing.startTime')}</Label>
                    <Input
                      id="tariff-start-time"
                      type="time"
                      value={startTime}
                      onChange={(e) => {
                        setStartTime(e.target.value);
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="tariff-end-time">{t('pricing.endTime')}</Label>
                    <Input
                      id="tariff-end-time"
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
                      <label key={idx} className="flex items-center gap-1.5 text-sm cursor-pointer">
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
                    <Label htmlFor="tariff-start-date">{t('pricing.startDate')}</Label>
                    <Input
                      id="tariff-start-date"
                      value={startDate}
                      onChange={(e) => {
                        setStartDate(e.target.value);
                      }}
                      placeholder="MM-DD"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="tariff-end-date">{t('pricing.endDate')}</Label>
                    <Input
                      id="tariff-end-date"
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
                  <Label htmlFor="tariff-threshold">{t('pricing.thresholdKwh')}</Label>
                  <DecimalInput
                    id="tariff-threshold"
                    value={thresholdKwh}
                    onChange={setThresholdKwh}
                    placeholder="50"
                  />
                </div>
              )}
            </div>

            {conflictMessage != null && (
              <div className="col-span-full">
                <p className="text-sm text-destructive">{conflictMessage}</p>
              </div>
            )}

            <div className="col-span-full flex justify-end gap-2">
              <CancelButton
                onClick={() => {
                  void navigate(`/pricing/${id ?? ''}?tab=tariffs`);
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
