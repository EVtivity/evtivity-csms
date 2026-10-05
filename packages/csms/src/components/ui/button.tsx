// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// Filled variants fade their colors when disabled instead of using opacity: Chromium
// rasterizes an opacity layer per tile, which shows vertical seams across wide buttons.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-primary/50 disabled:text-primary-foreground/70',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:bg-destructive/50 disabled:text-destructive-foreground/70',
        success:
          'bg-success text-success-foreground hover:bg-success/90 disabled:bg-success/50 disabled:text-success-foreground/70',
        outline:
          'border border-input bg-background hover:bg-accent hover:text-accent-foreground disabled:opacity-50',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/80 disabled:bg-secondary/50 disabled:text-secondary-foreground/50',
        ghost: 'hover:bg-accent hover:text-accent-foreground disabled:opacity-50',
        link: 'text-primary underline-offset-4 hover:underline disabled:opacity-50',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
