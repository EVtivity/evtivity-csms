// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Default OCPP variables pushed to stations when free vend is enabled.
 * Shared between the site toggle endpoint (auto-template creation) and the
 * boot re-push path in event-projections so the two paths cannot drift.
 */

export interface ConfigTemplateVariable {
  component: string;
  variable: string;
  value: string;
}

export const FREE_VEND_OCPP_21_VARIABLES: ConfigTemplateVariable[] = [
  { component: 'AuthCtrlr', variable: 'Enabled', value: 'false' },
  { component: 'TxCtrlr', variable: 'TxStartPoint', value: 'EVConnected' },
];

export const FREE_VEND_OCPP_16_KEYS: { key: string; value: string }[] = [
  { key: 'AllowOfflineTxForUnknownId', value: 'true' },
  { key: 'LocalPreAuthorize', value: 'true' },
  { key: 'LocalAuthorizeOffline', value: 'true' },
];

/**
 * Turning free vend off pushes authorization back (owner decision 2026-10-14).
 * The restore values are captured from the site's reported station
 * configuration when free vend is turned on (`freeVendRestoreVariables21`,
 * `freeVendRestoreKeys16`). The variables that grant free charging always go
 * back to the authorizing value: AuthCtrlr.Enabled true (2.1) and
 * AllowOfflineTxForUnknownId false (1.6).
 *
 * OCPP 2.1 defines no default TxCtrlr.TxStartPoint (a MemberList the station
 * chooses). When no station reported one, or the reported value is the free
 * vend start point itself (a leftover of an earlier free vend), the restore
 * uses PowerPathClosed: the transaction starts once the driver is authorized
 * and the cable is connected. OCPP 1.6 defines no defaults either: an unknown
 * LocalPreAuthorize restores to false and LocalAuthorizeOffline to true.
 */
export const FREE_VEND_RESTORE_TX_START_POINT = 'PowerPathClosed';

export const FREE_VEND_RESTORE_OCPP_16_DEFAULTS = {
  LocalPreAuthorize: 'false',
  LocalAuthorizeOffline: 'true',
} as const;

export type FreeVendRestoreKey16 = keyof typeof FREE_VEND_RESTORE_OCPP_16_DEFAULTS;

/** The 2.1 variables that restore authorization, from the reported TxStartPoint. */
export function freeVendRestoreVariables21(
  reportedTxStartPoint: string | null | undefined,
): ConfigTemplateVariable[] {
  const freeVendStartPoint = FREE_VEND_OCPP_21_VARIABLES.find(
    (v) => v.variable === 'TxStartPoint',
  )?.value;
  const reported = reportedTxStartPoint?.trim() ?? '';
  const txStartPoint =
    reported !== '' && reported !== freeVendStartPoint
      ? reported
      : FREE_VEND_RESTORE_TX_START_POINT;
  return [
    { component: 'AuthCtrlr', variable: 'Enabled', value: 'true' },
    { component: 'TxCtrlr', variable: 'TxStartPoint', value: txStartPoint },
  ];
}

/** The 1.6 keys that restore authorization, from the reported key values. */
export function freeVendRestoreKeys16(
  reported: Partial<Record<FreeVendRestoreKey16, string | null>>,
): ConfigTemplateVariable[] {
  const valueOf = (key: FreeVendRestoreKey16): string => {
    const value = reported[key]?.trim().toLowerCase();
    return value === 'true' || value === 'false' ? value : FREE_VEND_RESTORE_OCPP_16_DEFAULTS[key];
  };
  return [
    { key: 'AllowOfflineTxForUnknownId', value: 'false' },
    { key: 'LocalPreAuthorize', value: valueOf('LocalPreAuthorize') },
    { key: 'LocalAuthorizeOffline', value: valueOf('LocalAuthorizeOffline') },
  ].map((k) => ({ component: k.key, variable: k.key, value: k.value }));
}
