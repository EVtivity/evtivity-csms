// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';

export interface TariffRestrictions {
  timeRange?: { startTime: string; endTime: string };
  daysOfWeek?: number[];
  dateRange?: { startDate: string; endDate: string };
  holidays?: boolean;
  energyThresholdKwh?: number;
}

export const RESTRICTION_TYPES = [
  'default',
  'time',
  'dayTime',
  'seasonal',
  'holiday',
  'energy',
] as const;

export type RestrictionType = (typeof RESTRICTION_TYPES)[number];

export function isRestrictionType(value: string): value is RestrictionType {
  return (RESTRICTION_TYPES as readonly string[]).includes(value);
}

export interface RestrictionLabels {
  none: string;
  holiday: string;
  allDay: string;
  notAvailable: string;
  /** Day names indexed Sunday (0) to Saturday (6). */
  dayNames: readonly string[];
  energyAbove: (kwh: number) => string;
}

export interface RestrictionFields {
  startTime: string;
  endTime: string;
  allDay: boolean;
  days: number[];
  startDate: string;
  endDate: string;
  thresholdKwh: string;
}

export function deriveRestrictionType(restrictions: TariffRestrictions | null): RestrictionType {
  if (restrictions == null) return 'default';
  if (restrictions.energyThresholdKwh != null) return 'energy';
  if (restrictions.holidays === true) return 'holiday';
  if (restrictions.dateRange != null) return 'seasonal';
  if (restrictions.daysOfWeek != null) return 'dayTime';
  if (restrictions.timeRange != null) return 'time';
  return 'default';
}

/**
 * Restrictions sent to the API for the chosen tariff type. Days without a time
 * range (all day) send `daysOfWeek` only. The API derives the default flag.
 */
export function buildRestrictions(
  type: RestrictionType,
  fields: RestrictionFields,
): TariffRestrictions | null {
  switch (type) {
    case 'default':
      return null;
    case 'time':
      return { timeRange: { startTime: fields.startTime, endTime: fields.endTime } };
    case 'dayTime':
      return fields.allDay
        ? { daysOfWeek: fields.days }
        : {
            daysOfWeek: fields.days,
            timeRange: { startTime: fields.startTime, endTime: fields.endTime },
          };
    case 'seasonal':
      return { dateRange: { startDate: fields.startDate, endDate: fields.endDate } };
    case 'holiday':
      return { holidays: true };
    case 'energy':
      return { energyThresholdKwh: parseFloat(fields.thresholdKwh) };
  }
}

export function formatRestrictionSummary(
  restrictions: TariffRestrictions | null,
  labels: RestrictionLabels,
): string {
  if (restrictions == null) return labels.none;
  if (restrictions.energyThresholdKwh != null) {
    return labels.energyAbove(restrictions.energyThresholdKwh);
  }
  if (restrictions.holidays === true) return labels.holiday;
  if (restrictions.dateRange != null) {
    return `${restrictions.dateRange.startDate} - ${restrictions.dateRange.endDate}`;
  }
  const parts: string[] = [];
  if (restrictions.daysOfWeek != null) {
    const names = [...restrictions.daysOfWeek]
      .sort((a, b) => a - b)
      .map((d) => labels.dayNames[d])
      .filter((s): s is string => s != null);
    if (names.length > 0) parts.push(names.join(', '));
  }
  if (restrictions.timeRange != null) {
    parts.push(`${restrictions.timeRange.startTime} - ${restrictions.timeRange.endTime}`);
  } else if (restrictions.daysOfWeek != null) {
    parts.push(labels.allDay);
  }
  return parts.length > 0 ? parts.join(' ') : labels.notAvailable;
}

/** Translated labels for `formatRestrictionSummary`. */
export function useRestrictionLabels(): RestrictionLabels {
  const { t } = useTranslation();
  return {
    none: t('pricing.noRestrictions'),
    holiday: t('pricing.holiday'),
    allDay: t('pricing.allDay'),
    notAvailable: t('common.na'),
    dayNames: [
      t('pricing.sunday'),
      t('pricing.monday'),
      t('pricing.tuesday'),
      t('pricing.wednesday'),
      t('pricing.thursday'),
      t('pricing.friday'),
      t('pricing.saturday'),
    ],
    energyAbove: (kwh) => t('pricing.aboveKwh', { kwh }),
  };
}
