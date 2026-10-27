// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { formatNumber } from '@/lib/formatting';
import type { QueryState } from './ChartBody';
import { SessionActivityChart, type SessionActivityData } from './SessionActivityChart';

export interface PlugAndChargeData extends SessionActivityData {
  /** Company-wide; null unless the user has all-site access and drivers:read. */
  activeContracts: number | null;
}

/** Plug and Charge sessions and energy per day, with the active contracts when shown. */
export function PlugAndChargeChart({
  data,
  actions,
  info,
  state,
}: {
  data: PlugAndChargeData | undefined;
  actions?: React.ReactNode | undefined;
  info?: string | undefined;
  state?: QueryState | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  const summary =
    data?.activeContracts != null
      ? [t('dashboard.activeContractsCount', { value: formatNumber(data.activeContracts, 0) })]
      : [];
  return (
    <SessionActivityChart
      title={t('dashboard.plugAndCharge')}
      summary={summary}
      data={data}
      actions={actions}
      info={info}
      emptyText={t('dashboard.noPlugAndChargeSessions')}
      state={state}
    />
  );
}
