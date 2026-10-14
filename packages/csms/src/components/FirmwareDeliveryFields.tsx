// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  FIRMWARE_RETRIES_MAX,
  FIRMWARE_RETRY_INTERVAL_MAX_SECONDS,
} from '@evtivity/lib/firmware-campaign';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatDateTimeLocal } from '@/lib/reservation-datetime';

/**
 * Download retries, retry interval and install time of a firmware campaign, as
 * typed. Empty leaves the value to the station.
 */
export interface FirmwareDeliveryValue {
  retries: string;
  retryInterval: string;
  /** datetime-local value in the browser's time zone. */
  installDateTime: string;
}

export interface FirmwareDeliveryErrors {
  retries?: string;
  retryInterval?: string;
  installDateTime?: string;
}

export const EMPTY_FIRMWARE_DELIVERY: FirmwareDeliveryValue = {
  retries: '',
  retryInterval: '',
  installDateTime: '',
};

function wholeNumberIn(text: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(text)) return false;
  const n = Number(text);
  return n >= min && n <= max;
}

/** Field errors; empty when every field is empty or valid. */
export function getFirmwareDeliveryErrors(
  value: FirmwareDeliveryValue,
  t: TFunction,
  now: Date = new Date(),
): FirmwareDeliveryErrors {
  const errors: FirmwareDeliveryErrors = {};
  const retries = value.retries.trim();
  if (retries !== '' && !wholeNumberIn(retries, 0, FIRMWARE_RETRIES_MAX)) {
    errors.retries = t('firmwareCampaigns.invalidRetries', { max: FIRMWARE_RETRIES_MAX });
  }
  const interval = value.retryInterval.trim();
  if (interval !== '' && !wholeNumberIn(interval, 1, FIRMWARE_RETRY_INTERVAL_MAX_SECONDS)) {
    errors.retryInterval = t('firmwareCampaigns.invalidRetryInterval', {
      max: FIRMWARE_RETRY_INTERVAL_MAX_SECONDS,
    });
  }
  const install = value.installDateTime.trim();
  if (install !== '') {
    const at = new Date(install);
    if (!Number.isFinite(at.getTime()) || at.getTime() <= now.getTime()) {
      errors.installDateTime = t('firmwareCampaigns.installInPast');
    }
  }
  return errors;
}

/**
 * The fields to send. `clearEmpty` sends null for an empty field (an edit that
 * removes a value); otherwise an empty field is left out.
 */
export function firmwareDeliveryPayload(
  value: FirmwareDeliveryValue,
  clearEmpty: boolean,
): {
  retries?: number | null;
  retryInterval?: number | null;
  installDateTime?: string | null;
} {
  const retries = value.retries.trim();
  const interval = value.retryInterval.trim();
  const install = value.installDateTime.trim();
  const empty = clearEmpty ? null : undefined;
  const payload: {
    retries?: number | null;
    retryInterval?: number | null;
    installDateTime?: string | null;
  } = {};
  const r = retries !== '' ? Number(retries) : empty;
  const i = interval !== '' ? Number(interval) : empty;
  const d = install !== '' ? new Date(install).toISOString() : empty;
  if (r !== undefined) payload.retries = r;
  if (i !== undefined) payload.retryInterval = i;
  if (d !== undefined) payload.installDateTime = d;
  return payload;
}

/** The form value of a stored campaign. */
export function firmwareDeliveryValue(campaign: {
  retries: number | null;
  retryInterval: number | null;
  installDateTime: string | null;
}): FirmwareDeliveryValue {
  return {
    retries: campaign.retries != null ? String(campaign.retries) : '',
    retryInterval: campaign.retryInterval != null ? String(campaign.retryInterval) : '',
    installDateTime:
      campaign.installDateTime != null
        ? formatDateTimeLocal(new Date(campaign.installDateTime))
        : '',
  };
}

interface Props {
  value: FirmwareDeliveryValue;
  onChange: (value: FirmwareDeliveryValue) => void;
  idPrefix: string;
  errors?: FirmwareDeliveryErrors;
}

export function FirmwareDeliveryFields({
  value,
  onChange,
  idPrefix,
  errors = {},
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-retries`} className="leading-6">
          {t('firmwareCampaigns.retries')}
        </Label>
        <Input
          id={`${idPrefix}-retries`}
          type="number"
          inputMode="numeric"
          min={0}
          max={FIRMWARE_RETRIES_MAX}
          step={1}
          value={value.retries}
          onChange={(e) => {
            onChange({ ...value, retries: e.target.value });
          }}
          className={errors.retries != null ? 'border-destructive' : ''}
        />
        <p className="text-xs text-muted-foreground">{t('firmwareCampaigns.retriesHelp')}</p>
        {errors.retries != null && <p className="text-sm text-destructive">{errors.retries}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-retry-interval`} className="leading-6">
          {t('firmwareCampaigns.retryInterval')}
        </Label>
        <Input
          id={`${idPrefix}-retry-interval`}
          type="number"
          inputMode="numeric"
          min={1}
          max={FIRMWARE_RETRY_INTERVAL_MAX_SECONDS}
          step={1}
          value={value.retryInterval}
          onChange={(e) => {
            onChange({ ...value, retryInterval: e.target.value });
          }}
          className={errors.retryInterval != null ? 'border-destructive' : ''}
        />
        <p className="text-xs text-muted-foreground">{t('firmwareCampaigns.retryIntervalHelp')}</p>
        {errors.retryInterval != null && (
          <p className="text-sm text-destructive">{errors.retryInterval}</p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-install-date-time`} className="leading-6">
          {t('firmwareCampaigns.installDateTime')}
        </Label>
        <Input
          id={`${idPrefix}-install-date-time`}
          type="datetime-local"
          value={value.installDateTime}
          onChange={(e) => {
            onChange({ ...value, installDateTime: e.target.value });
          }}
          className={errors.installDateTime != null ? 'border-destructive' : ''}
        />
        <p className="text-xs text-muted-foreground">
          {t('firmwareCampaigns.installDateTimeHelp')}
        </p>
        {errors.installDateTime != null && (
          <p className="text-sm text-destructive">{errors.installDateTime}</p>
        )}
      </div>
    </div>
  );
}
