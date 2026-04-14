// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';

function copyToClipboard(text: string): Promise<void> {
  // navigator.clipboard is undefined on non-HTTPS origins at runtime
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (navigator.clipboard != null) {
    return navigator.clipboard.writeText(text);
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  document.execCommand('copy');
  document.body.removeChild(textarea);
  return Promise.resolve();
}

export function CopyableId({
  id,
  variant = 'detail',
  className,
}: {
  id: string;
  variant?: 'detail' | 'table';
  className?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (copied && ref.current != null) {
      const rect = ref.current.getBoundingClientRect();
      setPos({ x: rect.right, y: rect.top + rect.height / 2 });
    } else {
      setPos(null);
    }
  }, [copied]);

  function handleCopy(e: React.MouseEvent): void {
    e.stopPropagation();
    void copyToClipboard(id).then(() => {
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    });
  }

  return (
    <button
      ref={ref}
      type="button"
      onClick={handleCopy}
      className={`inline-flex items-center gap-1 transition-colors ${variant === 'table' ? 'text-sm text-foreground hover:text-muted-foreground' : 'text-xs text-muted-foreground hover:text-foreground'}${className != null ? ` ${className}` : ''}`}
    >
      {id}
      {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      {pos != null &&
        createPortal(
          <div
            className="pointer-events-none fixed rounded bg-foreground px-2 py-0.5 text-xs text-background whitespace-nowrap z-[9999] animate-in fade-in duration-150"
            style={{ left: pos.x + 6, top: pos.y, transform: 'translateY(-50%)' }}
          >
            {t('common.copied')}
          </div>,
          document.body,
        )}
    </button>
  );
}
