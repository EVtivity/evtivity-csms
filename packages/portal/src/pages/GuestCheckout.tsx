// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { loadStripe } from '@stripe/stripe-js/pure';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ErrorCard } from '@/components/ui/error-card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EvPlugAnimation } from '@/components/EvPlugAnimation';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { api } from '@/lib/api';
import { formatCents } from '@/lib/utils';
import { checkGuestConnectorStatus, isCableDetected } from '@/lib/charger-utils';

interface ChargerConfig {
  isFree: boolean;
  isSimulator?: boolean;
  publishableKey?: string;
  currency?: string;
  preAuthAmountCents?: number;
}

function FreeStartForm({
  stationId,
  evseId,
  isSimulator,
}: {
  stationId: string;
  evseId: string;
  isSimulator: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const [showEvWarning, setShowEvWarning] = useState(false);

  async function doStart(): Promise<void> {
    setLoading(true);
    setError('');
    try {
      const result = await api.post<{ sessionToken: string }>(
        `/v1/portal/guest/start/${stationId}/${evseId}`,
        {},
      );
      void navigate(`/guest-session/${result.sessionToken}`);
    } catch (err: unknown) {
      if (err != null && typeof err === 'object' && 'body' in err) {
        const body = (err as { body: { error?: string } }).body;
        setError(body.error ?? t('guest.paymentFailed'));
      } else {
        setError(t('guest.paymentFailed'));
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.SyntheticEvent): Promise<void> {
    e.preventDefault();
    setError('');
    setIsCheckingStatus(true);
    try {
      const result = await checkGuestConnectorStatus(stationId, evseId);
      setIsCheckingStatus(false);

      if (result.error != null) {
        setError(result.error);
        return;
      }

      if (!isCableDetected(result.connectorStatus)) {
        setShowEvWarning(true);
        return;
      }

      await doStart();
    } catch {
      setIsCheckingStatus(false);
      setError(t('charger.statusCheckFailed'));
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      {error !== '' && <p className="text-sm text-destructive">{error}</p>}
      <p className="text-sm text-muted-foreground">{t('charger.freeCharging')}</p>
      <Button type="submit" className="w-full" size="lg" disabled={loading || isCheckingStatus}>
        {isCheckingStatus
          ? t('charger.checkingStatus')
          : loading
            ? t('guest.processing')
            : t('charger.startCharging')}
      </Button>
      <ConfirmDialog
        open={showEvWarning}
        onOpenChange={setShowEvWarning}
        title={t('charger.evNotDetectedTitle')}
        description={t('charger.evNotDetectedDescription')}
        confirmLabel={isSimulator ? t('charger.startForSimulation') : t('common.ok')}
        hideCancel={!isSimulator}
        onConfirm={() => {
          if (!isSimulator) return;
          void doStart();
        }}
      >
        <EvPlugAnimation />
      </ConfirmDialog>
    </form>
  );
}

function CheckoutForm({
  stationId,
  evseId,
  config,
  isSimulator,
}: {
  stationId: string;
  evseId: string;
  config: ChargerConfig;
  isSimulator: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const stripe = useStripe();
  const elements = useElements();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const [showEvWarning, setShowEvWarning] = useState(false);

  async function doCheckoutAndStart(): Promise<void> {
    if (stripe == null || elements == null) return;
    setLoading(true);
    setError('');
    try {
      const cardElement = elements.getElement(CardElement);
      if (cardElement == null) return;

      // Create a payment method from the card element
      const { paymentMethod, error: pmError } = await stripe.createPaymentMethod({
        type: 'card',
        card: cardElement,
        billing_details: { email },
      });

      if (pmError != null) {
        const errorKey = pmError.decline_code ?? pmError.code ?? 'generic';
        const knownErrors: Record<string, string> = {
          card_declined: t('guest.cardDeclined'),
          expired_card: t('guest.cardExpired'),
          incorrect_cvc: t('guest.incorrectCvc'),
          insufficient_funds: t('guest.insufficientFunds'),
          processing_error: t('guest.processingError'),
        };
        setError(knownErrors[errorKey] ?? pmError.message ?? t('guest.cardError'));
        return;
      }

      // Start guest session
      const result = await api.post<{ sessionToken: string }>(
        `/v1/portal/guest/start/${stationId}/${evseId}`,
        {
          paymentMethodId: paymentMethod.id,
          guestEmail: email,
        },
      );

      void navigate(`/guest-session/${result.sessionToken}`);
    } catch (err: unknown) {
      if (err != null && typeof err === 'object' && 'body' in err) {
        const body = (err as { body: { error?: string } }).body;
        setError(body.error ?? t('guest.paymentFailed'));
      } else {
        setError(t('guest.paymentFailed'));
      }
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (stripe == null || elements == null) return;
    if (loading || isCheckingStatus) return; // Guard against double-submit

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (email.trim() === '') {
      setEmailError(t('guest.emailRequired'));
      return;
    }
    if (!emailRegex.test(email)) {
      setEmailError(t('guest.emailInvalid'));
      return;
    }
    setEmailError('');
    setError('');
    setIsCheckingStatus(true);
    try {
      const result = await checkGuestConnectorStatus(stationId, evseId);
      setIsCheckingStatus(false);

      if (result.error != null) {
        setError(result.error);
        return;
      }

      if (!isCableDetected(result.connectorStatus)) {
        setShowEvWarning(true);
        return;
      }

      await doCheckoutAndStart();
    } catch {
      setIsCheckingStatus(false);
      setError(t('charger.statusCheckFailed'));
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      {error !== '' && <p className="text-sm text-destructive">{error}</p>}
      <div className="space-y-2">
        <label htmlFor="guestEmail" className="text-sm font-medium">
          {t('guest.emailForReceipt')}
        </label>
        <Input
          id="guestEmail"
          type="text"
          inputMode="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (emailError !== '') setEmailError('');
          }}
          autoComplete="email"
          placeholder="you@example.com"
          aria-invalid={emailError !== '' || undefined}
          aria-describedby={emailError !== '' ? 'guest-email-error' : undefined}
          className={emailError !== '' ? 'border-destructive focus-visible:ring-destructive' : ''}
        />
        {emailError !== '' && (
          <p id="guest-email-error" className="text-xs text-destructive mt-1">
            {emailError}
          </p>
        )}
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">{t('guest.card')}</label>
        <div className="rounded-lg border border-input p-3">
          <CardElement
            options={{
              style: {
                base: {
                  fontSize: '16px',
                  color: document.documentElement.classList.contains('dark')
                    ? '#f8fafc'
                    : '#020817',
                  '::placeholder': {
                    color: document.documentElement.classList.contains('dark')
                      ? '#94a3b8'
                      : '#64748b',
                  },
                },
              },
            }}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('guest.preAuthHold', {
          amount: formatCents(config.preAuthAmountCents, config.currency),
        })}
      </p>
      <Button type="submit" className="w-full" size="lg" disabled={loading || isCheckingStatus}>
        {isCheckingStatus
          ? t('charger.checkingStatus')
          : loading
            ? t('guest.processing')
            : t('guest.startCharging')}
      </Button>
      <ConfirmDialog
        open={showEvWarning}
        onOpenChange={setShowEvWarning}
        title={t('charger.evNotDetectedTitle')}
        description={t('charger.evNotDetectedDescription')}
        confirmLabel={isSimulator ? t('charger.startForSimulation') : t('common.ok')}
        hideCancel={!isSimulator}
        onConfirm={() => {
          if (!isSimulator) return;
          void doCheckoutAndStart();
        }}
      >
        <EvPlugAnimation />
      </ConfirmDialog>
    </form>
  );
}

export function GuestCheckout(): React.JSX.Element {
  const { t } = useTranslation();
  const { stationId, evseId } = useParams<{ stationId: string; evseId: string }>();
  const navigate = useNavigate();
  const { companyName, companyLogo, branding } = useAuthBranding();
  const [config, setConfig] = useState<ChargerConfig | null>(null);
  const [stripePromise, setStripePromise] = useState<ReturnType<typeof loadStripe> | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (stationId == null || evseId == null) return;

    api
      .get<ChargerConfig>(`/v1/portal/guest/charger-config/${stationId}/${evseId}`)
      .then((data) => {
        setConfig(data);
        if (!data.isFree && data.publishableKey != null) {
          setStripePromise(loadStripe(data.publishableKey));
        } else if (!data.isFree) {
          setError(t('guest.paymentNotConfigured'));
        }
      })
      .catch(() => {
        setError(t('guest.paymentNotConfigured'));
      });
  }, [stationId, evseId, t]);

  if (error !== '') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-4">
        <AuthBranding companyName={companyName} companyLogo={companyLogo} />
        <ErrorCard message={error} />
        <AuthFooter companyName={companyName} branding={branding} />
      </div>
    );
  }

  if (config == null || (!config.isFree && stripePromise == null)) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">{t('guest.loadingPayment')}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-4">
      <AuthBranding companyName={companyName} companyLogo={companyLogo} />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('common.back')}
              onClick={() => {
                void navigate(-1);
              }}
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <CardTitle>{t('guest.checkoutTitle')}</CardTitle>
              <CardDescription>{t('guest.stationPort', { stationId, evseId })}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {config.isFree ? (
            <FreeStartForm
              stationId={stationId ?? ''}
              evseId={evseId ?? ''}
              isSimulator={config.isSimulator === true}
            />
          ) : stripePromise != null ? (
            <Elements stripe={stripePromise}>
              <CheckoutForm
                stationId={stationId ?? ''}
                evseId={evseId ?? ''}
                config={config}
                isSimulator={config.isSimulator === true}
              />
            </Elements>
          ) : null}
        </CardContent>
      </Card>
      <AuthFooter companyName={companyName} branding={branding} />
    </div>
  );
}
