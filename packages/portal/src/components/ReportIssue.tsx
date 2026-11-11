// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useSupportEnabled } from '@/hooks/use-support-enabled';

interface ReportIssueProps {
  sessionId?: string | undefined;
  stationId?: string | undefined;
  stationName?: string | undefined;
}

export function ReportIssue({
  sessionId,
  stationId,
  stationName,
}: ReportIssueProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const supportEnabled = useSupportEnabled();
  // No button when support is off: the case form would only fail on submit.
  if (supportEnabled === false) return null;

  return (
    <Button
      variant="outline"
      className="w-full"
      onClick={() => {
        const params = new URLSearchParams();
        if (sessionId != null) params.set('sessionId', sessionId);
        if (stationId != null) params.set('stationId', stationId);
        if (stationName != null) params.set('stationName', stationName);
        const query = params.toString();
        void navigate(`/support/new${query !== '' ? `?${query}` : ''}`);
      }}
    >
      {t('supportCases.reportIssue')}
    </Button>
  );
}
