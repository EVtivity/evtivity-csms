// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, getApiErrorCode, getApiErrorFieldDetails } from '@/lib/api';
import { formatCents } from '@/lib/utils';
import type { GuestPayResult, GuestPaymentProps } from '../types';
import { AdyenCardForm, type AdyenStep } from './AdyenCardForm';
import { adyenRefusedMessage, readAdyenConfig, shopperBrowser } from './config';

/**
 * Guest checkout with Adyen: a one-time card for the pre-authorization hold. A card
 * that asks for 3D Secure gets its action here (native challenge) or leaves the page
 * for the issuer and comes back to /payments/return?flow=guest.
 */
export function AdyenGuestPayment({
  config,
  amountCents,
  currency,
  countryCode,
  disabled,
  pay,
  payDetails,
}: GuestPaymentProps): React.JSX.Element {
  const { t } = useTranslation();
  // Adyen Web refuses to start without a countryCode (the company country).
  const adyen = useMemo(
    () =>
      readAdyenConfig(countryCode != null ? { ...config, countryCode } : config, {
        value: amountCents,
        currency,
      }),
    [config, countryCode, amountCents, currency],
  );
  // The guest session the 3D Secure step belongs to.
  const sessionToken = useRef<string | null>(null);

  if (adyen == null) {
    return <p className="text-sm text-destructive">{t('guest.paymentNotConfigured')}</p>;
  }

  function toStep(result: GuestPayResult): AdyenStep {
    if (result.status === 'action_required') {
      sessionToken.current = result.sessionToken;
      return { status: 'action', action: result.action.data };
    }
    return { status: 'done' };
  }

  /** A refused card is a 400 PAYMENT_FAILED; the guest session failed, so start over. */
  async function guarded(step: () => Promise<GuestPayResult>): Promise<AdyenStep> {
    try {
      return toStep(await step());
    } catch (err: unknown) {
      if (err instanceof ApiError && getApiErrorCode(err) === 'PAYMENT_FAILED') {
        sessionToken.current = null;
        const reason = getApiErrorFieldDetails(err)['reason'];
        return {
          status: 'refused',
          message: reason != null ? adyenRefusedMessage(reason, t) : t('guest.paymentFailed'),
        };
      }
      throw err;
    }
  }

  return (
    <AdyenCardForm
      config={adyen}
      submitLabel={t('guest.startCharging')}
      busyLabel={t('guest.processing')}
      errorKey="guest.paymentFailed"
      disabled={disabled}
      onSubmitData={(data) => guarded(() => pay(data, shopperBrowser(data.browserInfo)))}
      onDetails={(data) =>
        guarded(() => {
          const token = sessionToken.current;
          if (token == null) throw new Error(t('guest.paymentFailed'));
          return payDetails(token, data);
        })
      }
      note={
        <p className="text-xs text-muted-foreground">
          {t('guest.preAuthHold', { amount: formatCents(amountCents, currency) })}
        </p>
      }
    />
  );
}
