// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { PowerOff } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface DisableButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  size?: 'default' | 'header';
}

/** Takes something out of service (a station, an account): destructive color, power-off icon. */
export function DisableButton({
  label,
  onClick,
  disabled,
  size,
}: DisableButtonProps): React.JSX.Element {
  return (
    <Button variant="destructive" size={size} onClick={onClick} disabled={disabled}>
      <PowerOff className="h-4 w-4" aria-hidden="true" />
      {label}
    </Button>
  );
}
