// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { CardSetupProps, SetupStepResult } from '../types';
import { AdyenCardForm, type AdyenStep } from './AdyenCardForm';
import { adyenRefusedMessage, readAdyenConfig, shopperBrowser } from './config';

/**
 * Saves a card with Adyen: a zero-value authorization that stores the card. The payload
 * is the Card state.data plus the setup session's currency (Adyen provider contract).
 */
export function AdyenCardSetup({
  session,
  submit,
  submitDetails,
  onSaved,
  onCancel,
}: CardSetupProps): React.JSX.Element {
  const { t } = useTranslation();
  const config = useMemo(() => readAdyenConfig(session), [session]);
  const currency = typeof session['currency'] === 'string' ? session['currency'] : null;

  if (config == null || currency == null) {
    return <p className="text-sm text-destructive">{t('payments.cardSetupFailed')}</p>;
  }

  function toStep(result: SetupStepResult): AdyenStep {
    if (result.status === 'saved') {
      onSaved();
      return { status: 'done' };
    }
    if (result.status === 'refused') {
      return { status: 'refused', message: adyenRefusedMessage(result.reason, t) };
    }
    return { status: 'action', action: result.action.data };
  }

  return (
    <AdyenCardForm
      config={config}
      submitLabel={t('payments.saveCard')}
      busyLabel={t('common.saving')}
      errorKey="payments.failedSave"
      onSubmitData={async (data) =>
        toStep(await submit({ ...data, currency }, shopperBrowser(data.browserInfo)))
      }
      onDetails={async (data) => toStep(await submitDetails(data))}
      onCancel={onCancel}
    />
  );
}
