// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** The charging point fields a session list or detail returns. */
export interface ChargingPointPathInput {
  siteName?: string | null;
  stationName?: string | null;
  unitName?: string | null;
  evseId?: number | null;
  connectorId?: number | null;
  connectorType?: string | null;
}

export interface ChargingPointPathLabels {
  /** "EVSE 5" for an EVSE number. */
  evse: (id: number) => string;
  /** "Connector 1", used only when the connector type is unknown. */
  connector: (id: number) => string;
  /** The display name of a connector type ("CCS2", "Type 2"). */
  connectorType: (type: string) => string;
}

export interface ChargingPointPathOptions {
  /** Leave the site out (a list of one site's sessions). */
  hideSite?: boolean;
  /** Leave the site and station out (a list of one station's sessions). */
  hideStation?: boolean;
}

/**
 * The parts of a session's charging point path, Site / Station / Unit / EVSE /
 * Connector, without the parts it does not have. The connector shows by its
 * type, else by its number.
 */
export function chargingPointPathParts(
  input: ChargingPointPathInput,
  labels: ChargingPointPathLabels,
  options: ChargingPointPathOptions = {},
): string[] {
  const parts: string[] = [];
  const hideStation = options.hideStation === true;
  if (!hideStation && options.hideSite !== true && nonEmpty(input.siteName)) {
    parts.push(input.siteName);
  }
  if (!hideStation && nonEmpty(input.stationName)) parts.push(input.stationName);
  if (nonEmpty(input.unitName)) parts.push(input.unitName);
  if (input.evseId != null) parts.push(labels.evse(input.evseId));
  if (nonEmpty(input.connectorType)) {
    parts.push(labels.connectorType(input.connectorType));
  } else if (input.connectorId != null) {
    parts.push(labels.connector(input.connectorId));
  }
  return parts;
}

export const CHARGING_POINT_PATH_SEPARATOR = ' / ';

/** The path as one line ("Parkhaus Lindenhof / EM4-MASTER-01 / Box 3 / EVSE 5 / CCS2"). */
export function chargingPointPath(
  input: ChargingPointPathInput,
  labels: ChargingPointPathLabels,
  options: ChargingPointPathOptions = {},
): string {
  return chargingPointPathParts(input, labels, options).join(CHARGING_POINT_PATH_SEPARATOR);
}

function nonEmpty(value: string | null | undefined): value is string {
  return value != null && value.trim() !== '';
}
