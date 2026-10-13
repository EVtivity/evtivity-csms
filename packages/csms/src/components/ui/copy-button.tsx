// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCopyFeedback } from '@/components/ui/copy-feedback';

/**
 * The shared copy button: an outline icon button (`icon-xs`) that copies
 * `value`, shows a check mark for two seconds and names its state in its
 * `aria-label` (Copy, Copied). Icon only, it also shows the "Copied" bubble
 * (`useCopyFeedback`, the same feedback as `CopyableId`). With `text` it
 * shows a visible label instead, which reads Copied for the same two
 * seconds. `IdText` and every other copy control use it.
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
  /** Button size: `icon-xs` by default, `sm` with `text`. */
  size?: 'icon-xs' | 'icon-sm' | 'icon' | 'xs' | 'sm' | 'default';
  variant?: 'outline' | 'ghost';
  className?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { ref, copied, copy, bubble } = useCopyFeedback<HTMLButtonElement>();
  const buttonSize = size ?? (text != null ? 'sm' : 'icon-xs');
  const iconClass = buttonSize === 'icon-xs' || buttonSize === 'xs' ? 'h-3 w-3' : 'h-4 w-4';

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
      {copied ? <Check className={iconClass} /> : <Copy className={iconClass} />}
      {text != null ? <span>{copied ? t('common.copied') : text}</span> : bubble}
    </Button>
  );
}
