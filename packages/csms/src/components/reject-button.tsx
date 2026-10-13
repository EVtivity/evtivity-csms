// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Ban } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

interface RejectButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pending?: boolean;
  size?: 'default' | 'sm';
  testId?: string;
}

/** Turns down a suggested change (an AI action): destructive color with a ban icon. */
export function RejectButton({
  label,
  onClick,
  disabled,
  pending = false,
  size,
  testId,
}: RejectButtonProps): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="destructive"
      size={size}
      onClick={onClick}
      disabled={disabled === true || pending}
      data-testid={testId}
    >
      {pending ? <Spinner className="h-4 w-4" /> : <Ban className="h-4 w-4" aria-hidden="true" />}
      {label}
    </Button>
  );
}
