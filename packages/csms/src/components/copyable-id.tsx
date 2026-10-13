// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Check, Copy } from 'lucide-react';
import { useCopyFeedback } from '@/components/ui/copy-feedback';

/** An id that copies itself on click, with the shared check mark and "Copied" bubble. */
export function CopyableId({
  id,
  variant = 'detail',
  className,
}: {
  id: string;
  variant?: 'detail' | 'table';
  className?: string;
}): React.JSX.Element {
  const { ref, copied, copy, bubble } = useCopyFeedback<HTMLButtonElement>();

  return (
    <button
      ref={ref}
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        copy(id);
      }}
      className={`inline-flex min-w-0 max-w-full items-center gap-1 transition-colors ${variant === 'table' ? 'text-sm text-foreground hover:text-muted-foreground' : 'text-xs text-muted-foreground hover:text-foreground'}${className != null ? ` ${className}` : ''}`}
    >
      <span className="min-w-0 truncate" title={id}>
        {id}
      </span>
      {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      {bubble}
    </button>
  );
}
