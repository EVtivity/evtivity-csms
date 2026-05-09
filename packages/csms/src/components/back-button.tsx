// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface BackButtonProps {
  /**
   * Per-page default destination used when there is no browser history (direct
   * link, fresh tab). Most callers want this and nothing else; e.g., a detail
   * page passes its listing route here so refreshing the tab still gives a
   * sensible Back target.
   */
  to?: string;
  /**
   * Hard override. When set, the button always goes here regardless of browser
   * history. Use this only when the natural Back target is wrong - e.g., a
   * Progress page that you reach by clicking "Start" on Details should send you
   * to the History tab on Back, not back to Details.
   */
  forceTo?: string;
}

export function BackButton({ to, forceTo }: BackButtonProps): React.JSX.Element {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <Button
      variant="outline"
      size="icon"
      aria-label={t('nav.back')}
      onClick={() => {
        // Priority: explicit override -> browser history -> page default -> root.
        if (forceTo != null) {
          void navigate(forceTo);
        } else if (window.history.length > 1) {
          void navigate(-1);
        } else if (to != null) {
          void navigate(to);
        } else {
          void navigate('/');
        }
      }}
    >
      <ArrowLeft className="h-4 w-4" />
    </Button>
  );
}
