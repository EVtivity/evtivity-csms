// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { cn } from '@/lib/utils';

interface SpinnerProps extends React.HTMLAttributes<HTMLImageElement> {
  className?: string;
}

// Brand spinning-logo loader. The SVG animates itself, so no animate-spin class
// is needed. Size via className (defaults to h-4 w-4).
export function Spinner({ className, ...props }: SpinnerProps): React.JSX.Element {
  return (
    <img
      src="/evtivity-spinner.svg"
      alt=""
      aria-hidden="true"
      className={cn('h-4 w-4 shrink-0', className)}
      {...props}
    />
  );
}
