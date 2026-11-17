// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { History } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface HistoryIconButtonProps {
  /** Defaults to button, so the button never submits a form it sits in. */
  type?: 'button' | 'submit';
  onClick: () => void;
  title: string;
  disabled?: boolean;
}

export function HistoryIconButton({
  onClick,
  title,
  disabled,
  type = 'button',
}: HistoryIconButtonProps): React.JSX.Element {
  return (
    <span className="group relative inline-flex">
      <Button
        type={type}
        variant="secondary"
        size="icon"
        onClick={onClick}
        disabled={disabled}
        aria-label={title}
      >
        <History className="h-4 w-4" />
      </Button>
      <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 z-50 hidden rounded-sm bg-foreground px-2 py-1 text-xs text-background whitespace-nowrap group-hover:block">
        {title}
      </span>
    </span>
  );
}
