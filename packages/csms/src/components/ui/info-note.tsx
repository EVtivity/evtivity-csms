// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';

interface InfoNoteProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * Inline info note with the standard blue accent and Info icon. Use anywhere a
 * short hint sits next to a form field or section ("Reservation will be
 * scheduled and activated at the start time", etc.). Single source of truth so
 * every note in the dashboard renders identically.
 */
export function InfoNote({ children, className }: InfoNoteProps): React.JSX.Element {
  return (
    <p className={cn('flex items-start gap-1 text-xs text-info', className)}>
      <Info className="h-3 w-3 mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
