// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { forwardRef } from 'react';
import { X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface ClearableInputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'onChange'
> {
  value: string;
  onChange: (value: string) => void;
  onClear?: () => void;
  invalid?: boolean;
  clearLabel?: string;
}

export const ClearableInput = forwardRef<HTMLInputElement, ClearableInputProps>(
  function ClearableInput(
    { value, onChange, onClear, invalid, clearLabel = 'Clear', className, ...rest },
    ref,
  ) {
    function handleClear(): void {
      onChange('');
      onClear?.();
    }

    return (
      <div className="relative">
        <Input
          ref={ref}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          className={cn(
            value !== '' ? 'pr-9' : '',
            invalid === true ? 'border-destructive' : '',
            className,
          )}
          {...rest}
        />
        {value !== '' && (
          <button
            type="button"
            onClick={handleClear}
            aria-label={clearLabel}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    );
  },
);
