// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Power } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface EnableButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  size?: 'default' | 'header';
}

/** Turns something back on (a station, an account): success color with a power icon. */
export function EnableButton({
  label,
  onClick,
  disabled,
  size,
}: EnableButtonProps): React.JSX.Element {
  return (
    <Button variant="success" size={size} onClick={onClick} disabled={disabled}>
      <Power className="h-4 w-4" aria-hidden="true" />
      {label}
    </Button>
  );
}
