// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { createLogger } from '@evtivity/lib';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

const logger = createLogger('invoice-settings');

export const INVOICE_PAYMENT_TERMS_DAYS_KEY = 'invoice.paymentTermsDays';

/** Used when the setting is unset or invalid. */
export const DEFAULT_INVOICE_PAYMENT_TERMS_DAYS = 30;

/** Longest payment term an operator can store. */
export const MAX_INVOICE_PAYMENT_TERMS_DAYS = 365;

/**
 * The stored payment term when it is a whole number of days from 0 to
 * MAX_INVOICE_PAYMENT_TERMS_DAYS, else null. 0 makes an invoice due on issue.
 */
export function parseInvoicePaymentTermsDays(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 0 || value > MAX_INVOICE_PAYMENT_TERMS_DAYS) return null;
  return value;
}

const TTL_MS = 60_000;
let cachedValue: number | undefined;
let cachedAt = 0;

/**
 * Days from issue to the due date of a new invoice. 60 s cache; on a read
 * error the last value (or the default).
 */
export async function getInvoicePaymentTermsDays(): Promise<number> {
  const now = Date.now();
  if (cachedValue !== undefined && now - cachedAt < TTL_MS) return cachedValue;

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, INVOICE_PAYMENT_TERMS_DAYS_KEY));
    cachedValue = parseInvoicePaymentTermsDays(row?.value) ?? DEFAULT_INVOICE_PAYMENT_TERMS_DAYS;
    cachedAt = now;
    return cachedValue;
  } catch (err) {
    logger.warn(
      { err, key: INVOICE_PAYMENT_TERMS_DAYS_KEY },
      'getInvoicePaymentTermsDays failed, using the cached value or default',
    );
    return cachedValue ?? DEFAULT_INVOICE_PAYMENT_TERMS_DAYS;
  }
}

export const FLEET_INVOICE_RUN_DAY_KEY = 'fleet.invoiceRunDay';

/** Used when the setting is unset or invalid: the run bills on the 1st. */
export const DEFAULT_FLEET_INVOICE_RUN_DAY = 1;

/** Latest run day an operator can store: every month has it. */
export const MAX_FLEET_INVOICE_RUN_DAY = 28;

/**
 * The stored run day of the monthly fleet invoice run when it is a whole
 * number from 1 to MAX_FLEET_INVOICE_RUN_DAY, else null.
 */
export function parseFleetInvoiceRunDay(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 1 || value > MAX_FLEET_INVOICE_RUN_DAY) return null;
  return value;
}

let cachedRunDay: number | undefined;
let cachedRunDayAt = 0;

/**
 * The day of the month (system timezone) from which the monthly fleet invoice
 * run bills the previous month. 60 s cache; on a read error the last value
 * (or the default).
 */
export async function getFleetInvoiceRunDay(): Promise<number> {
  const now = Date.now();
  if (cachedRunDay !== undefined && now - cachedRunDayAt < TTL_MS) return cachedRunDay;

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, FLEET_INVOICE_RUN_DAY_KEY));
    cachedRunDay = parseFleetInvoiceRunDay(row?.value) ?? DEFAULT_FLEET_INVOICE_RUN_DAY;
    cachedRunDayAt = now;
    return cachedRunDay;
  } catch (err) {
    logger.warn(
      { err, key: FLEET_INVOICE_RUN_DAY_KEY },
      'getFleetInvoiceRunDay failed, using the cached value or default',
    );
    return cachedRunDay ?? DEFAULT_FLEET_INVOICE_RUN_DAY;
  }
}

/** Drops the cached invoice settings so the next read sees an operator change. */
export function clearInvoiceSettingsCache(): void {
  cachedValue = undefined;
  cachedAt = 0;
  cachedRunDay = undefined;
  cachedRunDayAt = 0;
}
