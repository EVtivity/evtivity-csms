// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface RemoveButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}

export function RemoveButton({
  label,
  onClick,
  disabled,
  title,
}: RemoveButtonProps): React.JSX.Element {
  return (
    <Button
      variant="destructive"
      className="gap-1.5"
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      <Trash2 className="h-4 w-4" />
      {label}
    </Button>
  );
}
