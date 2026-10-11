// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCanExplain, useOpenExplain } from '../ExplainButton';
import type { AiPanelContext } from '../use-ai-panel-store';
import { InsightCard } from './InsightCard';
import type { InsightFilter } from './insight-api';
import { pickShownInsight, useInsights } from './insight-api';

interface RecordInsightProps {
  filter: InsightFilter;
  /** The record "Ask a follow-up" opens the assistant about. */
  context?: AiPanelContext | undefined;
  className?: string;
}

/**
 * The insight card on a record's page (station, session): the active or
 * analyzing insight, or one resolved within a day. Renders nothing without
 * `aiInsights:read` or without such an insight.
 */
export function RecordInsight({
  filter,
  context,
  className,
}: RecordInsightProps): React.JSX.Element | null {
  const { insights } = useInsights(filter);
  const canExplain = useCanExplain();
  const open = useOpenExplain();
  const shown = pickShownInsight(insights);
  if (shown == null) return null;
  return (
    <InsightCard
      insight={shown}
      className={className}
      onFollowUp={
        canExplain && context != null
          ? () => {
              open(context, null);
            }
          : undefined
      }
    />
  );
}
