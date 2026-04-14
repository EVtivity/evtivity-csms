// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { SquarePen } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface EditIconButtonProps {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

export function EditIconButton({
  onClick,
  title,
  disabled,
  size = 'md',
}: EditIconButtonProps): React.JSX.Element {
  const sizeClass = size === 'sm' ? 'h-6 w-6' : 'h-7 w-7';
  const iconClass = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5';
  return (
    <span className="group relative inline-flex">
      <Button
        variant="secondary"
        size="icon"
        className={sizeClass}
        onClick={onClick}
        disabled={disabled}
        aria-label={title}
      >
        <SquarePen className={iconClass} />
      </Button>
      <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 z-50 hidden rounded bg-foreground px-2 py-1 text-xs text-background whitespace-nowrap group-hover:block">
        {title}
      </span>
    </span>
  );
}
