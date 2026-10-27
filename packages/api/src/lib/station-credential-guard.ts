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
 * They refuse the heartbeat and meter value settings the boot push owns too
 * (400 `DATA_PLAN_SETTING_IN_TEMPLATE`): the data plan sets them at every boot.
 */

import { AppError, isBootOwnedStationSetting } from '@evtivity/lib';
import {
  holdsStationCredential,
  holdsUnmaskableUrlPassword,
  isCredentialName,
} from '@evtivity/lib/secret-config';
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

export const UNMASKABLE_URL_PASSWORD_MESSAGE =
  'A URL password must not hold spaces, tabs, line breaks or other control characters: encode them (%20) so the stored copies can mask the password';

/**
 * Throws 400 `VALIDATION_ERROR` when a string of a command payload or a
 * firmware URL holds a URL password the stored copies could not mask
 * (`urlPasswordUnmaskable`, `@evtivity/lib/secret-config`): a space or a
 * control character inside the userinfo, which a station parser reads as part
 * of the password while the masker ends the URL there.
 */
export function assertMaskableUrlPasswords(payload: unknown): void {
  if (holdsUnmaskableUrlPassword(payload)) {
    throw new AppError(UNMASKABLE_URL_PASSWORD_MESSAGE, 400, ERROR_CODES.VALIDATION_ERROR);
  }
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

export const DATA_PLAN_SETTING_IN_TEMPLATE_MESSAGE =
  'Heartbeat and meter value settings come from Settings > Integrations & Features > OCPP and the station data plan, not from a configuration template';

/** A template names a boot-owned station setting; `variables` lists the refused names. */
export class DataPlanSettingInTemplateError extends AppError {
  public readonly variables: string[];

  constructor(variables: string[]) {
    super(DATA_PLAN_SETTING_IN_TEMPLATE_MESSAGE, 400, ERROR_CODES.DATA_PLAN_SETTING_IN_TEMPLATE);
    this.name = 'DataPlanSettingInTemplateError';
    this.variables = variables;
  }
}

/**
 * Throws when configuration template variables name a setting the boot push
 * owns (`BOOT_OWNED_STATION_SETTINGS`: the heartbeat interval and the meter
 * value settings), which the station data plan sets at every boot. Names are
 * compared trimmed; the variable instance does not matter. The refused names
 * (`Component.Variable` on 2.x, the key on 1.6) go in `details.variables`.
 */
export function assertNoBootOwnedVariables(
  ocppVersion: string,
  variables: readonly { component?: string; variable: string }[],
): void {
  const refused = variables
    .filter((v) => isBootOwnedStationSetting(ocppVersion, v.component ?? '', v.variable))
    .map((v) => {
      const component = (v.component ?? '').trim();
      const variable = v.variable.trim();
      return ocppVersion === '1.6' || component === '' ? variable : `${component}.${variable}`;
    });
  if (refused.length > 0) throw new DataPlanSettingInTemplateError([...new Set(refused)]);
}
