// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface BackButtonProps {
  /**
   * Explicit path to navigate to. When provided, the back button always goes
   * here so callers can force a specific destination (e.g., a sibling tab) and
   * not rely on the browser history stack, which can land on a stale state.
   * When omitted, the button uses browser history with `/` as a fallback.
   */
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
        if (to != null) {
          void navigate(to);
        } else if (window.history.length > 1) {
          void navigate(-1);
        } else {
          void navigate('/');
        }
      }}
    >
      <ArrowLeft className="h-4 w-4" />
    </Button>
  );
}
