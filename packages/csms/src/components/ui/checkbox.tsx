// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  indeterminate?: boolean;
  error?: boolean;
}

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, indeterminate, error, ...props }, ref) => {
    const innerRef = React.useRef<HTMLInputElement>(null);

    React.useImperativeHandle(ref, () => innerRef.current as HTMLInputElement);

    React.useEffect(() => {
      if (innerRef.current != null) {
        innerRef.current.indeterminate = indeterminate ?? false;
      }
    }, [indeterminate]);

    return (
      <span className="relative inline-flex h-4 w-4">
        <input
          type="checkbox"
          className={cn(
            'peer h-4 w-4 shrink-0 appearance-none rounded border border-input bg-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 checked:bg-primary checked:border-primary',
            error && 'border-destructive',
            className,
          )}
          ref={innerRef}
          {...props}
        />
        <Check className="pointer-events-none absolute inset-0 m-auto h-3 w-3 text-primary-foreground opacity-0 peer-checked:opacity-100" />
        {indeterminate === true && (
          <Minus className="pointer-events-none absolute inset-0 m-auto h-3 w-3 text-primary-foreground" />
        )}
      </span>
    );
  },
);
Checkbox.displayName = 'Checkbox';

export { Checkbox };
