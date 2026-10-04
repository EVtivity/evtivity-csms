// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { LoadingLogo } from '@/components/loading-logo';
import { useToast } from '@/components/ui/toast';
import { ApiError, getApiErrorCode, getApiErrorFieldDetails } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { cn } from '@/lib/utils';
import { submitGuestPaymentDetails, submitSetupDetails } from '@/payments/api';
import { adyenRefusedMessage } from '@/payments/adyen/config';
import { refusedMessage } from '@/payments/simulated/cards';

// `/payments/return`: where the card issuer sends the shopper back after a 3D Secure
// redirect (plan P10 Part B builds the URL). Card saves come back with
// `flow=method&provider=&attemptId=`, guest checkouts with `flow=guest&token=`; the
// provider appends `redirectResult`, which goes to the matching details route.

export type ReturnRequest =
  | { flow: 'method'; provider: string; attemptId: string; redirectResult: string }
  | { flow: 'guest'; token: string; redirectResult: string };

/** The request the return URL describes, or null when a part is missing. */
export function parseReturn(params: URLSearchParams): ReturnRequest | null {
  const redirectResult = params.get('redirectResult');
  if (redirectResult == null || redirectResult === '') return null;
  const flow = params.get('flow');
  if (flow === 'method') {
    const provider = params.get('provider');
    const attemptId = params.get('attemptId');
    if (provider == null || provider === '' || attemptId == null || attemptId === '') return null;
    return { flow, provider, attemptId, redirectResult };
  }
  if (flow === 'guest') {
    const token = params.get('token');
    if (token == null || token === '') return null;
    return { flow, token, redirectResult };
  }
  return null;
}

type View =
  | { kind: 'working' }
  | { kind: 'invalid' }
  | { kind: 'refused'; message: string }
  | { kind: 'failed'; message: string };

function refusedText(provider: string, reason: string, t: TFunction): string {
  return provider === 'adyen' ? adyenRefusedMessage(reason, t) : refusedMessage(reason, t);
}

export function PaymentReturn(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { companyName, companyLogo, branding } = useAuthBranding();
  const [searchParams] = useSearchParams();
  const [request] = useState(() => parseReturn(searchParams));
  const [view, setView] = useState<View>(
    request == null ? { kind: 'invalid' } : { kind: 'working' },
  );
  const sent = useRef(false);

  const complete = useCallback(async (): Promise<void> => {
    if (request == null) return;
    setView({ kind: 'working' });
    // The details routes are idempotent: a reload or retry replays the same result.
    const details = { details: { redirectResult: request.redirectResult } };
    try {
      if (request.flow === 'method') {
        const result = await submitSetupDetails(request.attemptId, request.provider, details);
        if (result.status === 'saved') {
          toast({ variant: 'success', title: t('paymentProviders.adyen.return.cardSaved') });
          void navigate('/payment-methods', { replace: true });
          return;
        }
        if (result.status === 'refused') {
          setView({ kind: 'refused', message: refusedText(request.provider, result.reason, t) });
          return;
        }
        setView({ kind: 'failed', message: t('paymentProviders.adyen.return.failed') });
        return;
      }
      const result = await submitGuestPaymentDetails(request.token, details);
      if (result.status === 'action_required') {
        setView({ kind: 'failed', message: t('paymentProviders.adyen.return.failed') });
        return;
      }
      void navigate(`/guest-session/${encodeURIComponent(request.token)}`, { replace: true });
    } catch (err: unknown) {
      if (err instanceof ApiError && getApiErrorCode(err) === 'PAYMENT_FAILED') {
        const reason = getApiErrorFieldDetails(err)['reason'];
        setView({
          kind: 'refused',
          message: reason != null ? adyenRefusedMessage(reason, t) : t('guest.paymentFailed'),
        });
        return;
      }
      setView({
        kind: 'failed',
        message: getErrorMessage(err, t, 'paymentProviders.adyen.return.failed'),
      });
    }
  }, [request, navigate, t, toast]);

  useEffect(() => {
    // One post per page load (React runs effects twice in development).
    if (sent.current) return;
    sent.current = true;
    void complete();
  }, [complete]);

  const back =
    request?.flow === 'guest'
      ? {
          to: `/guest-session/${encodeURIComponent(request.token)}`,
          label: t('paymentProviders.adyen.return.viewSession'),
        }
      : request?.flow === 'method'
        ? { to: '/payment-methods', label: t('paymentProviders.adyen.return.backToMethods') }
        : { to: '/', label: t('paymentProviders.adyen.return.home') };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <AuthBranding companyName={companyName} companyLogo={companyLogo} />
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <h2 className="text-2xl font-semibold">{t('paymentProviders.adyen.return.title')}</h2>
        </CardHeader>
        <CardContent className="space-y-4">
          {view.kind === 'working' && (
            <>
              <LoadingLogo size="inline" />
              <p className="text-center text-sm text-muted-foreground">
                {t('paymentProviders.adyen.return.processing')}
              </p>
            </>
          )}
          {view.kind === 'invalid' && (
            <p className="text-sm text-destructive">{t('paymentProviders.adyen.return.invalid')}</p>
          )}
          {(view.kind === 'refused' || view.kind === 'failed') && (
            <p className="text-sm text-destructive" role="alert">
              {view.message}
            </p>
          )}
          {view.kind === 'failed' && (
            <Button className="w-full" onClick={() => void complete()}>
              {t('errors.retry')}
            </Button>
          )}
          {view.kind !== 'working' && (
            <Link to={back.to} className={cn(buttonVariants({ variant: 'outline' }), 'w-full')}>
              {back.label}
            </Link>
          )}
        </CardContent>
      </Card>
      <AuthFooter companyName={companyName} branding={branding} />
    </div>
  );
}
