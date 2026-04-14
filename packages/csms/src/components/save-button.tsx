// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface SaveButtonProps {
  isPending: boolean;
  type?: 'button' | 'submit';
  onClick?: () => void;
  disabled?: boolean;
  label?: string;
}

export function SaveButton({
  isPending,
  type = 'submit',
  onClick,
  disabled,
  label,
}: SaveButtonProps): React.JSX.Element {
  const { t } = useTranslation();
  const [showSpinner, setShowSpinner] = useState(false);

  useEffect(() => {
    if (isPending) {
      setShowSpinner(true);
      return undefined;
    }
    if (showSpinner) {
      const timer = setTimeout(() => {
        setShowSpinner(false);
      }, 500);
      return () => {
        clearTimeout(timer);
      };
    }
    return undefined;
  }, [isPending, showSpinner]);

  const spinning = isPending || showSpinner;

  return (
    <Button
      variant="success"
      type={type}
      onClick={onClick}
      disabled={disabled ?? spinning}
      className="relative gap-1.5"
    >
      {spinning && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        </div>
      )}
      <span className={`inline-flex items-center gap-1.5 ${spinning ? 'invisible' : ''}`}>
        <Save className="h-4 w-4" />
        {label ?? t('common.save')}
      </span>
    </Button>
  );
}
