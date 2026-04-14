// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { FilePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface GenerateButtonProps {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
}

export function GenerateButton({
  label,
  onClick,
  disabled,
  type = 'button',
}: GenerateButtonProps): React.JSX.Element {
  return (
    <Button className="gap-1.5" onClick={onClick} disabled={disabled} type={type}>
      <FilePlus className="h-4 w-4" />
      {label}
    </Button>
  );
}
