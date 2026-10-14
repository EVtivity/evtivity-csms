// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { PlugZap } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface UseVehicleButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

/**
 * "Use This Vehicle for Plug-In Charging": stores the vehicle id a charger
 * sent on the driver's vehicle (Autocharge). Primary action, plug icon.
 */
export function UseVehicleButton({
  label,
  onClick,
  disabled,
}: UseVehicleButtonProps): React.JSX.Element {
  return (
    <Button onClick={onClick} disabled={disabled}>
      <PlugZap className="h-4 w-4" aria-hidden="true" />
      {label}
    </Button>
  );
}
