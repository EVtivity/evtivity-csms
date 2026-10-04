// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AdyenCheckout,
  Card,
  type AdditionalDetailsActions,
  type AdditionalDetailsData,
  type PaymentAction,
  type PaymentData,
  type SubmitActions,
} from '@adyen/adyen-web';
import '@adyen/adyen-web/styles/adyen.css';
import './adyen-theme.css';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { getErrorMessage } from '@/lib/error-message';
import { actionResultCode, adyenLocale, cardFieldStyles, type AdyenCheckoutConfig } from './config';

/** The answer of the host for one card step. */
export type AdyenStep =
  | { status: 'done' }
  | { status: 'action'; action: unknown }
  | { status: 'refused'; message: string };

export interface AdyenCardFormProps {
  config: AdyenCheckoutConfig;
  submitLabel: string;
  busyLabel: string;
  /** i18n key of the message for an unexpected error (network, API). */
  errorKey: string;
  disabled?: boolean;
  /** The Card component's state.data; the host posts it to the API. */
  onSubmitData: (data: PaymentData) => Promise<AdyenStep>;
  /** onAdditionalDetails state.data (`{ details, paymentData? }`) after a 3D Secure step. */
  onDetails: (data: AdditionalDetailsData['data']) => Promise<AdyenStep>;
  /** Text under the card fields (hold amount). */
  note?: React.ReactNode;
  onCancel?: () => void;
}

type Phase = 'loading' | 'ready' | 'busy' | 'action' | 'failed';

/**
 * Adyen Web Card component (Advanced flow, plan P10 Part C). The card fields are Adyen
 * iframes; this component posts state.data through the host, hands a 3D Secure action
 * back to Adyen Web (a redirect leaves the page for /payments/return, a native challenge
 * mounts in place and comes back through onAdditionalDetails), and remounts a fresh card
 * after a refusal or error that followed an action.
 */
export function AdyenCardForm({
  config,
  submitLabel,
  busyLabel,
  errorKey,
  disabled = false,
  onSubmitData,
  onDetails,
  note,
  onCancel,
}: AdyenCardFormProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const nodeRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<Card | null>(null);
  const actionStarted = useRef(false);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');
  const [mountKey, setMountKey] = useState(0);

  // The checkout is created once per mount; callbacks read the latest props.
  const latest = useRef({ onSubmitData, onDetails, t, errorKey });
  latest.current = { onSubmitData, onDetails, t, errorKey };

  useEffect(() => {
    const node = nodeRef.current;
    if (node == null) return;
    // Mutable flag object: cleanup flips it after the async start has begun.
    const run = { active: true };
    actionStarted.current = false;
    setPhase('loading');

    function resetAfterFailure(): void {
      if (!run.active) return;
      if (actionStarted.current) {
        // The action replaced the card in the node: start over with an empty card.
        setMountKey((n) => n + 1);
        return;
      }
      cardRef.current?.setStatus('ready');
      setPhase('ready');
    }

    function resolveStep(step: AdyenStep, actions: SubmitActions | AdditionalDetailsActions): void {
      if (step.status === 'action') {
        actionStarted.current = true;
        setPhase('action');
        actions.resolve({
          resultCode: actionResultCode(step.action),
          action: step.action as PaymentAction,
        });
        return;
      }
      if (step.status === 'refused') {
        setError(step.message);
        actions.resolve({ resultCode: 'Refused' });
        return;
      }
      actions.resolve({ resultCode: 'Authorised' });
    }

    async function runStep(
      step: () => Promise<AdyenStep>,
      actions: SubmitActions | AdditionalDetailsActions,
    ): Promise<void> {
      setError('');
      setPhase('busy');
      try {
        resolveStep(await step(), actions);
      } catch (err: unknown) {
        const { t: tr, errorKey: key } = latest.current;
        setError(getErrorMessage(err, tr, key));
        actions.reject();
      }
    }

    void (async () => {
      try {
        const checkout = await AdyenCheckout({
          clientKey: config.clientKey,
          environment: config.environment,
          locale: adyenLocale(i18n.language),
          countryCode: config.countryCode,
          ...(config.amount != null ? { amount: config.amount } : {}),
          ...(config.paymentMethodsResponse != null
            ? { paymentMethodsResponse: config.paymentMethodsResponse }
            : {}),
          showPayButton: false,
          onSubmit: (state, _component, actions) => {
            void runStep(() => latest.current.onSubmitData(state.data), actions);
          },
          onAdditionalDetails: (state, _component, actions) => {
            void runStep(() => latest.current.onDetails(state.data), actions);
          },
          onPaymentCompleted: () => {
            if (!run.active) return;
            cardRef.current?.setStatus('ready');
            setPhase('ready');
          },
          onPaymentFailed: () => {
            resetAfterFailure();
          },
          onError: (err) => {
            if (!run.active || err.name === 'CANCEL') return;
            console.error('Adyen Web error:', err);
            setError(latest.current.t('paymentProviders.adyen.error'));
            resetAfterFailure();
          },
        });
        if (!run.active) return;
        const card = new Card(checkout, {
          hasHolderName: false,
          enableStoreDetails: false,
          styles: cardFieldStyles(),
        });
        card.mount(node);
        cardRef.current = card;
        setPhase('ready');
      } catch (err: unknown) {
        // AdyenCheckout rejects an unusable configuration (client key, environment, country).
        console.error('Adyen Web failed to start:', err);
        if (run.active) setPhase('failed');
      }
    })();

    return () => {
      run.active = false;
      cardRef.current?.unmount();
      cardRef.current = null;
    };
  }, [config, i18n.language, mountKey]);

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    if (phase !== 'ready' || disabled) return;
    // Validates the fields and calls onSubmit when they are complete.
    cardRef.current?.submit();
  }

  if (phase === 'failed') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{t('paymentProviders.loadFailed')}</p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            // Render the card node again before the effect mounts into it.
            setPhase('loading');
            setMountKey((n) => n + 1);
          }}
        >
          {t('errors.retry')}
        </Button>
      </div>
    );
  }

  const busy = phase === 'busy' || phase === 'loading';
  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {error !== '' && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {phase === 'action' && (
        <p className="text-sm text-muted-foreground">{t('paymentProviders.adyen.authenticate')}</p>
      )}
      {phase === 'loading' && (
        <div className="flex justify-center py-4" role="status" aria-label={t('common.loading')}>
          <Spinner className="h-6 w-6" />
        </div>
      )}
      <div key={mountKey} ref={nodeRef} className="evt-adyen" data-testid="adyen-card" />
      {note}
      <div className="flex gap-2">
        {phase !== 'action' && (
          <Button type="submit" className="flex-1" disabled={busy || disabled}>
            {phase === 'busy' ? busyLabel : submitLabel}
          </Button>
        )}
        {onCancel != null && (
          <Button
            type="button"
            variant="outline"
            className={phase === 'action' ? 'flex-1' : undefined}
            onClick={onCancel}
            disabled={phase === 'busy'}
          >
            {t('common.cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}
