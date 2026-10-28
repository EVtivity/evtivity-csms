// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface RemoveButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  /** `header` in a detail page header, next to the Prev and Next buttons. */
  size?: 'default' | 'header';
}

export function RemoveButton({
  label,
  onClick,
  disabled,
  title,
  size,
}: RemoveButtonProps): React.JSX.Element {
  // An action button, never a submit (the avatar editor dialog sits inside edit forms).
  return (
    <Button
      type="button"
      variant="destructive"
      size={size}
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
