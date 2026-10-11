// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCanExplain, useOpenExplain } from '../ExplainButton';
import type { AiPanelContext } from '../use-ai-panel-store';
import { InsightCard } from './InsightCard';
import type { AiInsightView } from './insight-api';
import { RECENT_INSIGHT_MS, useInsights } from './insight-api';

const SHOWN = 3;

function followUpContext(insight: AiInsightView): AiPanelContext | null {
  if (insight.sessionId != null) return { kind: 'session', id: insight.sessionId };
  if (insight.stationId != null) return { kind: 'station', id: insight.stationId };
  return null;
}

function isShown(insight: AiInsightView, now: number): boolean {
  if (insight.status === 'active' || insight.status === 'pending') return true;
  return (
    insight.status === 'resolved' &&
    insight.resolvedAt != null &&
    now - Date.parse(insight.resolvedAt) <= RECENT_INSIGHT_MS
  );
}

/**
 * Insights next to a support case: the case station and the linked
 * sessions the user can access. The API applies the support case access
 * rules (`supportCaseId` filter); this shows at most three.
 */
export function SupportCaseInsights({ caseId }: { caseId: string }): React.JSX.Element | null {
  const { insights } = useInsights({ supportCaseId: caseId });
  const canExplain = useCanExplain();
  const open = useOpenExplain();
  const now = Date.now();
  const shown = insights.filter((i) => isShown(i, now)).slice(0, SHOWN);
  if (shown.length === 0) return null;
  return (
    <div className="space-y-3" data-testid="ai-support-insights">
      {shown.map((insight) => {
        const context = followUpContext(insight);
        return (
          <InsightCard
            key={insight.id}
            insight={insight}
            onFollowUp={
              canExplain && context != null
                ? () => {
                    open(context, null);
                  }
                : undefined
            }
          />
        );
      })}
    </div>
  );
}
