// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Truck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

/** How often the page reads the user's fleets again, to follow a new assignment. */
export const NO_FLEETS_RECHECK_MS = 30_000;

/**
 * What a fleet user with no assigned fleet sees in place of its pages: the API
 * answers its fleet routes 403 FLEET_USER_NO_FLEETS. The page reads the
 * user's fleets again every 30 seconds, so the pages come back once an
 * operator assigns a fleet.
 */
export function NoFleetsPage(): React.JSX.Element {
  const { t } = useTranslation();
  const refreshAccess = useAuth((s) => s.refreshAccess);

  useEffect(() => {
    const timer = setInterval(() => {
      void refreshAccess();
    }, NO_FLEETS_RECHECK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [refreshAccess]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center" data-testid="no-fleets-page">
      <Card className="w-full max-w-md text-center">
        <CardHeader className="items-center">
          <Truck className="h-12 w-12 text-muted-foreground" aria-hidden="true" />
          <CardTitle className="text-xl">{t('noFleets.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t('noFleets.message')}</p>
        </CardContent>
      </Card>
    </div>
  );
}
