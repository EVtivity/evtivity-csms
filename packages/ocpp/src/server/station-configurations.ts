// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { REDACTED, isCredentialName } from '@evtivity/lib/secret-config';

/** One station-reported variable attribute (OCPP 2.1 device model or 1.6 key). */
export interface StationConfigurationValue {
  stationUuid: string;
  component: string;
  componentInstance: string | null;
  evseId: number | null;
  connectorId: number | null;
  variable: string;
  variableInstance: string | null;
  value: string | null;
  attributeType: string;
  source: 'NotifyReport' | 'GetVariables' | 'GetConfiguration';
  /**
   * The unit and monitoring support a NotifyReport gave in its
   * variableCharacteristics. Without it the stored ones are kept.
   */
  characteristics?: { unit: string | null; supportsMonitoring: boolean | null };
}

/**
 * Stores a reported value in station_configurations. A row is identified by
 * component (+ instance), variable (+ instance), EVSE, connector, and
 * attribute type, matching uq_station_configurations_identity, so
 * DeviceDataCtrlr.ItemsPerMessage[GetReport] and [GetVariables] are separate rows.
 */
export async function upsertStationConfiguration(
  sql: postgres.Sql,
  reported: StationConfigurationValue,
): Promise<void> {
  // A credential a station reports (BasicAuthPassword, AuthorizationKey) is
  // stored as `[redacted]`; compliant stations report none (write-only).
  const v =
    reported.value != null && reported.value !== '' && isCredentialName(reported.variable)
      ? { ...reported, value: REDACTED }
      : reported;
  if (v.characteristics == null) {
    await sql`
      INSERT INTO station_configurations (station_id, component, instance, evse_id, connector_id, variable, variable_instance, value, attribute_type, source)
      VALUES (${v.stationUuid}, ${v.component}, ${v.componentInstance}, ${v.evseId}, ${v.connectorId}, ${v.variable}, ${v.variableInstance}, ${v.value}, ${v.attributeType}, ${v.source})
      ON CONFLICT (station_id, component, (COALESCE(instance, '')), variable, (COALESCE(variable_instance, '')), (COALESCE(evse_id, -1)), (COALESCE(connector_id, -1)), attribute_type)
      DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, updated_at = now()
    `;
    return;
  }
  const { unit, supportsMonitoring } = v.characteristics;
  await sql`
    INSERT INTO station_configurations (station_id, component, instance, evse_id, connector_id, variable, variable_instance, value, attribute_type, source, unit, supports_monitoring)
    VALUES (${v.stationUuid}, ${v.component}, ${v.componentInstance}, ${v.evseId}, ${v.connectorId}, ${v.variable}, ${v.variableInstance}, ${v.value}, ${v.attributeType}, ${v.source}, ${unit}, ${supportsMonitoring})
    ON CONFLICT (station_id, component, (COALESCE(instance, '')), variable, (COALESCE(variable_instance, '')), (COALESCE(evse_id, -1)), (COALESCE(connector_id, -1)), attribute_type)
    DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, unit = EXCLUDED.unit,
      supports_monitoring = EXCLUDED.supports_monitoring, updated_at = now()
  `;
}

/**
 * The unit and monitoring support of a NotifyReport entry's
 * variableCharacteristics, or null when the entry has none.
 */
export function reportedCharacteristics(
  value: unknown,
): { unit: string | null; supportsMonitoring: boolean | null } | null {
  if (value == null || typeof value !== 'object') return null;
  const characteristics = value as { unit?: unknown; supportsMonitoring?: unknown };
  return {
    unit:
      typeof characteristics.unit === 'string' && characteristics.unit !== ''
        ? characteristics.unit
        : null,
    supportsMonitoring:
      typeof characteristics.supportsMonitoring === 'boolean'
        ? characteristics.supportsMonitoring
        : null,
  };
}
