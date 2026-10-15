// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Station credentials change only through the station security service
 * (`POST /v1/stations/:id/credentials`, `features/station-security.md`, P3):
 * it stores the new hash only when the station accepts, so the station and
 * the CSMS never disagree on the password. The generic command routes and
 * configuration templates refuse a credential write with 400
 * `STATION_CREDENTIALS_ROUTE_REQUIRED`: 2.1 SetVariables
 * `SecurityCtrlr.BasicAuthPassword`, 1.6 ChangeConfiguration `AuthorizationKey`,
 * SetNetworkProfile `connectionData.basicAuthPassword`. The name rule is the
 * shared one (`@evtivity/lib/secret-config`). Configuration templates also
 * refuse security and network profile variables (400
 * `STATION_SECURITY_ROUTE_REQUIRED`): a fleet push of them locks stations out.
 */

import { AppError } from '@evtivity/lib';
import { holdsStationCredential, isCredentialName } from '@evtivity/lib/secret-config';
import { ERROR_CODES } from './error-codes.generated.js';

/** The OCPP commands that write station configuration. */
export const CONFIGURATION_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  'SetVariables',
  'ChangeConfiguration',
  'SetNetworkProfile',
]);

export const STATION_CREDENTIALS_ROUTE_MESSAGE =
  'Station passwords are changed with POST /v1/stations/:id/credentials, not with a generic OCPP command';

function refuse(): never {
  throw new AppError(
    STATION_CREDENTIALS_ROUTE_MESSAGE,
    400,
    ERROR_CODES.STATION_CREDENTIALS_ROUTE_REQUIRED,
  );
}

/** Throws when a generic configuration write command carries a station credential. */
export function assertNoStationCredentialWrite(
  action: string,
  payload: Record<string, unknown>,
): void {
  if (CONFIGURATION_WRITE_ACTIONS.has(action) && holdsStationCredential(payload)) refuse();
}

export const STATION_SECURITY_ROUTE_MESSAGE =
  'Station security profiles and network profiles are changed with PATCH /v1/stations/:id, not with a configuration template';

/**
 * Whether a configuration variable sets the station's security profile or its
 * network connection: 1.6 `SecurityProfile`, 2.1 `SecurityCtrlr.SecurityProfile`,
 * `OCPPCommCtrlr.NetworkConfigurationPriority` and any `NetworkConfiguration`
 * variable. Pushed from a template they skip the pending profile the
 * connection auth needs (A05.FR.06-07), so the station reconnects with a
 * profile or a CSMS URL the CSMS refuses and is locked out.
 */
export function isStationSecurityVariable(
  component: string | undefined,
  variable: string,
): boolean {
  const name = normalizeName(variable);
  const comp = normalizeName(component ?? '');
  if (comp === 'networkconfiguration') return true;
  if (name === 'securityprofile') return comp === '' || comp === 'securityctrlr';
  if (name === 'networkconfigurationpriority') return comp === '' || comp === 'ocppcommctrlr';
  return false;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Throws when configuration template variables name a station credential
 * (`STATION_CREDENTIALS_ROUTE_REQUIRED`) or a security or network profile
 * setting (`STATION_SECURITY_ROUTE_REQUIRED`). Names are compared trimmed, so
 * a trailing space does not slip a credential past the name rule.
 */
export function assertNoCredentialVariables(
  variables: readonly { component?: string; variable: string }[],
): void {
  if (variables.some((v) => isCredentialName(v.variable.trim()))) refuse();
  if (variables.some((v) => isStationSecurityVariable(v.component, v.variable))) {
    throw new AppError(
      STATION_SECURITY_ROUTE_MESSAGE,
      400,
      ERROR_CODES.STATION_SECURITY_ROUTE_REQUIRED,
    );
  }
}
