// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import type { TariffChargingType } from '@evtivity/lib/tariff-scope';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertTriangle } from 'lucide-react';
import { DecimalInput } from '@/components/ui/decimal-input';
import { Label } from '@/components/ui/label';
import { formatNumberUpTo } from '@/lib/formatting';
import { TariffSitesSummary } from './TariffScopeFields';

const MIN_CURRENT_A = 6;
const MAX_CURRENT_A = 500;

/** The validation error key of a Max Current value, or null (empty means no limit). */
export function tariffCurrentLimitError(value: string): 'pricing.maxCurrentRange' | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < MIN_CURRENT_A || n > MAX_CURRENT_A) {
    return 'pricing.maxCurrentRange';
  }
  return Math.abs(n * 10 - Math.round(n * 10)) < 1e-9 ? null : 'pricing.maxCurrentRange';
}

/** The `maxCurrentA` a tariff form sends: none on a DC tariff, null for an empty field. */
export function tariffCurrentLimitBody(
  value: string,
  chargingType: TariffChargingType,
): number | null {
  if (chargingType === 'dc' || value.trim() === '') return null;
  return Number(value);
}

/** Max Current of a tariff form. A DC tariff takes no current limit, so the field hides. */
export function TariffCurrentLimitField({
  value,
  onChange,
  chargingType,
  idPrefix,
  showError,
}: {
  value: string;
  onChange: (next: string) => void;
  chargingType: TariffChargingType;
  idPrefix: string;
  /** Show the validation error (after the first submit). */
  showError: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  if (chargingType === 'dc') return null;
  const error = showError ? tariffCurrentLimitError(value) : null;
  const hintId = `${idPrefix}-max-current-hint`;
  return (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-max-current`} className="leading-6">
        {t('pricing.maxCurrent')}
      </Label>
      <DecimalInput
        id={`${idPrefix}-max-current`}
        value={value}
        onChange={onChange}
        placeholder="16"
        aria-describedby={hintId}
        className={error != null ? 'border-destructive' : ''}
      />
      {error != null && <p className="text-sm text-destructive">{t(error)}</p>}
      <p id={hintId} className="text-xs text-muted-foreground">
        {chargingType === 'both'
          ? `${t('pricing.maxCurrentHint')} ${t('pricing.maxCurrentAcOnly')}`
          : t('pricing.maxCurrentHint')}
      </p>
    </div>
  );
}

/** A tariff's current limit as text: "16 A", or No limit. */
export function TariffCurrentLimitText({
  value,
}: {
  value: number | null | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      {value != null
        ? t('pricing.maxCurrentValue', { amps: formatNumberUpTo(value, 1) })
        : t('pricing.maxCurrentNone')}
    </>
  );
}

/** The sites a tariff reaches where load management is off, so its current limit is not enforced. */
export function TariffCurrentLimitNotEnforced({
  siteIds,
}: {
  siteIds: string[] | undefined;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  if (siteIds == null || siteIds.length === 0) return null;
  return (
    <Alert variant="warning" data-testid="tariff-limit-not-enforced">
      <AlertTriangle />
      <div>
        <AlertTitle>{t('pricing.maxCurrentNotEnforcedTitle')}</AlertTitle>
        <AlertDescription>
          {t('pricing.maxCurrentNotEnforced')} <TariffSitesSummary siteIds={siteIds} />
        </AlertDescription>
      </div>
    </Alert>
  );
}
