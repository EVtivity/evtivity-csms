// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Lightbulb } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { InsightFilter } from './insight-api';
import { isLiveInsight, pickShownInsight, useInsights } from './insight-api';

interface RecordInsightProps {
  filter: InsightFilter;
  /** Opens the page's AI Insights tab. */
  onOpen: () => void;
}

/**
 * The automatic insight signal on a record's page (station, session,
 * reservation): a floating lightbulb above the assistant button that opens the
 * page's AI Insights tab. It pulses while an insight still asks for attention
 * (amber when its action waits for a decision) and shows the count when there
 * are several. Renders nothing without `aiInsights:read` or without an insight
 * to show (an open or analyzing one, or one resolved within a day).
 */
export function RecordInsight({ filter, onOpen }: RecordInsightProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const { insights } = useInsights(filter);
  if (pickShownInsight(insights) == null) return null;
  const live = insights.filter(isLiveInsight);
  const waiting = live.some((i) => i.status === 'pending');
  // The pulse and the count sit beside the button, not inside it: the pulse scales to twice
  // the button and the count overhangs its corner, which made the button's own content wider
  // than the button (the phone layout check read its label as cut off).
  return (
    <div className="fixed bottom-24 right-6 z-40 flex">
      <Button
        type="button"
        size="fab"
        variant={live.length > 0 ? 'success' : 'outline'}
        aria-label={t('aiInsights.openPanel', { count: Math.max(live.length, 1) })}
        data-testid="record-insight-trigger"
        onClick={onOpen}
      >
        <Lightbulb className="h-5 w-5" aria-hidden="true" />
      </Button>
      {live.length > 0 && (
        // Pulses while an insight asks for attention; still with reduced motion.
        <span
          aria-hidden="true"
          data-testid="record-insight-pulse"
          className={cn(
            'pointer-events-none absolute inset-0 rounded-full animate-ping motion-reduce:animate-none',
            waiting ? 'bg-warning/40' : 'bg-info/40',
          )}
        />
      )}
      {live.length > 1 && (
        <span
          aria-hidden="true"
          data-testid="record-insight-count"
          className="pointer-events-none absolute -right-1 -top-1 min-w-5 rounded-full bg-warning px-1 text-center text-xs font-semibold text-foreground"
        >
          {live.length}
        </span>
      )}
    </div>
  );
}
