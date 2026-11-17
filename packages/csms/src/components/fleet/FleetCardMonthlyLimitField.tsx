// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { centsToMajorInput, parseMajorInputToCents } from '@evtivity/lib/currency';
import { FLEET_CARD_MONTHLY_LIMIT_MAX_CENTS } from '@evtivity/lib/fleet-card';
import { DecimalInput } from '@/components/ui/decimal-input';
import { Label } from '@/components/ui/label';
import { formatCents } from '@/lib/formatting';

/**
 * The monthly limit typed in major units: null for an empty field (no
 * limit), the cents of a value from 0.01 to 1,000,000.00, else 'invalid'.
 */
export function parseMonthlyLimitInput(text: string): number | null | 'invalid' {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const cents = parseMajorInputToCents(trimmed);
  if (cents == null || cents < 1 || cents > FLEET_CARD_MONTHLY_LIMIT_MAX_CENTS) return 'invalid';
  return cents;
}

/** The field text of a stored limit (empty for none). */
export function monthlyLimitInput(limitCents: number | null): string {
  return limitCents == null ? '' : centsToMajorInput(limitCents);
}

/**
 * "12.50 of 100.00" for a card with a limit, else what it spent this month.
 * Without the spend (no payments:read, or a site-restricted operator) only
 * the limit shows.
 */
export function FleetCardMonthSpend({
  spentCents,
  limitCents,
  currency,
}: {
  spentCents: number | null;
  limitCents: number | null;
  currency: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  if (spentCents == null) {
    return (
      <span className={limitCents == null ? 'text-muted-foreground' : undefined}>
        {limitCents == null ? t('common.na') : formatCents(limitCents, currency)}
      </span>
    );
  }
  if (limitCents == null) {
    return (
      <span>
        {formatCents(spentCents, currency)}{' '}
        <span className="text-muted-foreground">{t('fleets.cards.monthlyLimit.none')}</span>
      </span>
    );
  }
  const reached = spentCents >= limitCents;
  return (
    <span className={reached ? 'text-destructive' : undefined}>
      {t('fleets.cards.monthlyLimit.spentOfLimit', {
        spent: formatCents(spentCents, currency),
        limit: formatCents(limitCents, currency),
      })}
    </span>
  );
}

/** The optional monthly spending limit of a fleet card, in major units of the company currency. */
export function FleetCardMonthlyLimitField({
  id,
  value,
  onChange,
  currency,
  error,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  currency: string;
  error: string | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>
        {t('fleets.cards.monthlyLimit.label')}
        {currency !== '' ? ` (${currency})` : ''}
      </Label>
      <DecimalInput
        id={id}
        value={value}
        onChange={onChange}
        decimalScale={2}
        aria-describedby={`${id}-hint`}
        aria-invalid={error != null ? true : undefined}
        className={error != null ? 'border-destructive' : ''}
      />
      {error != null && <p className="text-sm text-destructive">{error}</p>}
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {t('fleets.cards.monthlyLimit.hint')}
      </p>
    </div>
  );
}
