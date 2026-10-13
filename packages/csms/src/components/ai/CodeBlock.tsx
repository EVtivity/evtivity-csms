// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { CopyButton } from '@/components/ui/copy-button';

interface CodeBlockProps {
  code: string;
  language: string | null;
}

/** A fenced code block from model output, with the shared copy button. */
export function CodeBlock({ code, language }: CodeBlockProps): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="not-prose my-2 min-w-0 max-w-full overflow-hidden rounded-md border border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-2 py-1 text-xs text-muted-foreground">
        <span className="font-mono">{language ?? t('ai.code')}</span>
        <CopyButton value={code} text={t('common.copy')} label={t('ai.copyCode')} size="xs" />
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}
