// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { CopyPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface AddButtonProps {
  /** Defaults to button, so the button never submits a form it sits in. */
  type?: 'button' | 'submit';
  label: string;
  onClick: () => void;
}

export function AddButton({ label, onClick, type = 'button' }: AddButtonProps): React.JSX.Element {
  return (
    <Button type={type} variant="success" className="gap-1.5" onClick={onClick}>
      <CopyPlus className="h-4 w-4" />
      {label}
    </Button>
  );
}
