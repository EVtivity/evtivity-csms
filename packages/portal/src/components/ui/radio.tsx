// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface RadioProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  error?: boolean;
}

const Radio = React.forwardRef<HTMLInputElement, RadioProps>(
  ({ className, error, ...props }, ref) => {
    return (
      <span className="relative inline-flex h-4 w-4">
        <input
          type="radio"
          className={cn(
            'peer h-4 w-4 shrink-0 appearance-none rounded-full border border-input bg-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 checked:border-primary checked:bg-primary',
            error && 'border-destructive',
            className,
          )}
          ref={ref}
          {...props}
        />
        <span className="pointer-events-none absolute inset-0 m-auto h-2 w-2 rounded-full bg-primary-foreground opacity-0 peer-checked:opacity-100" />
      </span>
    );
  },
);
Radio.displayName = 'Radio';

export { Radio };
