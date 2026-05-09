// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PushButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export function PushButton({ label, onClick, disabled }: PushButtonProps): React.JSX.Element {
  return (
    <Button className="gap-1.5" disabled={disabled} onClick={onClick}>
      <Upload className="h-4 w-4" />
      {label}
    </Button>
  );
}
