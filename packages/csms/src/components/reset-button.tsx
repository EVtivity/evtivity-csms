// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ResetButtonProps {
  onClick: () => void;
  disabled?: boolean;
  label?: string;
}

export function ResetButton({ onClick, disabled, label }: ResetButtonProps): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <Button variant="outline" onClick={onClick} disabled={disabled} className="gap-1.5">
      <RotateCcw className="h-4 w-4" />
      {label ?? t('common.reset')}
    </Button>
  );
}
