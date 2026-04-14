// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { cn } from '@/lib/utils';

interface PowerBarProps {
  currentKw: number;
  limitKw: number;
  maxKw: number;
  label?: string;
}

function getBarColor(percentage: number): string {
  if (percentage >= 95) return 'bg-red-500';
  if (percentage >= 80) return 'bg-yellow-500';
  return 'bg-green-500';
}

export function PowerBar({ currentKw, limitKw, maxKw, label }: PowerBarProps): React.JSX.Element {
  const effectiveMax = maxKw > 0 ? maxKw : Math.max(currentKw, limitKw, 1);
  const currentPercent = Math.min(100, (currentKw / effectiveMax) * 100);
  const limitPercent = limitKw > 0 ? Math.min(100, (limitKw / effectiveMax) * 100) : 0;
  const usagePercent = limitKw > 0 ? (currentKw / limitKw) * 100 : 0;

  return (
    <div className="space-y-1">
      {label != null && <p className="text-xs text-muted-foreground">{label}</p>}
      <div className="relative h-6 w-full rounded bg-muted overflow-hidden">
        <div
          className={cn('h-full rounded-l transition-all duration-500', getBarColor(usagePercent))}
          style={{ width: `${String(currentPercent)}%` }}
        />
        {limitPercent > 0 && (
          <div
            className="absolute top-0 h-full w-0.5 border-l-2 border-dashed border-foreground/50"
            style={{ left: `${String(limitPercent)}%` }}
          />
        )}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{currentKw.toFixed(1)} kW</span>
        {limitKw > 0 && <span>Limit: {limitKw.toFixed(1)} kW</span>}
        <span>Max: {effectiveMax.toFixed(1)} kW</span>
      </div>
    </div>
  );
}
