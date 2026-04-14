// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { CopyPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface AddButtonProps {
  label: string;
  onClick: () => void;
}

export function AddButton({ label, onClick }: AddButtonProps): React.JSX.Element {
  return (
    <Button variant="success" className="gap-1.5" onClick={onClick}>
      <CopyPlus className="h-4 w-4" />
      {label}
    </Button>
  );
}
