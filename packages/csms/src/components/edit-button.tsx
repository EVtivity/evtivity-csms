// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { SquarePen } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface EditButtonProps {
  label: string;
  onClick: () => void;
  /** `header` in a detail page header, next to the Prev and Next buttons. */
  size?: 'default' | 'header';
}

export function EditButton({ label, onClick, size }: EditButtonProps): React.JSX.Element {
  return (
    <Button variant="outline" size={size} className="gap-1.5" onClick={onClick}>
      <SquarePen className="h-4 w-4" />
      {label}
    </Button>
  );
}
