// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCopyFeedback } from '@/components/ui/copy-feedback';

/**
 * The shared copy button, as in the CSMS: an outline button that copies
 * `value`, shows a check mark for two seconds and names its state in its
 * `aria-label` (Copy, Copied). Icon only, it also shows the "Copied" bubble
 * (`useCopyFeedback`). With `text` it shows a visible label instead, which
 * reads Copied for the same two seconds.
 */
export function CopyButton({
  value,
  label,
  text,
  size,
  variant = 'outline',
  className,
}: {
  value: string;
  /** Accessible name before copying (default `text`, else `common.copy`). */
  label?: string;
  /** Visible label next to the icon (for example `common.copy`). */
  text?: string;
  /** Button size: `icon` by default, `sm` with `text`. */
  size?: 'icon' | 'sm' | 'default';
  variant?: 'outline' | 'ghost';
  className?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { ref, copied, copy, bubble } = useCopyFeedback<HTMLButtonElement>();
  const buttonSize = size ?? (text != null ? 'sm' : 'icon');

  return (
    <Button
      ref={ref}
      type="button"
      variant={variant}
      size={buttonSize}
      className={className}
      aria-label={copied ? t('common.copied') : (label ?? text ?? t('common.copy'))}
      data-testid="copy-button"
      onClick={(e) => {
        e.stopPropagation();
        copy(value);
      }}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {text != null ? <span>{copied ? t('common.copied') : text}</span> : bubble}
    </Button>
  );
}
