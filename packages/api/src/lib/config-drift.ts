// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** The station_configurations columns that identify a reported value. */
export interface ReportedConfiguration {
  component: string;
  instance: string | null;
  evseId: number | null;
  connectorId: number | null;
  variable: string;
  variableInstance: string | null;
  attributeType: string;
  value: string | null;
}

// OCPP 1.6 templates have no component; GetConfiguration values are stored
// under the 'OCPP' component.
const OCPP16_COMPONENT = 'OCPP';

/**
 * The reported row a config template variable sets. A template pushes
 * SetVariables (2.1) or ChangeConfiguration (1.6) without a component
 * instance, EVSE, or variable instance, to the Actual attribute, so only that
 * row is compared. Rows for other instances, EVSEs, or attribute types are
 * different variables.
 */
export function findTemplateTargetConfiguration<T extends ReportedConfiguration>(
  rows: readonly T[],
  component: string,
  variable: string,
): T | undefined {
  const storedComponent = component === '' ? OCPP16_COMPONENT : component;
  return rows.find(
    (r) =>
      r.component === storedComponent &&
      r.instance == null &&
      r.evseId == null &&
      r.connectorId == null &&
      r.variable === variable &&
      r.variableInstance == null &&
      r.attributeType === 'Actual',
  );
}
