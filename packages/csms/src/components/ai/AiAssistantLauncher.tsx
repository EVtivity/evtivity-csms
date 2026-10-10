// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAiStatus } from './use-ai-status';

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
 * Ctrl/Cmd+K toggles the panel; closing it returns focus to where it was.
 */
export function AiAssistantLauncher(): React.JSX.Element | null {
  const { t } = useTranslation();
  const available = useAiStatus().chatbot;
  const [open, setOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);

  const openPanel = useCallback(() => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, []);

  const closePanel = useCallback(() => {
    setOpen(false);
    const target = returnFocus.current;
    returnFocus.current = null;
    setTimeout(() => target?.focus(), 0);
  }, []);

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
      {!open && (
        <Button
          variant="default"
          size="icon"
          className="fixed bottom-6 right-6 z-40 h-12 w-12 rounded-full shadow-lg"
          aria-label={t('ai.open')}
          title={t('ai.openShortcut')}
          data-testid="ai-launcher"
          onClick={openPanel}
        >
          <Sparkles className="h-5 w-5" />
        </Button>
      )}
      {open && (
        <Suspense fallback={null}>
          <AiPanel onClose={closePanel} />
        </Suspense>
      )}
    </>
  );
}
