// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { lazy, Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAiStatus } from './use-ai-status';
import { useAiPanelStore } from './use-ai-panel-store';

// The panel, the stream parser and the markdown stack load on first open only.
const AiPanel = lazy(() => import('./AiPanel'));

/** True for Ctrl+K (Cmd+K on macOS), the shortcut that opens the assistant. */
export function isAiShortcut(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k';
}

/**
 * The floating assistant button. Rendered only when `GET /v1/assistant/status`
 * says the assistant is available (enabled, a provider with a key) and the
 * user has `aiAssistant:read`; otherwise nothing renders and no space is kept.
 * Ctrl/Cmd+K toggles the panel; closing it returns focus to where it was
 * (the launcher when it opened the panel).
 * The open state lives in `useAiPanelStore`, so Explain buttons on any page
 * open the same panel.
 */
export function AiAssistantLauncher(): React.JSX.Element | null {
  const { t } = useTranslation();
  const available = useAiStatus().chatbot;
  const open = useAiPanelStore((s) => s.open);
  const openPanel = useAiPanelStore((s) => s.openPanel);
  const closePanel = useAiPanelStore((s) => s.close);

  useEffect(() => {
    if (!available) return undefined;
    function onKey(e: KeyboardEvent): void {
      if (!isAiShortcut(e)) return;
      e.preventDefault();
      if (open) closePanel();
      else openPanel();
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [available, open, openPanel, closePanel]);

  if (!available) return null;

  return (
    <>
      {/* Hidden, not unmounted, while the panel is open: closing returns focus to this node. */}
      <Button
        variant="default"
        size="fab"
        className="fixed bottom-6 right-6 z-40"
        hidden={open}
        aria-label={t('ai.open')}
        title={t('ai.openShortcut')}
        data-testid="ai-launcher"
        onClick={openPanel}
      >
        <Sparkles className="h-5 w-5" />
      </Button>
      {open && (
        <Suspense fallback={null}>
          <AiPanel onClose={closePanel} />
        </Suspense>
      )}
    </>
  );
}
