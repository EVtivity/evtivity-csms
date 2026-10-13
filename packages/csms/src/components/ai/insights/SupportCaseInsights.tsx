// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCanExplain, useOpenExplain } from '../ExplainButton';
import type { AiPanelContext } from '../use-ai-panel-store';
import { InsightCard } from './InsightCard';
import type { AiInsightView } from './insight-api';
import { isShownInsight, useInsights } from './insight-api';

const SHOWN = 3;

/** "Ask a follow-up" opens the assistant about the insight itself ("Insight ain_..."). */
function followUpContext(insight: AiInsightView): AiPanelContext {
  return { kind: 'insight', id: insight.id, label: insight.id };
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
  const shown = insights.filter((i) => isShownInsight(i, now)).slice(0, SHOWN);
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
              canExplain
                ? () => {
                    open(context);
                  }
                : undefined
            }
          />
        );
      })}
    </div>
  );
}
