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
