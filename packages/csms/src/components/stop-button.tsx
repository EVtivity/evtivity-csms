// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { CircleStop } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface StopButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  size?: 'default' | 'header';
}

/** Stops something running (a charging session): destructive color, stop icon. */
export function StopButton({ label, onClick, disabled, size }: StopButtonProps): React.JSX.Element {
  return (
    <Button variant="destructive" size={size} onClick={onClick} disabled={disabled}>
      <CircleStop className="h-4 w-4" aria-hidden="true" />
      {label}
    </Button>
  );
}
