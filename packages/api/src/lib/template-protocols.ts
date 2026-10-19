// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, inArray, type SQL } from 'drizzle-orm';
import { chargingStations, isOperatorStation } from '@evtivity/database';
import { ocpp201ChargingProfileRefusal } from '@evtivity/lib';
import { OCPP_PROTOCOLS, isOcpp2x } from '@evtivity/lib/ocpp-version';
import type { OcppProtocol } from '@evtivity/lib/ocpp-version';

/**
 * The station protocols a configuration or charging profile template of an
 * OCPP version reaches. A 2.1 template holds the OCPP 2.x model, so it also
 * reaches OCPP 2.0.1 stations.
 */
export function templateStationProtocols(ocppVersion: string): OcppProtocol[] {
  return OCPP_PROTOCOLS.filter((p) => (ocppVersion === '1.6' ? !isOcpp2x(p) : isOcpp2x(p)));
}

/** Whether a template of an OCPP version reaches a station of a protocol. */
export function templateReachesProtocol(
  ocppVersion: string,
  protocol: string | null | undefined,
): boolean {
  return ocppVersion === '1.6' ? protocol === 'ocpp1.6' : isOcpp2x(protocol);
}

/**
 * The station condition of a template's OCPP version. Conformance test
 * stations are never a template target, so the condition leaves them out.
 */
export function templateProtocolCondition(ocppVersion: string): SQL {
  const protocols = inArray(chargingStations.ocppProtocol, templateStationProtocols(ocppVersion));
  return and(protocols, isOperatorStation()) ?? protocols;
}

interface ChargingProfileTemplateShape {
  ocppVersion: string;
  profilePurpose: string;
  profileKind: string;
  schedulePeriods: unknown;
}

/**
 * Why an OCPP 2.0.1 station cannot take a 2.1 charging profile template, or
 * null when it can. The rules are the ones the OCPP server applies when it
 * sends the profile (`ocpp201ChargingProfileRefusal`, `@evtivity/lib`): no
 * purpose, kind or field only 2.1 defines, and every period a charging limit
 * (a negative limit is a 2.1 discharge limit).
 */
export function chargingProfileOcpp201Refusal(
  template: ChargingProfileTemplateShape,
): string | null {
  return ocpp201ChargingProfileRefusal({
    chargingProfilePurpose: template.profilePurpose,
    chargingProfileKind: template.profileKind,
    chargingSchedule: [
      {
        chargingSchedulePeriod: Array.isArray(template.schedulePeriods)
          ? template.schedulePeriods
          : [],
      },
    ],
  });
}

/** Whether an OCPP 2.0.1 station can take a 2.1 charging profile template. */
export function chargingProfileFitsOcpp201(template: ChargingProfileTemplateShape): boolean {
  return chargingProfileOcpp201Refusal(template) == null;
}

/** The station protocols a charging profile template reaches: its version's, without 2.0.1 when it does not fit. */
export function chargingProfileTemplateProtocols(
  template: ChargingProfileTemplateShape,
): OcppProtocol[] {
  return templateStationProtocols(template.ocppVersion).filter(
    (p) => p !== 'ocpp2.0.1' || chargingProfileFitsOcpp201(template),
  );
}

/**
 * The station condition of a charging profile template (push, clear, matching
 * stations, counts). Conformance test stations are never a target.
 */
export function chargingProfileTemplateCondition(template: ChargingProfileTemplateShape): SQL {
  const protocols = inArray(
    chargingStations.ocppProtocol,
    chargingProfileTemplateProtocols(template),
  );
  return and(protocols, isOperatorStation()) ?? protocols;
}
