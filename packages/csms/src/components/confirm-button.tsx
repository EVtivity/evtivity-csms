// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

interface ConfirmButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pending?: boolean;
  size?: 'default' | 'sm';
  testId?: string;
}

/** Approves a suggested change (an AI action): success color with a check icon. */
export function ConfirmButton({
  label,
  onClick,
  disabled,
  pending = false,
  size,
  testId,
}: ConfirmButtonProps): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="success"
      size={size}
      onClick={onClick}
      disabled={disabled === true || pending}
      data-testid={testId}
    >
      {pending ? <Spinner className="h-4 w-4" /> : <Check className="h-4 w-4" aria-hidden="true" />}
      {label}
    </Button>
  );
}
