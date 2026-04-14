// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { cn } from '@/lib/utils';

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

const chevronUrl =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23717b8c' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")";

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, style, autoComplete = 'off', ...props }, ref) => {
    return (
      <select
        autoComplete={autoComplete}
        className={cn(
          'flex h-12 w-full appearance-none rounded-lg border border-input bg-background bg-no-repeat px-3 py-2 pr-10 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        style={{
          backgroundImage: chevronUrl,
          backgroundPosition: 'right 0.75rem center',
          backgroundSize: '16px 16px',
          ...style,
        }}
        ref={ref}
        {...props}
      />
    );
  },
);
Select.displayName = 'Select';

export { Select };
