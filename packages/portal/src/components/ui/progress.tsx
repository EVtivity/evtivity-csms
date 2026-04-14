// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const progressTrackVariants = cva('relative w-full overflow-hidden rounded-full bg-muted', {
  variants: {
    size: {
      xs: 'h-1',
      sm: 'h-2',
      default: 'h-3',
      lg: 'h-6',
    },
  },
  defaultVariants: {
    size: 'sm',
  },
});

const progressFillVariants = cva('h-full rounded-full transition-all duration-500', {
  variants: {
    variant: {
      default: 'bg-primary',
      success: 'bg-success',
      warning: 'bg-warning',
      destructive: 'bg-destructive',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

export interface ProgressProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof progressTrackVariants>,
    VariantProps<typeof progressFillVariants> {
  value?: number;
}

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, size, variant, value = 0, ...props }, ref) => {
    const clamped = Math.max(0, Math.min(100, value));
    return (
      <div
        ref={ref}
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        className={cn(progressTrackVariants({ size }), className)}
        {...props}
      >
        <div
          className={cn(progressFillVariants({ variant }))}
          style={{ width: `${String(clamped)}%` }}
        />
      </div>
    );
  },
);
Progress.displayName = 'Progress';

export { Progress, progressTrackVariants, progressFillVariants };
