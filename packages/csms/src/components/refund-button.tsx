// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface RefundButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  size?: 'default' | 'sm' | 'lg' | 'icon';
}

export function RefundButton({
  label,
  onClick,
  disabled,
  size,
}: RefundButtonProps): React.JSX.Element {
  return (
    <Button
      variant="destructive"
      size={size}
      className="gap-1.5"
      onClick={onClick}
      disabled={disabled}
    >
      <RotateCcw className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
      {label}
    </Button>
  );
}
