// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { formatNumber } from '@/lib/formatting';
import { UsageBar } from './UsageBar';
import { useMyAiUsage } from './usage-api';

/**
 * AI panel footer:
 * today's own tokens against the daily budget.
 */
export function AiUsageFooter(): React.JSX.Element | null {
  const { t } = useTranslation();
  const usage = useMyAiUsage(true);
  if (usage == null) return null;
  const { today } = usage;
  const text =
    today.limitTokens != null
      ? t('aiUsage.todayFooter', {
          used: formatNumber(today.usedTokens, 0),
          limit: formatNumber(today.limitTokens, 0),
        })
      : t('aiUsage.todayFooterNoLimit', { used: formatNumber(today.usedTokens, 0) });
  return (
    <div
      className="space-y-1 px-3 pb-2 text-xs text-muted-foreground"
      data-testid="ai-usage-footer"
    >
      <p>{text}</p>
      <UsageBar percent={today.percent} label={text} className="h-1" />
    </div>
  );
}
