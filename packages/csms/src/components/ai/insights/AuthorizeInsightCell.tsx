// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lightbulb } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ExplainButton, useCanExplain, useOpenExplain } from '../ExplainButton';
import { InsightCard } from './InsightCard';
import type { AiInsightView } from './insight-api';

/**
 * The AI cell of a refused authorize attempt: an icon that
 * opens its insight when one exists, else the Explain icon. The insight opens
 * in a dialog, so it shows even when the assistant is off.
 */
export function AuthorizeInsightCell({
  attemptId,
  stationOcppId,
  insight,
}: {
  attemptId: number;
  /** The attempt's OCPP station id, shown in the assistant's context chip. */
  stationOcppId: string | null;
  insight: AiInsightView | undefined;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const iconRef = useRef<HTMLButtonElement>(null);
  const canExplain = useCanExplain();
  const openExplain = useOpenExplain();
  const context = { kind: 'authorization' as const, id: String(attemptId), label: stationOcppId };

  if (insight == null) {
    return <ExplainButton context={context} insight={null} iconOnly />;
  }
  return (
    <>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        ref={iconRef}
        aria-label={t('aiInsights.title')}
        title={t('aiInsights.title')}
        data-testid="ai-insight-icon"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Lightbulb className="h-4 w-4 text-info" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('aiInsights.title')}</DialogTitle>
          </DialogHeader>
          <InsightCard
            insight={insight}
            onFollowUp={
              canExplain
                ? () => {
                    setOpen(false);
                    // The panel returns focus to the row's icon, not the closed dialog.
                    iconRef.current?.focus();
                    openExplain(context);
                  }
                : undefined
            }
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
