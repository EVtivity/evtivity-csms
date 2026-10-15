// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { FilePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface GenerateButtonProps {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
  /** Layout classes only (width, placement), never size or colors. */
  className?: string;
}

export function GenerateButton({
  label,
  onClick,
  disabled,
  type = 'button',
  className,
}: GenerateButtonProps): React.JSX.Element {
  return (
    <Button className={cn('gap-1.5', className)} onClick={onClick} disabled={disabled} type={type}>
      <FilePlus className="h-4 w-4" />
      {label}
    </Button>
  );
}
