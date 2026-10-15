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
          'border border-control bg-background hover:bg-accent hover:text-accent-foreground disabled:opacity-50',
        secondary:
          'border border-control bg-secondary text-secondary-foreground hover:bg-secondary/80 disabled:bg-secondary/50 disabled:text-secondary-foreground/50',
        ghost: 'hover:bg-accent hover:text-accent-foreground disabled:opacity-50',
        link: 'text-link underline-offset-4 hover:underline disabled:opacity-50',
      },
      size: {
        default: 'h-10 px-4 py-2',
        // Narrower padding at the same 40 px height (every CSMS control is 40 px).
        sm: 'h-10 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
        // Detail page header actions: 44 px and sharing the row on phones, own width from sm.
        header: 'h-11 grow px-4 py-2 sm:h-10 sm:grow-0',
        // Detail page header icon buttons (Back, Prev, Next): 44 px on phones, 40 px from sm.
        'icon-header': 'h-11 w-11 shrink-0 sm:h-10 sm:w-10',
        // Text link inside a line of text (Remove, Undo under a field): no box of its own.
        inline: 'h-auto p-0 text-xs',
        // Compact text button inside dense cards (copy, show original).
        xs: 'h-7 gap-1 rounded-md px-2 text-xs',
        // Compact icon button for card and row actions.
        'icon-sm': 'h-8 w-8',
        // Smallest icon button, for overlays on chips and thumbnails.
        'icon-xs': 'h-6 w-6',
        // Pill for attachments and similar tokens in a message.
        chip: 'h-6 gap-1 rounded-full px-2 text-xs font-normal',
        // Full-width list option (suggested prompt, conversation, disclosure row).
        row: 'h-auto w-full justify-start gap-2 whitespace-normal px-3 py-2 text-left font-normal',
        'row-sm':
          'h-auto w-full justify-start gap-2 whitespace-normal px-2 py-1.5 text-left text-xs font-normal',
        // Floating action button.
        fab: 'h-12 w-12 rounded-full shadow-lg',
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
