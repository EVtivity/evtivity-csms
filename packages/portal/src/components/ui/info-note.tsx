// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';

interface InfoNoteProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * Inline info note with the standard blue accent and Info icon. Mirrors the
 * CSMS InfoNote so portal hints look identical to operator hints. Use for
 * short field/section hints (e.g. "A holding fee may apply...").
 */
export function InfoNote({ children, className }: InfoNoteProps): React.JSX.Element {
  return (
    <p className={cn('flex items-start gap-1 text-xs text-info', className)}>
      <Info className="h-3 w-3 mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
