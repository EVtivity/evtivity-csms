// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Lightbulb, Sparkles } from 'lucide-react';
import { DescriptionItem, DescriptionList } from '@/components/ui/description-list';
import type { AiPanelContext } from './use-ai-panel-store';
import { insightFilterFor, isFreshInsight, useInsights } from './insights/insight-api';
import { insightHeadline } from './insights/insight-display';

/**
 * The record an Explain conversation is about, shown the same way for every
 * kind (station, session, authorization, reservation): what it is, and its
 * latest fresh insight as a headline, likely cause and suggested fixes, never
 * the whole insight. The server builds the model's context from the same
 * record (`explain-engine.ts`); the client sends only the kind and the id.
 */
export function ExplainContextCard({ context }: { context: AiPanelContext }): React.JSX.Element {
  const { t } = useTranslation();
  const { insights } = useInsights(insightFilterFor(context.kind, context.id));
  const insight = insights.find(isFreshInsight) ?? null;
  const record = t(`ai.explain.kind.${context.kind}`);
  const label = context.label ?? insight?.stationName ?? null;
  const about =
    label != null
      ? t('ai.explain.about', { record, label })
      : t('ai.explain.aboutRecord', { record });

  return (
    <section
      aria-label={t('ai.explain.contextLabel')}
      className="mb-3 space-y-2 rounded-md border border-border bg-muted/40 p-3 text-sm"
      data-testid="ai-context-card"
    >
      <p className="flex items-center gap-1.5 font-medium">
        <Sparkles className="h-4 w-4 shrink-0 text-link" aria-hidden="true" />
        <span className="min-w-0 break-words">{about}</span>
      </p>
      {insight != null && (
        <div className="space-y-2" data-testid="ai-context-insight">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lightbulb className="h-3.5 w-3.5 shrink-0 text-info" aria-hidden="true" />
            {t('ai.explain.latestInsight')}
          </p>
          <p className="break-words font-medium">{insightHeadline(t, insight)}</p>
          {(insight.category != null || insight.fixes.length > 0) && (
            <DescriptionList>
              {insight.category != null && (
                <DescriptionItem label={t('aiInsights.likelyCause')}>
                  {t(`aiInsights.category.${insight.category}`)}
                </DescriptionItem>
              )}
              {insight.fixes.length > 0 && (
                <DescriptionItem label={t('aiInsights.fixesLabel')}>
                  <ul className="list-disc space-y-0.5 pl-4">
                    {insight.fixes.map((fix) => (
                      <li key={fix.code}>{t(`aiInsights.fix.${fix.code}`)}</li>
                    ))}
                  </ul>
                </DescriptionItem>
              )}
            </DescriptionList>
          )}
          <Link
            to={`/ai/insights/${encodeURIComponent(insight.id)}`}
            className="inline-block text-xs text-link hover:underline"
          >
            {t('ai.explain.viewInsight')}
          </Link>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t('ai.explain.shared')}</p>
    </section>
  );
}
