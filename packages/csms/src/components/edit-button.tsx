// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { SquarePen } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface EditButtonProps {
  label: string;
  onClick: () => void;
}

export function EditButton({ label, onClick }: EditButtonProps): React.JSX.Element {
  return (
    <Button variant="outline" className="gap-1.5" onClick={onClick}>
      <SquarePen className="h-4 w-4" />
      {label}
    </Button>
  );
}
