// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type IconBadgeTone = 'info' | 'warning' | 'destructive' | 'success' | 'muted';

/**
 * Solid tone fills with dark ink (`--on-tone`): the icon is at least 4.2:1 on
 * every fill in both themes. `muted` is the inverse of the card (muted
 * foreground fill, card-colored icon, 4.7:1 light, 6.8:1 dark).
 */
const TONES: Record<IconBadgeTone, string> = {
  info: 'bg-info text-on-tone',
  warning: 'bg-warning text-on-tone',
  destructive: 'bg-destructive text-on-tone',
  success: 'bg-success text-on-tone',
  muted: 'bg-muted-foreground text-card',
};

const SIZES = {
  sm: 'h-6 w-6 [&>svg]:h-3.5 [&>svg]:w-3.5',
  default: 'h-8 w-8 [&>svg]:h-4 [&>svg]:w-4',
} as const;

interface IconBadgeProps {
  icon: LucideIcon;
  tone: IconBadgeTone;
  /** Accessible name; omit when text next to the badge says the same. */
  label?: string;
  size?: keyof typeof SIZES;
  className?: string;
}

/** A status or kind icon on a solid tone fill that stands out from the card. */
export function IconBadge({
  icon: Icon,
  tone,
  label,
  size = 'default',
  className,
}: IconBadgeProps): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md',
        TONES[tone],
        SIZES[size],
        className,
      )}
      role={label != null ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label == null ? true : undefined}
      data-tone={tone}
    >
      <Icon aria-hidden="true" />
    </span>
  );
}
