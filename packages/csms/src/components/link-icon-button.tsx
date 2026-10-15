// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface LinkIconButtonProps {
  href: string;
  title: string;
  disabled?: boolean;
}

export function LinkIconButton({ href, title, disabled }: LinkIconButtonProps): React.JSX.Element {
  const iconClass = 'h-4 w-4';
  return (
    <span className="group relative inline-flex">
      <Button
        variant="secondary"
        size="icon"
        disabled={disabled}
        aria-label={title}
        onClick={() => {
          window.open(href, '_blank', 'noopener,noreferrer');
        }}
      >
        <ExternalLink className={iconClass} />
      </Button>
      <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 z-50 hidden rounded bg-foreground px-2 py-1 text-xs text-background whitespace-nowrap group-hover:block">
        {title}
      </span>
    </span>
  );
}
