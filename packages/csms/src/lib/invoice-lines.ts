// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';
import { formatNumber } from '@/lib/formatting';

const COMPONENT_KINDS = [
  'energy',
  'time',
  'sessionFee',
  'idleFee',
  'reservationFee',
  'cancellationFee',
  'noShowFee',
] as const;
type ComponentKind = (typeof COMPONENT_KINDS)[number];

function isComponentKind(value: unknown): value is ComponentKind {
  return (COMPONENT_KINDS as readonly unknown[]).includes(value);
}

/**
 * Localized line item description from its metadata. Line items without a
 * known kind keep their stored description.
 */
export function describeInvoiceLine(
  item: { description: string; metadata: Record<string, unknown> | null },
  t: TFunction,
  locale: string,
): string {
  const meta = item.metadata;
  if (meta == null) return item.description;
  const kind = meta['kind'];
  if (kind === 'session') {
    const energyWh = typeof meta['energyWh'] === 'number' ? meta['energyWh'] : 0;
    const rawDate = typeof meta['sessionDate'] === 'string' ? meta['sessionDate'] : '';
    const parsed = new Date(`${rawDate}T00:00:00Z`);
    const date = Number.isNaN(parsed.getTime())
      ? rawDate
      : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(parsed);
    const line = t('invoices.sessionLine', { date, kwh: formatNumber(energyWh / 1000, 2) });
    // A fleet invoice line names the station; its driver heads the group.
    const station = typeof meta['stationName'] === 'string' ? meta['stationName'] : '';
    return station !== '' ? `${line} · ${station}` : line;
  }
  if (!isComponentKind(kind)) return item.description;
  const label = t(`invoices.lineKinds.${kind}`);
  // A fleet invoice shows a session's idle fee as its own line with the
  // billable idle minutes.
  if (kind === 'idleFee' && typeof meta['idleMinutes'] === 'number') {
    return t('invoices.idleFeeLine', { label, minutes: formatNumber(meta['idleMinutes'], 0) });
  }
  return typeof meta['segment'] === 'number'
    ? t('invoices.segmentLine', { n: meta['segment'], label })
    : label;
}
