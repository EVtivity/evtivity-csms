// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ban, Check, ChevronDown, CircleAlert, Clock, Wrench } from 'lucide-react';
import type { AiToolStepStatus } from '@evtivity/lib/ai-stream';
import { Spinner } from '@/components/ui/spinner';
import { formatNumber } from '@/lib/formatting';
import { cn } from '@/lib/utils';
import type { AiToolStepView } from './ai-turn';

function StatusIcon({ status }: { status: AiToolStepStatus }): React.JSX.Element {
  switch (status) {
    case 'running':
      return <Spinner className="h-3 w-3" />;
    case 'ok':
    case 'confirmed':
      return <Check className="h-3 w-3 text-success" aria-hidden="true" />;
    case 'error':
      return <CircleAlert className="h-3 w-3 text-destructive" aria-hidden="true" />;
    case 'refused':
    case 'rejected':
      return <Ban className="h-3 w-3 text-warning" aria-hidden="true" />;
    case 'pending_confirmation':
      return <Clock className="h-3 w-3 text-info" aria-hidden="true" />;
  }
}

interface ToolStepsProps {
  steps: AiToolStepView[];
  /** Heading key: the chat shows "Steps", the support draft "Sources". */
  label?: 'ai.toolSteps' | 'ai.sources';
  defaultOpen?: boolean;
}

/** The tools the assistant called, collapsed to one line by default. */
export function ToolSteps({
  steps,
  label = 'ai.toolSteps',
  defaultOpen = false,
}: ToolStepsProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const listId = useId();
  if (steps.length === 0) return null;
  const running = steps.some((s) => s.status === 'running');

  return (
    <div
      className="rounded-md border border-border bg-background/60 text-xs"
      data-testid="ai-tool-steps"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        {running ? (
          <Spinner className="h-3 w-3" />
        ) : (
          <Wrench className="h-3 w-3" aria-hidden="true" />
        )}
        <span className="flex-1">
          {t(label)} ({formatNumber(steps.length, 0)})
        </span>
        <ChevronDown
          className={cn('h-3 w-3 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open && (
        <ol id={listId} className="space-y-1 border-t border-border px-2 py-1.5">
          {steps.map((step) => (
            <li key={step.toolCallId} className="flex items-start gap-2">
              <span className="mt-0.5">
                <StatusIcon status={step.status} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono break-all">{step.name}</span>
                  <span className="text-muted-foreground">{t(`ai.stepStatus.${step.status}`)}</span>
                  {step.durationMs != null && (
                    <span className="text-muted-foreground">
                      {t('ai.durationMs', { ms: formatNumber(step.durationMs, 0) })}
                    </span>
                  )}
                </div>
                {step.status === 'refused' ? (
                  <p className="break-words text-muted-foreground">
                    {t(`ai.refusedReason.${step.reason ?? 'unavailable'}`)}
                  </p>
                ) : (
                  step.summary != null &&
                  step.summary !== '' && (
                    <p className="break-words text-muted-foreground">{step.summary}</p>
                  )
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
