// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ExportButtonProps {
  label: string;
  onClick: () => void;
}

export function ExportButton({ label, onClick }: ExportButtonProps): React.JSX.Element {
  return (
    <Button variant="outline" className="gap-1.5" onClick={onClick}>
      <Download className="h-4 w-4" />
      {label}
    </Button>
  );
}
