// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { cn } from '@/lib/utils';

interface GuidedEmptyStateProps {
  title: string;
  description: string;
  /** The first actions to take, such as adding the first record. */
  actions?: React.ReactNode;
  className?: string;
}

/** An empty list that says what belongs there and how to start it. */
export function GuidedEmptyState({
  title,
  description,
  actions,
  className,
}: GuidedEmptyStateProps): React.JSX.Element {
  return (
    <div
      data-testid="empty-state"
      className={cn(
        'mx-auto flex max-w-md flex-col items-center gap-2 py-8 text-center',
        className,
      )}
    >
      <p className="text-sm font-semibold">{title}</p>
      <p className="text-sm text-muted-foreground">{description}</p>
      {actions != null && (
        <div className="mt-2 flex flex-wrap justify-center gap-2 *:grow sm:*:grow-0">{actions}</div>
      )}
    </div>
  );
}
