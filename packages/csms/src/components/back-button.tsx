// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface BackButtonProps {
  /** Fallback path when there is no browser history (e.g., direct link or new tab) */
  to?: string;
}

export function BackButton({ to }: BackButtonProps): React.JSX.Element {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <Button
      variant="outline"
      size="icon"
      aria-label={t('nav.back')}
      onClick={() => {
        if (window.history.length > 1) {
          void navigate(-1);
        } else {
          void navigate(to ?? '/');
        }
      }}
    >
      <ArrowLeft className="h-4 w-4" />
    </Button>
  );
}
