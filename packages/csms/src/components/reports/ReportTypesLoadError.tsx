// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

/** Shown in place of the report type selects when the report types failed to load. */
export function ReportTypesLoadError({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2" role="alert">
      <p className="text-sm text-destructive">{t('common.loadError')}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        {t('common.retry')}
      </Button>
    </div>
  );
}
