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

/** The stations a config template targets, as the fields a station must match. */
export interface ConfigTemplateTarget {
  stationId?: string;
  siteId?: string;
  vendorId?: string;
  model?: string;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Resolve what a config template targets. A template bound to a station (the
 * per-station template, `config_templates.station_id`) targets that station
 * only, whatever its target filter says. Other templates target the stations
 * matching every field of their target filter; a template without a filter
 * targets every station. Push, matching-station previews and drift detection
 * all use this, so a bound template never reaches another station.
 */
export function configTemplateTarget(template: {
  stationId: string | null;
  targetFilter: unknown;
}): ConfigTemplateTarget {
  if (template.stationId != null) return { stationId: template.stationId };
  const filter =
    template.targetFilter != null && typeof template.targetFilter === 'object'
      ? (template.targetFilter as Record<string, unknown>)
      : {};
  const target: ConfigTemplateTarget = {};
  const stationId = nonEmpty(filter['stationId']);
  const siteId = nonEmpty(filter['siteId']);
  const vendorId = nonEmpty(filter['vendorId']);
  const model = nonEmpty(filter['model']);
  if (stationId != null) target.stationId = stationId;
  if (siteId != null) target.siteId = siteId;
  if (vendorId != null) target.vendorId = vendorId;
  if (model != null) target.model = model;
  return target;
}

/** True when the station is one of the stations the config template targets. */
export function configTemplateMatchesStation(
  template: { stationId: string | null; targetFilter: unknown },
  station: { id: string; siteId: string | null; vendorId: string | null; model: string | null },
): boolean {
  const target = configTemplateTarget(template);
  if (target.stationId != null && target.stationId !== station.id) return false;
  if (target.siteId != null && target.siteId !== station.siteId) return false;
  if (target.vendorId != null && target.vendorId !== station.vendorId) return false;
  if (target.model != null && target.model !== station.model) return false;
  return true;
}
