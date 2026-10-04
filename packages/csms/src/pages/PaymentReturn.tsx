// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingLogo } from '@/components/loading-logo';
import { useToast } from '@/components/ui/toast';
import { getErrorMessage } from '@/lib/error-message';
import { cn } from '@/lib/utils';
import { submitSetupDetails } from '@/payments/api';
import { adyenRefusedMessage } from '@/payments/adyen/config';

// `/payments/return`: where the card issuer sends the operator back after a 3D Secure
// redirect while adding a driver's card (plan P10 Part B builds the URL
// `?flow=method&provider=&attemptId=&driverId=`). The provider appends `redirectResult`,
// which goes to the driver's setup/details route.

export interface ReturnRequest {
  provider: string;
  attemptId: string;
  driverId: string;
  redirectResult: string;
}

/** The request the return URL describes, or null when a part is missing. */
export function parseReturn(params: URLSearchParams): ReturnRequest | null {
  if (params.get('flow') !== 'method') return null;
  const values = ['provider', 'attemptId', 'driverId', 'redirectResult'].map((key) =>
    params.get(key),
  );
  const [provider, attemptId, driverId, redirectResult] = values;
  if (
    provider == null ||
    provider === '' ||
    attemptId == null ||
    attemptId === '' ||
    driverId == null ||
    driverId === '' ||
    redirectResult == null ||
    redirectResult === ''
  ) {
    return null;
  }
  return { provider, attemptId, driverId, redirectResult };
}

type View =
  | { kind: 'working' }
  | { kind: 'invalid' }
  | { kind: 'refused'; message: string }
  | { kind: 'failed'; message: string };

export function PaymentReturn(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const [request] = useState(() => parseReturn(searchParams));
  const [view, setView] = useState<View>(
    request == null ? { kind: 'invalid' } : { kind: 'working' },
  );
  const sent = useRef(false);

  const complete = useCallback(async (): Promise<void> => {
    if (request == null) return;
    setView({ kind: 'working' });
    try {
      // Idempotent: a reload or retry replays the same result.
      const result = await submitSetupDetails(
        request.driverId,
        request.attemptId,
        request.provider,
        { details: { redirectResult: request.redirectResult } },
      );
      if (result.status === 'saved') {
        toast({ variant: 'success', title: t('paymentProviders.adyen.return.cardSaved') });
        void navigate(`/drivers/${encodeURIComponent(request.driverId)}?tab=payment-methods`, {
          replace: true,
        });
        return;
      }
      if (result.status === 'refused') {
        setView({ kind: 'refused', message: adyenRefusedMessage(result.reason, t) });
        return;
      }
      setView({ kind: 'failed', message: t('paymentProviders.adyen.return.failed') });
    } catch (err: unknown) {
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

  const backTo =
    request != null
      ? `/drivers/${encodeURIComponent(request.driverId)}?tab=payment-methods`
      : '/drivers';

  return (
    <div className="mx-auto max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>{t('paymentProviders.adyen.return.title')}</CardTitle>
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
              {t('common.retry')}
            </Button>
          )}
          {view.kind !== 'working' && (
            <Link to={backTo} className={cn(buttonVariants({ variant: 'outline' }), 'w-full')}>
              {t('paymentProviders.adyen.return.backToDriver')}
            </Link>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
