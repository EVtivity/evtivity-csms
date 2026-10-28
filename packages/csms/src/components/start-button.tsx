// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Play } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface StartButtonProps {
  /** Defaults to button, so the button never submits a form it sits in. */
  type?: 'button' | 'submit';
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export function StartButton({
  label,
  onClick,
  disabled,
  type = 'button',
}: StartButtonProps): React.JSX.Element {
  return (
    <Button type={type} className="gap-1.5" disabled={disabled} onClick={onClick}>
      <Play className="h-4 w-4" />
      {label}
    </Button>
  );
}
