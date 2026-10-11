// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Calculator } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface RecalculateButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  size?: 'default' | 'sm';
}

/** Outline action that recomputes stored values (such as a site's electricity cost). */
export function RecalculateButton({
  label,
  onClick,
  disabled,
  size,
}: RecalculateButtonProps): React.JSX.Element {
  return (
    <Button variant="outline" size={size} className="gap-1.5" onClick={onClick} disabled={disabled}>
      <Calculator className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} aria-hidden="true" />
      {label}
    </Button>
  );
}
