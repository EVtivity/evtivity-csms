// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Truck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/** How often the page reads the feature flags again, to follow Fleets turned on. */
export const FLEETS_OFF_RECHECK_MS = 30_000;

/**
 * What a fleet user sees on every page while the Fleets feature is off: the
 * API answers it 403 FLEET_DISABLED on every route. The page reads the flags
 * again every 30 seconds, so the fleet user's pages come back once Fleets is on.
 */
export function FleetsOffPage(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  useEffect(() => {
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ['settings', 'features'] });
    }, FLEETS_OFF_RECHECK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [queryClient]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center" data-testid="fleets-off-page">
      <Card className="w-full max-w-md text-center">
        <CardHeader className="items-center">
          <Truck className="h-12 w-12 text-muted-foreground" aria-hidden="true" />
          <CardTitle className="text-xl">{t('fleetsOff.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t('fleetsOff.message')}</p>
        </CardContent>
      </Card>
    </div>
  );
}
