// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Navigate, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useHasAllSiteAccess } from '@/lib/auth';

interface AllSiteRouteProps {
  children: React.ReactNode;
  /** Redirect here instead of showing the notice (for example a sibling tab). */
  fallbackTo?: string;
}

/**
 * Guards a company-wide page: the API answers 404 to a site-restricted user,
 * so such a user reaching the page directly sees a notice (or is redirected)
 * instead of an empty or failing page.
 */
export function AllSiteRoute({ children, fallbackTo }: AllSiteRouteProps): React.JSX.Element {
  const hasAllSiteAccess = useHasAllSiteAccess();
  const navigate = useNavigate();
  const { t } = useTranslation();

  if (hasAllSiteAccess) return <>{children}</>;
  if (fallbackTo != null) return <Navigate to={fallbackTo} replace />;

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
      <Lock className="h-12 w-12 text-muted-foreground" />
      <h1 className="text-2xl md:text-3xl font-bold">{t('common.allSiteAccessRequired')}</h1>
      <p className="text-sm text-muted-foreground">
        {t('common.allSiteAccessRequiredDescription')}
      </p>
      <Button
        onClick={() => {
          void navigate('/');
        }}
      >
        {t('common.backToHome')}
      </Button>
    </div>
  );
}
