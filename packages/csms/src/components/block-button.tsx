// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Ban, CircleCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface BlockButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

/** Blocks something from being used (a vehicle's ids at every start): destructive, ban icon. */
export function BlockButton({ label, onClick, disabled }: BlockButtonProps): React.JSX.Element {
  return (
    <Button variant="destructive" onClick={onClick} disabled={disabled}>
      <Ban className="h-4 w-4" aria-hidden="true" />
      {label}
    </Button>
  );
}

/** Lifts a block: outline, check icon. */
export function UnblockButton({ label, onClick, disabled }: BlockButtonProps): React.JSX.Element {
  return (
    <Button variant="outline" onClick={onClick} disabled={disabled}>
      <CircleCheck className="h-4 w-4" aria-hidden="true" />
      {label}
    </Button>
  );
}
