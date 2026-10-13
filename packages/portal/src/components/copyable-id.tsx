// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Check, Copy } from 'lucide-react';
import { useCopyFeedback } from '@/components/ui/copy-feedback';

/**
 * An ID that copies itself on click, then shows a check mark and the Copied
 * bubble for two seconds (`useCopyFeedback`, the CSMS `CopyableId` feedback).
 */
export function CopyableId({ id }: { id: string }): React.JSX.Element {
  const { ref, copied, copy, bubble } = useCopyFeedback<HTMLButtonElement>();

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => {
        copy(id);
      }}
      className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      {id}
      {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      {bubble}
    </button>
  );
}
