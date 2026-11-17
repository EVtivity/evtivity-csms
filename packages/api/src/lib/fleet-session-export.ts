// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { buildCsv, isUiLanguage, ValidationError } from '@evtivity/lib';
import type { UiLanguage } from '@evtivity/lib';

/** The longest start time range one fleet session export covers. */
export const FLEET_SESSION_EXPORT_MAX_DAYS = 366;

const DAY_MS = 86_400_000;

/**
 * The start time range of an export: `to` defaults to now and `from` to
 * `FLEET_SESSION_EXPORT_MAX_DAYS` before `to`; a longer range or a `from`
 * after `to` is refused (400 VALIDATION_ERROR).
 */
export function fleetSessionExportRange(
  query: { from: Date | null; to: Date | null },
  now: Date = new Date(),
): { from: Date; to: Date } {
  const to = query.to ?? now;
  const from = query.from ?? new Date(to.getTime() - FLEET_SESSION_EXPORT_MAX_DAYS * DAY_MS);
  if (from.getTime() > to.getTime()) {
    throw new ValidationError('"from" must be on or before "to"');
  }
  if (to.getTime() - from.getTime() > FLEET_SESSION_EXPORT_MAX_DAYS * DAY_MS) {
    throw new ValidationError(
      `The export covers at most ${String(FLEET_SESSION_EXPORT_MAX_DAYS)} days`,
    );
  }
  return { from, to };
}

/** What an export shows in place of an erased driver's name, in the exporting user's language. */
export const ERASED_DRIVER_LABELS: Record<UiLanguage, string> = {
  en: 'Erased driver',
  de: 'Gelöschter Fahrer',
  es: 'Conductor borrado',
  ko: '삭제된 운전자',
  zh: '已清除的驾驶员',
  'zh-TW': '已清除的駕駛員',
};

/** The erased driver label of a language; any other language reads English. */
export function erasedDriverLabel(language: string | null | undefined): string {
  return ERASED_DRIVER_LABELS[isUiLanguage(language) ? language : 'en'];
}

export interface FleetSessionExportRow {
  id: string;
  status: string;
  startedAt: Date | string | null;
  endedAt: Date | string | null;
  energyDeliveredWh: number | string | null;
  siteName: string | null;
  stationName: string | null;
  unitName: string | null;
  evseId: number | null;
  connectorId: number | null;
  connectorType: string | null;
  driverName: string | null;
  /** The driver was erased: the row shows only that, never a name. */
  driverErased: boolean;
  cardLabel: string | null;
  idToken: string | null;
  transactionId: string | null;
  currentCostCents: number | null;
  finalCostCents: number | null;
  currency: string | null;
}

/** What the columns of an export hold besides the session fields. */
export interface FleetSessionExportColumns {
  /** The cost and its currency (payments:read). */
  cost: boolean;
  /** The RFID card value and the OCPP transaction id (operators only). */
  operator: boolean;
  /** The exporting user's language, for the erased driver label. */
  language?: string | null | undefined;
}

function iso(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function kwh(wh: number | string | null): string | null {
  return wh == null ? null : (Number(wh) / 1000).toFixed(3);
}

function amount(row: FleetSessionExportRow): string | null {
  const cents = row.finalCostCents ?? row.currentCostCents;
  return cents == null ? null : (cents / 100).toFixed(2);
}

/** The CSV of a fleet session export, every text cell formula safe. */
export function fleetSessionsCsv(
  rows: readonly FleetSessionExportRow[],
  columns: FleetSessionExportColumns,
): string {
  const erased = erasedDriverLabel(columns.language);
  const headers = [
    'sessionId',
    'startedAt',
    'endedAt',
    'status',
    'site',
    'station',
    'unit',
    'evse',
    'connector',
    'connectorType',
    'driver',
    'cardLabel',
    'energyKwh',
    ...(columns.cost ? ['cost', 'currency'] : []),
    ...(columns.operator ? ['rfidCard', 'transactionId'] : []),
  ];
  return buildCsv(
    headers,
    rows.map((row) => [
      row.id,
      iso(row.startedAt),
      iso(row.endedAt),
      row.status,
      row.siteName,
      row.stationName,
      row.unitName,
      row.evseId,
      row.connectorId,
      row.connectorType,
      row.driverErased ? erased : row.driverName,
      row.cardLabel,
      kwh(row.energyDeliveredWh),
      ...(columns.cost ? [amount(row), row.currency] : []),
      ...(columns.operator ? [row.idToken, row.transactionId] : []),
    ]),
  );
}
