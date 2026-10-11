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
 * shared one (`@evtivity/lib/secret-config`).
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

/** Throws when configuration template variables name a station credential. */
export function assertNoCredentialVariables(
  variables: readonly { component?: string; variable: string }[],
): void {
  if (variables.some((v) => isCredentialName(v.variable))) refuse();
}
