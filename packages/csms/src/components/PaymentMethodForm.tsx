// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CancelButton } from '@/components/cancel-button';
import { Button } from '@/components/ui/button';
import { getApiErrorCode } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { LoadingLogo } from '@/components/loading-logo';
import { ProviderHost } from '@/payments/ProviderHost';
import { startSetup } from '@/payments/api';
import { createCardSetupSteps, type CardSetupSteps } from '@/payments/setup-attempt';
import type { SetupSession } from '@/payments/types';

interface PaymentMethodFormProps {
  driverId: string;
  onSuccess: () => void;
  onCancel: () => void;
}

/**
 * Adds a card for a driver with the active payment provider. The form starts the
 * setup once when it opens and renders the provider's card UI through ProviderHost;
 * the card is saved through the generic setup/submit route.
 */
export function PaymentMethodForm({
  driverId,
  onSuccess,
  onCancel,
}: PaymentMethodFormProps): React.JSX.Element {
  const { t } = useTranslation();
  // The start error itself: translated at render, so the effect depends on the driver only.
  const [error, setError] = useState<{ cause: unknown } | null>(null);
  const [setup, setSetup] = useState<{ session: SetupSession; steps: CardSetupSteps } | null>(null);

  const initSetup = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const session = await startSetup(driverId);
      setSetup({ session, steps: createCardSetupSteps(driverId, session.provider) });
    } catch (err: unknown) {
      setError({ cause: err });
    }
  }, [driverId]);

  useEffect(() => {
    void initSetup();
  }, [initSetup]);

  if (error != null) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">
          {getApiErrorCode(error.cause) === 'PAYMENT_PROVIDER_NOT_CONFIGURED'
            ? t('payments.providerNotConfigured')
            : getErrorMessage(error.cause, t, 'payments.setupFailed')}
        </p>
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => {
              void initSetup();
            }}
          >
            {t('common.retry')}
          </Button>
          <CancelButton onClick={onCancel} />
        </div>
      </div>
    );
  }

  if (setup == null) {
    return (
      <div className="space-y-4">
        <LoadingLogo size="inline" />
        <CancelButton onClick={onCancel} />
      </div>
    );
  }

  return (
    <ProviderHost
      provider={setup.session.provider}
      props={{
        session: setup.session,
        submit: setup.steps.submit,
        submitDetails: setup.steps.submitDetails,
        onSaved: onSuccess,
        onCancel,
      }}
    />
  );
}
