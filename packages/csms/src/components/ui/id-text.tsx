// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * A long identifier, URL or token in a label and value list or a header: one
 * line, truncated to the space it has (never wider than its container), the
 * full value in a tooltip, and a copy button.
 */
export function IdText({
  value,
  mono = true,
  className,
}: {
  value: string;
  mono?: boolean;
  className?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <span className={cn('flex min-w-0 max-w-full items-center gap-1', className)}>
      <span
        className={cn('min-w-0 truncate', mono && 'font-mono')}
        title={value}
        data-testid="id-text"
      >
        {value}
      </span>
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        aria-label={copied ? t('common.copied') : t('common.copy')}
        onClick={(e) => {
          e.stopPropagation();
          void navigator.clipboard.writeText(value).then(
            () => {
              setCopied(true);
              setTimeout(() => {
                setCopied(false);
              }, 2000);
            },
            (err: unknown) => {
              console.warn('Copy failed', err);
            },
          );
        }}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </Button>
    </span>
  );
}
