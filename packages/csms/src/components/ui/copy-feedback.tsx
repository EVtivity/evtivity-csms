// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { copyText } from '@/components/ui/clipboard';

/** How long a copy control shows its check mark and the Copied bubble. */
const COPIED_FEEDBACK_MS = 2000;

/**
 * The feedback every copy control shows: `copied` for two seconds (the
 * control swaps its icon for a check mark) and `bubble`, a "Copied" label
 * next to the control, rendered in a portal so a table cell or a dialog
 * never clips it. Attach `ref` to the control and call `copy(text)`, which
 * copies through `copyText`.
 */
export function useCopyFeedback<T extends HTMLElement>(): {
  ref: React.RefObject<T | null>;
  copied: boolean;
  copy: (text: string) => void;
  bubble: React.ReactNode;
} {
  const { t } = useTranslation();
  const ref = useRef<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(
    () => () => {
      if (timer.current != null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback((text: string) => {
    const show = (didFail: boolean): void => {
      const rect = ref.current?.getBoundingClientRect();
      setFailed(didFail);
      setPos(rect != null ? { x: rect.right, y: rect.top + rect.height / 2 } : { x: 0, y: 0 });
      if (timer.current != null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setPos(null);
      }, COPIED_FEEDBACK_MS);
    };
    copyText(text).then(
      () => {
        show(false);
      },
      (err: unknown) => {
        console.warn('Copy failed', err);
        show(true);
      },
    );
  }, []);

  const bubble =
    pos != null
      ? createPortal(
          <div
            role="status"
            data-testid="copied-bubble"
            className={`pointer-events-none fixed z-9999 whitespace-nowrap rounded px-2 py-0.5 text-xs animate-in fade-in duration-150 ${failed ? 'bg-destructive text-destructive-foreground' : 'bg-foreground text-background'}`}
            style={{ left: pos.x + 6, top: pos.y, transform: 'translateY(-50%)' }}
          >
            {failed ? t('common.copyFailed') : t('common.copied')}
          </div>,
          document.body,
        )
      : null;

  return { ref, copied: pos != null && !failed, copy, bubble };
}
