// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { CopyButton } from '@/components/ui/copy-button';
import { cn } from '@/lib/utils';

/**
 * A long identifier, URL or token in a label and value list or a header: one
 * line, truncated to the space it has (never wider than its container), the
 * full value in a tooltip, and a copy button.
 */
export function IdText({
  value,
  mono = true,
  className,
}: {
  value: string;
  mono?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <span className={cn('flex min-w-0 max-w-full items-center gap-1', className)}>
      <span
        className={cn('min-w-0 truncate', mono && 'font-mono')}
        title={value}
        data-testid="id-text"
      >
        {value}
      </span>
      <CopyButton value={value} />
    </span>
  );
}
