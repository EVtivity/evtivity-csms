// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const toggleVariants = cva(
  'relative inline-flex shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      size: {
        sm: 'h-4 w-7',
        default: 'h-5 w-9',
        lg: 'h-6 w-11',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);

const thumbVariants = cva(
  'pointer-events-none inline-block rounded-full bg-background shadow-lg ring-0 transition-transform',
  {
    variants: {
      size: {
        sm: 'h-3 w-3',
        default: 'h-4 w-4',
        lg: 'h-5 w-5',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);

export interface ToggleProps
  extends
    Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'size'>,
    VariantProps<typeof toggleVariants> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

const Toggle = React.forwardRef<HTMLButtonElement, ToggleProps>(
  ({ className, size, checked = false, onCheckedChange, disabled, ...props }, ref) => {
    const translateClass =
      size === 'sm' ? 'translate-x-3' : size === 'lg' ? 'translate-x-5' : 'translate-x-4';

    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={cn(toggleVariants({ size }), checked ? 'bg-primary' : 'bg-muted', className)}
        onClick={() => onCheckedChange?.(!checked)}
        ref={ref}
        {...props}
      >
        <span className={cn(thumbVariants({ size }), checked ? translateClass : 'translate-x-0')} />
      </button>
    );
  },
);
Toggle.displayName = 'Toggle';

export { Toggle, toggleVariants };
