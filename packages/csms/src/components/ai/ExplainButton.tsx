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
import type { AiRecordContextKind } from '@evtivity/lib/ai-insights';
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

/**
 * Opens the panel about a record: the context chip (the record kind and its
 * id) and the prefilled Explain question.
 */
export function useOpenExplain(): (context: AiPanelContext) => void {
  return useAiPanelStore((s) => s.openWithContext);
}

interface ExplainButtonProps {
  /** An operational record; an insight opens the assistant through its card. */
  context: AiPanelContext & { kind: AiRecordContextKind };
  /**
   * The record's insight when the caller already has it (authorize log rows),
   * for the icon. Omitted: the button reads it from the same cached query the
   * insight card uses.
   */
  insight?: AiInsightView | null | undefined;
  /** An icon button for table rows. */
  iconOnly?: boolean;
  /** The text button's size: `header` in a detail page action row (matches the other header actions). */
  size?: 'default' | 'header';
  className?: string;
}

/**
 * The Explain button.
 * The caller decides when the record qualifies (failed session, refused
 * authorization, faulted or offline station, a reservation the station
 * refused or cancelled, that expired, or whose fee failed); this
 * hides the button unless the assistant is available and the user may write
 * to it. Opening the panel spends no tokens: nothing is sent until the user
 * sends the prefilled question.
 */
export function ExplainButton({
  context,
  insight,
  iconOnly = false,
  size = 'default',
  className,
}: ExplainButtonProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const canExplain = useCanExplain();
  const open = useOpenExplain();
  const lookup = insight === undefined;
  const { insights } = useInsights(
    insightFilterFor(context.kind, context.id),
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
          open(context);
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
      size={size}
      className={className}
      title={t('ai.explain.buttonTitle')}
      data-testid="ai-explain"
      onClick={() => {
        open(context);
      }}
    >
      {/* The AI accent of the icon-only Explain in table rows, so every Explain reads the same. */}
      <Sparkles className="h-4 w-4 text-link" aria-hidden="true" />
      <span className="ml-1">{t('ai.explain.button')}</span>
    </Button>
  );
}
