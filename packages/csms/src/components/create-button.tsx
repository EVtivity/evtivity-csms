// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface CreateButtonProps {
  label: string;
  onClick?: () => void;
  type?: 'button' | 'submit';
  disabled?: boolean;
}

export function CreateButton({
  label,
  onClick,
  type = 'button',
  disabled,
}: CreateButtonProps): React.JSX.Element {
  return (
    <Button onClick={onClick} type={type} disabled={disabled}>
      <Plus className="h-4 w-4" />
      {label}
    </Button>
  );
}
