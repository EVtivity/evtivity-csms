// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';

export type ChallengeOutcome = 'approve' | 'fail';

export interface SimulatedChallengeProps {
  busy: boolean;
  onResolve: (outcome: ChallengeOutcome) => void;
}

/** Stands in for a 3-D Secure page: the tester decides whether authentication passes. */
export function SimulatedChallenge({
  busy,
  onResolve,
}: SimulatedChallengeProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="space-y-3 rounded-lg border border-input p-4">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="space-y-1">
          <p className="text-sm font-medium">{t('paymentProviders.simulated.challengeTitle')}</p>
          <p className="text-sm text-muted-foreground">
            {t('paymentProviders.simulated.challengeDescription')}
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          className="flex-1"
          disabled={busy}
          onClick={() => {
            onResolve('approve');
          }}
        >
          {t('paymentProviders.simulated.challengeApprove')}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="flex-1"
          disabled={busy}
          onClick={() => {
            onResolve('fail');
          }}
        >
          {t('paymentProviders.simulated.challengeFail')}
        </Button>
      </div>
    </div>
  );
}
