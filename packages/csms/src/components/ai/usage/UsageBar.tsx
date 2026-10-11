// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { cn } from '@/lib/utils';

interface UsageBarProps {
  /** Share of the budget used, in percent; null when there is no limit. */
  percent: number | null;
  /** The warning level in percent (`ai.budget.warnPercent`); omitted: warn only when used up. */
  warnPercent?: number | undefined;
  label: string;
  className?: string;
}

/** A budget bar: primary below the warning level, warning above it, destructive when used up. */
export function UsageBar({
  percent,
  warnPercent,
  label,
  className,
}: UsageBarProps): React.JSX.Element | null {
  if (percent == null) return null;
  const clamped = Math.max(0, Math.min(100, percent));
  const tone =
    percent >= 100
      ? 'bg-destructive'
      : warnPercent != null && percent >= warnPercent
        ? 'bg-warning'
        : 'bg-primary';
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-muted', className)}
    >
      <div className={cn('h-full rounded-full', tone)} style={{ width: `${String(clamped)}%` }} />
    </div>
  );
}
