// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { cn } from '@/lib/utils';

interface ButtonSpinnerProps {
  className?: string;
}

/**
 * The pending mark of a button action (save, submit, confirm): a small ring
 * drawn in the button's own text color, so it contrasts with every button
 * variant in light and dark themes. The brand logo loader (`Spinner`,
 * `LoadingLogo`) marks page or section loading only, never a button.
 */
export function ButtonSpinner({ className }: ButtonSpinnerProps): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-testid="button-spinner"
      className={cn(
        'inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current/25 border-t-current/80',
        className,
      )}
    />
  );
}
