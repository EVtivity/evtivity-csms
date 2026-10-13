// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import type { AiPanelContext } from './use-ai-panel-store';

/**
 * The record an Explain conversation is about, as one chip: its kind and the
 * identifier people know it by ("Session CS-0954", "Reservation #12",
 * "Insight ain_..."), no icon. Nothing else: the assistant reads the record
 * and its insights itself through its read tools, and the client sends only
 * the kind and the id.
 */
export function ExplainContextCard({ context }: { context: AiPanelContext }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="mb-3 flex">
      <span
        aria-label={t('ai.explain.contextLabel')}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs font-medium"
        data-testid="ai-context-card"
      >
        <span>{t(`ai.explain.kind.${context.kind}`)}</span>
        {context.label != null && (
          <span className="min-w-0 truncate font-mono text-muted-foreground">{context.label}</span>
        )}
      </span>
    </div>
  );
}
