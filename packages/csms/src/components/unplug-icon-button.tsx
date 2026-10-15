// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface UnplugIconButtonProps {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  isPending?: boolean;
}

export function UnplugIconButton({
  onClick,
  title,
  disabled,
  isPending,
}: UnplugIconButtonProps): React.JSX.Element {
  const iconClass = `h-4 w-4 ${isPending === true ? 'animate-pulse' : ''}`;
  return (
    <span className="group relative inline-flex">
      <Button
        variant="secondary"
        size="icon"
        onClick={onClick}
        disabled={disabled === true || isPending === true}
        aria-label={title}
      >
        <Unplug className={iconClass} />
      </Button>
      <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 z-50 hidden rounded bg-foreground px-2 py-1 text-xs text-background whitespace-nowrap group-hover:block">
        {title}
      </span>
    </span>
  );
}
