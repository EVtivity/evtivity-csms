// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface AddIconButtonProps {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

export function AddIconButton({
  onClick,
  title,
  disabled,
  size = 'md',
}: AddIconButtonProps): React.JSX.Element {
  const sizeClass = size === 'sm' ? 'h-9 w-9' : 'h-10 w-10';
  const iconClass = 'h-4 w-4';
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
        <Plus className={iconClass} />
      </Button>
      <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 z-50 hidden rounded bg-foreground px-2 py-1 text-xs text-background whitespace-nowrap group-hover:block">
        {title}
      </span>
    </span>
  );
}
