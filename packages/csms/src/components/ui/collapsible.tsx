// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface CollapsibleProps {
  /** The trigger label. */
  title: string;
  /** One line shown after the title (while closed, or always). */
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  /** Called when the user opens or closes it (for lazy loading the content). */
  onOpenChange?: (open: boolean) => void;
  className?: string;
  'data-testid'?: string;
  children: React.ReactNode;
}

/**
 * A disclosure: a full-width trigger row (chevron, title, one-line summary)
 * that shows or hides its content in place. The trigger is a real button
 * with `aria-expanded` and `aria-controls`, so Enter and Space toggle it.
 * The content renders only while open, so it can load lazily.
 */
export function Collapsible({
  title,
  summary,
  defaultOpen = false,
  onOpenChange,
  className,
  'data-testid': testId,
  children,
}: CollapsibleProps): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return (
    <div className={cn('min-w-0', className)} data-testid={testId}>
      <Button
        type="button"
        variant="outline"
        size="row"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => {
          const next = !open;
          setOpen(next);
          onOpenChange?.(next);
        }}
      >
        <ChevronRight
          className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-90')}
          aria-hidden="true"
        />
        <span className="shrink-0">{title}</span>
        {summary != null && (
          <span className="min-w-0 truncate text-muted-foreground">{summary}</span>
        )}
      </Button>
      {open && (
        <div id={contentId} className="min-w-0 pt-2">
          {children}
        </div>
      )}
    </div>
  );
}
