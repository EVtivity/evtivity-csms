// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

interface CancelButtonProps {
  onClick: () => void;
  label?: string;
}

export function CancelButton({ onClick, label }: CancelButtonProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Button variant="outline" className="gap-1.5" type="button" onClick={onClick}>
      <X className="h-4 w-4" />
      {label ?? t('common.cancel')}
    </Button>
  );
}
