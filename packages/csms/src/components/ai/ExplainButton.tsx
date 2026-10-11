// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Lightbulb, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useHasPermission } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useAiStatus } from './use-ai-status';
import { useAiPanelStore } from './use-ai-panel-store';
import type { AiPanelContext } from './use-ai-panel-store';
import type { AiInsightView } from './insights/insight-api';
import { insightFilterFor, isFreshInsight, useInsights } from './insights/insight-api';

/**
 * Explain needs the assistant on and the right to start a conversation.
 */
export function useCanExplain(): boolean {
  const chatbot = useAiStatus().chatbot;
  const canWrite = useHasPermission('aiAssistant:write');
  return chatbot && canWrite;
}

/** Opens the panel about a record: its fresh insight first, else the prefilled question. */
export function useOpenExplain(): (
  context: AiPanelContext,
  insight?: AiInsightView | null,
) => void {
  const openWithContext = useAiPanelStore((s) => s.openWithContext);
  return (context, insight) => {
    openWithContext(context, { insightId: isFreshInsight(insight) ? (insight?.id ?? null) : null });
  };
}

interface ExplainButtonProps {
  context: AiPanelContext;
  /**
   * The record's insight when the caller already has it (authorize log rows).
   * Omitted for stations and sessions: the button reads it from the same
   * cached query the insight card uses.
   */
  insight?: AiInsightView | null | undefined;
  /** An icon button for table rows. */
  iconOnly?: boolean;
  className?: string;
}

/**
 * The Explain button.
 * The caller decides when the record qualifies
 * (failed session, refused authorization, faulted or offline station); this
 * hides the button unless the assistant is available and the user may write
 * to it. With a fresh insight the panel shows it and spends no tokens.
 */
export function ExplainButton({
  context,
  insight,
  iconOnly = false,
  className,
}: ExplainButtonProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const canExplain = useCanExplain();
  const open = useOpenExplain();
  const lookup = insight === undefined && context.kind !== 'authorization';
  const { insights } = useInsights(
    lookup ? insightFilterFor(context.kind === 'station' ? 'station' : 'session', context.id) : {},
    canExplain && lookup,
  );
  if (!canExplain) return null;
  const known = insight !== undefined ? insight : (insights.find(isFreshInsight) ?? null);
  const fresh = isFreshInsight(known);
  const Icon = fresh ? Lightbulb : Sparkles;
  const label = fresh ? t('aiInsights.title') : t('ai.explain.button');

  if (iconOnly) {
    return (
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className={className}
        aria-label={label}
        title={fresh ? label : t('ai.explain.buttonTitle')}
        data-testid={fresh ? 'ai-insight-icon' : 'ai-explain'}
        onClick={(e) => {
          e.stopPropagation();
          open(context, known);
        }}
      >
        <Icon className={cn('h-4 w-4', fresh ? 'text-info' : 'text-link')} />
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      className={className}
      title={t('ai.explain.buttonTitle')}
      data-testid="ai-explain"
      onClick={() => {
        open(context, known);
      }}
    >
      <Sparkles className="h-4 w-4" />
      <span className="ml-1">{t('ai.explain.button')}</span>
    </Button>
  );
}
