// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ImportButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export function ImportButton({ label, onClick, disabled }: ImportButtonProps): React.JSX.Element {
  return (
    <Button variant="outline" className="gap-1.5" onClick={onClick} disabled={disabled}>
      <Upload className="h-4 w-4" />
      {label}
    </Button>
  );
}
