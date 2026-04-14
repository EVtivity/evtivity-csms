// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';

export function ServerDown(): React.JSX.Element {
  const { t } = useTranslation();
  const retryConnection = useAuth((s) => s.retryConnection);
  const isHydrating = useAuth((s) => s.isHydrating);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="max-w-md space-y-6 text-center">
        <img src="/evtivity-logo.svg" alt="EVtivity" className="mx-auto h-14 w-14" />
        <div className="space-y-2">
          <h1 className="text-2xl font-bold">{t('errors.serverDown')}</h1>
          <p className="text-sm text-muted-foreground">{t('errors.serverDownDescription')}</p>
        </div>
        <Button onClick={retryConnection} disabled={isHydrating}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isHydrating ? 'animate-spin' : ''}`} />
          {t('errors.retry')}
        </Button>
      </div>
    </div>
  );
}
