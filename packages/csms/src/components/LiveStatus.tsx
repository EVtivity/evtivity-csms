// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { cn } from '@/lib/utils';

/**
 * A quiet note in a polite live region. The region stays mounted while empty,
 * because screen readers announce only changes to a region already on the page.
 */
export function LiveStatus({
  message,
  className,
}: {
  message: string | null;
  className?: string | undefined;
}): React.JSX.Element {
  const empty = message == null || message === '';
  return (
    <p role="status" className={empty ? 'sr-only' : cn('text-sm text-muted-foreground', className)}>
      {empty ? '' : message}
    </p>
  );
}
