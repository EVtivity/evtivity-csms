// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface RefreshButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  isPending?: boolean;
}

export function RefreshButton({
  label,
  onClick,
  disabled,
  isPending,
}: RefreshButtonProps): React.JSX.Element {
  return (
    <Button
      variant="outline"
      className="gap-1.5"
      disabled={disabled === true || isPending === true}
      onClick={onClick}
    >
      <RefreshCw className={`h-4 w-4 ${isPending === true ? 'animate-spin' : ''}`} />
      {label}
    </Button>
  );
}
