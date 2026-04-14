// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { FileDown } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface TemplateButtonProps {
  label: string;
  onClick: () => void;
}

export function TemplateButton({ label, onClick }: TemplateButtonProps): React.JSX.Element {
  return (
    <Button variant="outline" className="gap-1.5" onClick={onClick}>
      <FileDown className="h-4 w-4" />
      {label}
    </Button>
  );
}
