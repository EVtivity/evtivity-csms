// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { FileDown } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface TemplateButtonProps {
  /** Defaults to button, so the button never submits a form it sits in. */
  type?: 'button' | 'submit';
  label: string;
  onClick: () => void;
}

export function TemplateButton({
  label,
  onClick,
  type = 'button',
}: TemplateButtonProps): React.JSX.Element {
  return (
    <Button type={type} variant="outline" className="gap-1.5" onClick={onClick}>
      <FileDown className="h-4 w-4" />
      {label}
    </Button>
  );
}
