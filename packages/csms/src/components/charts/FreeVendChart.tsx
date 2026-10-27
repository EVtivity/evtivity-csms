// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { formatNumber } from '@/lib/formatting';
import type { QueryState } from './ChartBody';
import { SessionActivityChart, type SessionActivityData } from './SessionActivityChart';

export interface FreeVendData extends SessionActivityData {
  freeVendSiteCount: number;
}

/** Free vend sessions and energy per day, with the sites that have free vend on. */
export function FreeVendChart({
  data,
  actions,
  info,
  state,
}: {
  data: FreeVendData | undefined;
  actions?: React.ReactNode | undefined;
  info?: string | undefined;
  state?: QueryState | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  const summary =
    data != null
      ? [t('dashboard.freeVendSites', { value: formatNumber(data.freeVendSiteCount, 0) })]
      : [];
  return (
    <SessionActivityChart
      title={t('dashboard.freeVend')}
      summary={summary}
      data={data}
      actions={actions}
      info={info}
      emptyText={t('dashboard.noFreeVendSessions')}
      state={state}
    />
  );
}
