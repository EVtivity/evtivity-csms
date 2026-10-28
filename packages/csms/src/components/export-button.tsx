// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ExportButtonProps {
  /** Defaults to button, so the button never submits a form it sits in. */
  type?: 'button' | 'submit';
  label: string;
  onClick: () => void;
}

export function ExportButton({
  label,
  onClick,
  type = 'button',
}: ExportButtonProps): React.JSX.Element {
  return (
    <Button type={type} variant="outline" className="gap-1.5" onClick={onClick}>
      <Download className="h-4 w-4" />
      {label}
    </Button>
  );
}
