// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Play } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface StartButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export function StartButton({ label, onClick, disabled }: StartButtonProps): React.JSX.Element {
  return (
    <Button className="gap-1.5" disabled={disabled} onClick={onClick}>
      <Play className="h-4 w-4" />
      {label}
    </Button>
  );
}
