// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ErrorCard } from '@/components/ui/error-card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { EvPlugAnimation } from '@/components/EvPlugAnimation';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { checkGuestConnectorStatus, qrTransactionLimits } from '@/lib/charger-utils';
import { useCableCheck } from '@/hooks/use-cable-check';
import { ProviderHost } from '@/payments/ProviderHost';
import { submitGuestPaymentDetails, type GuestStartResponse } from '@/payments/api';
import type { ClientConfig, GuestPayResult, ShopperBrowser } from '@/payments/types';

interface ChargerConfig {
  isFree: boolean;
  isSimulator?: boolean;
  /** Client config of the active payment provider; null when payments are off. */
  paymentProvider?: ClientConfig | null;
  currency?: string;
  /** Company country; Adyen Web needs it. */
  countryCode?: string | null;
  preAuthAmountCents?: number;
}

/** The paid checkout terms: present only when a provider and its hold terms are. */
interface PaidCheckout {
  provider: ClientConfig;
  currency: string;
  countryCode: string | null;
  preAuthAmountCents: number;
}

function paidCheckout(config: ChargerConfig): PaidCheckout | null {
  if (config.paymentProvider == null || config.currency == null) return null;
  if (config.preAuthAmountCents == null) return null;
  return {
    provider: config.paymentProvider,
    currency: config.currency,
    countryCode: config.countryCode ?? null,
    preAuthAmountCents: config.preAuthAmountCents,
  };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { isCheckingStatus, showEvWarning, setShowEvWarning, runWithCableCheck } = useCableCheck();

  async function doStart(): Promise<void> {
    setLoading(true);
    setError('');
    try {
      const result = await api.post<{ sessionToken: string }>(
        `/v1/portal/guest/start/${stationId}/${evseId}`,
        qrTransactionLimits(searchParams),
      );
      void navigate(`/guest-session/${result.sessionToken}`);
    } catch (err: unknown) {
      setError(getErrorMessage(err, t, 'guest.paymentFailed'));
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.SyntheticEvent): Promise<void> {
    e.preventDefault();
    await runWithCableCheck(
      () => checkGuestConnectorStatus(stationId, evseId),
      () => doStart(),
      setError,
    );
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
        confirmLabel={t('common.ok')}
        hideCancel
        onConfirm={() => undefined}
      >
        <EvPlugAnimation />
        {isSimulator && (
          <Alert variant="info" className="mt-4">
            <Info className="h-4 w-4" />
            <AlertDescription>{t('charger.simulatorPlugInHint')}</AlertDescription>
          </Alert>
        )}
      </ConfirmDialog>
    </form>
  );
}

function CheckoutForm({
  stationId,
  evseId,
  checkout,
  isSimulator,
}: {
  stationId: string;
  evseId: string;
  checkout: PaidCheckout;
  isSimulator: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [error, setError] = useState('');
  const { isCheckingStatus, showEvWarning, setShowEvWarning, runWithCableCheck } = useCableCheck();

  function validateEmail(): boolean {
    if (email.trim() === '') {
      setEmailError(t('guest.emailRequired'));
      return false;
    }
    if (!EMAIL_PATTERN.test(email)) {
      setEmailError(t('guest.emailInvalid'));
      return false;
    }
    setEmailError('');
    return true;
  }

  /** Navigates to the session once charging started, or hands the 3D Secure action back. */
  function guestOutcome(result: GuestStartResponse): GuestPayResult {
    if (result.status === 'action_required' && result.action != null) {
      return {
        status: 'action_required',
        sessionToken: result.sessionToken,
        action: result.action,
      };
    }
    void navigate(`/guest-session/${result.sessionToken}`);
    return { status: 'done' };
  }

  /**
   * GuestPaymentProps.pay: resolves when this host handled the outcome (navigation,
   * email field error, cable check) or with a 3D Secure action, rejects with the start
   * error for the module to show.
   */
  async function pay(payload: unknown, browser?: ShopperBrowser): Promise<GuestPayResult> {
    if (!validateEmail()) return { status: 'done' };
    // runWithCableCheck reports its own errors; a start error goes back to the module.
    const start: { failed: boolean; error: unknown; result: GuestPayResult } = {
      failed: false,
      error: null,
      result: { status: 'done' },
    };
    await runWithCableCheck(
      () => checkGuestConnectorStatus(stationId, evseId),
      async () => {
        try {
          const result = await api.post<GuestStartResponse>(
            `/v1/portal/guest/start/${stationId}/${evseId}`,
            {
              paymentMethod: {
                provider: checkout.provider.provider,
                payload,
                ...(browser != null ? { browser } : {}),
              },
              guestEmail: email,
              ...qrTransactionLimits(searchParams),
            },
          );
          start.result = guestOutcome(result);
        } catch (err: unknown) {
          start.failed = true;
          start.error = err;
        }
      },
      setError,
    );
    if (start.failed) throw start.error;
    return start.result;
  }

  /** GuestPaymentProps.payDetails: the 3D Secure result of a started guest session. */
  async function payDetails(sessionToken: string, details: unknown): Promise<GuestPayResult> {
    return guestOutcome(await submitGuestPaymentDetails(sessionToken, details));
  }

  return (
    <div className="space-y-4">
      {error !== '' && <p className="text-sm text-destructive">{error}</p>}
      <div className="space-y-2">
        <label htmlFor="guestEmail" className="block text-sm font-medium leading-6">
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
      <ProviderHost
        provider={checkout.provider.provider}
        component="GuestPayment"
        props={{
          config: checkout.provider,
          amountCents: checkout.preAuthAmountCents,
          currency: checkout.currency,
          ...(checkout.countryCode != null ? { countryCode: checkout.countryCode } : {}),
          disabled: isCheckingStatus,
          pay,
          payDetails,
        }}
      />
      {isCheckingStatus && (
        <p className="text-sm text-muted-foreground">{t('charger.checkingStatus')}</p>
      )}
      <ConfirmDialog
        open={showEvWarning}
        onOpenChange={setShowEvWarning}
        title={t('charger.evNotDetectedTitle')}
        description={t('charger.evNotDetectedDescription')}
        confirmLabel={t('common.ok')}
        hideCancel
        onConfirm={() => undefined}
      >
        <EvPlugAnimation />
        {isSimulator && (
          <Alert variant="info" className="mt-4">
            <Info className="h-4 w-4" />
            <AlertDescription>{t('charger.simulatorPlugInHint')}</AlertDescription>
          </Alert>
        )}
      </ConfirmDialog>
    </div>
  );
}

export function GuestCheckout(): React.JSX.Element {
  const { t } = useTranslation();
  const { stationId, evseId } = useParams<{ stationId: string; evseId: string }>();
  const navigate = useNavigate();
  const { companyName, companyLogo, branding } = useAuthBranding();
  const [config, setConfig] = useState<ChargerConfig | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (stationId == null || evseId == null) return;

    api
      .get<ChargerConfig>(`/v1/portal/guest/charger-config/${stationId}/${evseId}`)
      .then((data) => {
        setConfig(data);
        if (!data.isFree && paidCheckout(data) == null) {
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

  const checkout = config != null && !config.isFree ? paidCheckout(config) : null;
  if (config == null || (!config.isFree && checkout == null)) {
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
          ) : checkout != null ? (
            <CheckoutForm
              stationId={stationId ?? ''}
              evseId={evseId ?? ''}
              checkout={checkout}
              isSimulator={config.isSimulator === true}
            />
          ) : null}
        </CardContent>
      </Card>
      <AuthFooter companyName={companyName} branding={branding} />
    </div>
  );
}
