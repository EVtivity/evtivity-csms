// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { OctagonX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

interface AbortButtonProps {
  onClick: () => void;
  label?: string;
  disabled?: boolean;
}

export function AbortButton({ onClick, label, disabled }: AbortButtonProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Button
      variant="destructive"
      className="gap-1.5"
      type="button"
      onClick={onClick}
      disabled={disabled}
    >
      <OctagonX className="h-4 w-4" />
      {label ?? t('common.abort')}
    </Button>
  );
}
