// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';
import { centsToMajorInput, parseMajorInputToCents } from '@evtivity/lib/currency';

/**
 * Pre-auth amounts are typed in the currency (major units) and stored in cents.
 * `limits` are the amounts in cents the API accepts.
 */
export function preAuthAmountError(
  value: string,
  t: TFunction,
  limits: { minCents?: number; maxCents?: number } = {},
): string | undefined {
  if (value.trim() === '') return t('validation.required');
  if (Number(value) < 0) return t('validation.min', { min: 0 });
  const cents = parseMajorInputToCents(value);
  if (cents == null) return t('validation.invalidNumber');
  const { minCents = 0, maxCents } = limits;
  if (cents < minCents) return t('validation.min', { min: centsToMajorInput(minCents) });
  if (maxCents != null && cents > maxCents) {
    return t('validation.max', { max: centsToMajorInput(maxCents) });
  }
  return undefined;
}

export function percentError(value: string, t: TFunction, required: boolean): string | undefined {
  if (value.trim() === '') return required ? t('validation.required') : undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return t('validation.invalidNumber');
  if (n < 0) return t('validation.min', { min: 0 });
  if (n > 100) return t('validation.max', { max: 100 });
  return undefined;
}

/** A number typed into a field with an inclusive range; `integer` refuses fractions. */
export function rangeError(
  value: string,
  t: TFunction,
  range: { min: number; max: number; integer: boolean },
): string | undefined {
  if (value.trim() === '') return t('validation.required');
  const n = Number(value);
  if (!Number.isFinite(n) || (range.integer && !Number.isInteger(n))) {
    return t('validation.invalidNumber');
  }
  if (n < range.min) return t('validation.min', { min: range.min });
  if (n > range.max) return t('validation.max', { max: range.max });
  return undefined;
}
