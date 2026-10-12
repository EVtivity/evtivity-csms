// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * The shared copy button: an outline icon button (`icon-xs`) that copies
 * `value`, shows a check for two seconds and names its state in its
 * `aria-label` (Copy, Copied). `IdText` and every other copy control use it.
 */
export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  /** Accessible name before copying (default `common.copy`). */
  label?: string;
  className?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current != null) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <Button
      type="button"
      variant="outline"
      size="icon-xs"
      className={className}
      aria-label={copied ? t('common.copied') : (label ?? t('common.copy'))}
      data-testid="copy-button"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            if (timer.current != null) clearTimeout(timer.current);
            timer.current = setTimeout(() => {
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
  );
}
