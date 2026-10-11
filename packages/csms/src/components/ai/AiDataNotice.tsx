// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/**
 * What the AI provider receives (`ai.dataNotice.*`). The text is written from
 * the verified audit table in `packages/ai/src/__contract__/data-handling.md` and
 * never claims more; a redaction change or a new AI surface updates both.
 * Shown on Settings > AI, Providers and keys and every surface tab.
 */
export function AiDataNotice(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    // A static note, not an announcement: role="note" replaces the Alert's role="alert".
    <Alert variant="info" role="note" className="items-start" data-testid="ai-data-notice">
      <ShieldCheck className="mt-0.5" aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        <AlertTitle>{t('ai.dataNotice.title')}</AlertTitle>
        <AlertDescription>{t('ai.dataNotice.body')}</AlertDescription>
      </div>
    </Alert>
  );
}
