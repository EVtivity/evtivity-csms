// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';

interface CodeBlockProps {
  code: string;
  language: string | null;
}

/** A fenced code block from model output, with a copy button. */
export function CodeBlock({ code, language }: CodeBlockProps): React.JSX.Element {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current != null) clearTimeout(timer.current);
    },
    [],
  );

  function copy(): void {
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        if (timer.current != null) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          setCopied(false);
        }, 2000);
      },
      (err: unknown) => {
        console.warn('Copy the code block failed', err);
      },
    );
  }

  return (
    <div className="not-prose my-2 overflow-hidden rounded-md border border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-2 py-1 text-xs text-muted-foreground">
        <span className="font-mono">{language ?? t('ai.code')}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? t('ai.copied') : t('ai.copyCode')}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
          <span>{copied ? t('ai.copied') : t('common.copy')}</span>
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}
