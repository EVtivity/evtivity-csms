// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useId } from 'react';
import { Tooltip } from '@/components/ui/tooltip';

/**
 * A disabled control with the reason it is disabled: a tooltip on hover and
 * focus, and the same reason for screen readers. A disabled button takes no
 * focus, so the wrapper is focusable and carries the reason to keyboard users.
 */
export function DisabledWithReason({
  reason,
  testId,
  children,
}: {
  reason: string;
  testId?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const reasonId = useId();
  return (
    <Tooltip content={reason}>
      <span
        tabIndex={0}
        aria-describedby={reasonId}
        className="inline-flex rounded-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        data-testid={testId}
      >
        {children}
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      </span>
    </Tooltip>
  );
}
