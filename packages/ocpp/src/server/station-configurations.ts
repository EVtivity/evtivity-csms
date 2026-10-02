// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';

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
}

/**
 * Stores a reported value in station_configurations. A row is identified by
 * component (+ instance), variable (+ instance), EVSE, connector, and
 * attribute type, matching uq_station_configurations_identity, so
 * DeviceDataCtrlr.ItemsPerMessage[GetReport] and [GetVariables] are separate rows.
 */
export async function upsertStationConfiguration(
  sql: postgres.Sql,
  v: StationConfigurationValue,
): Promise<void> {
  await sql`
    INSERT INTO station_configurations (station_id, component, instance, evse_id, connector_id, variable, variable_instance, value, attribute_type, source)
    VALUES (${v.stationUuid}, ${v.component}, ${v.componentInstance}, ${v.evseId}, ${v.connectorId}, ${v.variable}, ${v.variableInstance}, ${v.value}, ${v.attributeType}, ${v.source})
    ON CONFLICT (station_id, component, (COALESCE(instance, '')), variable, (COALESCE(variable_instance, '')), (COALESCE(evse_id, -1)), (COALESCE(connector_id, -1)), attribute_type)
    DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, updated_at = now()
  `;
}
