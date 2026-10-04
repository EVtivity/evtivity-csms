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
    <div className="space-y-3 rounded-md border p-4">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="space-y-1">
          <p className="text-sm font-medium">{t('paymentProviders.simulated.challengeTitle')}</p>
          <p className="text-sm text-muted-foreground">
            {t('paymentProviders.simulated.challengeDescription')}
          </p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
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
