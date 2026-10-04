// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { LoadingLogo } from '@/components/loading-logo';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

// Public pages of a site host's Stripe payout onboarding (plan P3.5 O4). The
// site host has no login: the operator's 7-day link carries the token, which
// the page posts in the body. `/payout-onboarding` mints a fresh Stripe
// onboarding link on each visit and redirects to it (Stripe links expire
// after minutes); `/payout-onboarding/return` is Stripe's return URL and
// shows the account status.

type PayoutState = 'onboarding' | 'action_required' | 'pending' | 'active' | 'disabled';

type ViewState =
  | { kind: 'loading' }
  | { kind: 'redirecting' }
  | { kind: 'status'; status: PayoutState }
  | { kind: 'invalid' }
  | { kind: 'unavailable' }
  | { kind: 'failed' };

function errorView(err: unknown): ViewState {
  if (err instanceof ApiError) {
    const code = (err.body as { code?: unknown } | null)?.code;
    if (code === 'INVALID_TOKEN') return { kind: 'invalid' };
    if (code === 'PAYMENT_PROVIDER_NOT_CONFIGURED') return { kind: 'unavailable' };
  }
  return { kind: 'failed' };
}

/** Leaves the portal for the Stripe-hosted onboarding page. */
export function openStripeOnboarding(url: string): void {
  window.location.assign(url);
}

function PayoutOnboardingShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { t } = useTranslation();
  const { companyName, companyLogo, branding } = useAuthBranding();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <AuthBranding companyName={companyName} companyLogo={companyLogo} />
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <h2 className="text-2xl font-semibold">{t('payoutOnboarding.title')}</h2>
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
      </Card>
      <AuthFooter companyName={companyName} branding={branding} />
    </div>
  );
}

function StatusMessage({
  view,
  token,
  onRetry,
}: {
  view: ViewState;
  token: string;
  onRetry: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  switch (view.kind) {
    case 'loading':
      return <LoadingLogo size="inline" />;
    case 'redirecting':
      return (
        <>
          <LoadingLogo size="inline" />
          <p className="text-center text-sm text-muted-foreground">
            {t('payoutOnboarding.redirecting')}
          </p>
        </>
      );
    case 'invalid':
      return (
        <>
          <p className="text-sm text-destructive">{t('payoutOnboarding.invalidLink')}</p>
          <p className="text-sm text-muted-foreground">{t('payoutOnboarding.askOperator')}</p>
        </>
      );
    case 'unavailable':
      return <p className="text-sm text-destructive">{t('payoutOnboarding.notAvailable')}</p>;
    case 'failed':
      return (
        <>
          <p className="text-sm text-destructive">{t('payoutOnboarding.failed')}</p>
          <Button variant="outline" className="w-full" onClick={onRetry}>
            {t('errors.retry')}
          </Button>
        </>
      );
    case 'status':
      if (view.status === 'active') {
        return <p className="text-sm text-success">{t('payoutOnboarding.ready')}</p>;
      }
      if (view.status === 'pending') {
        return <p className="text-sm text-muted-foreground">{t('payoutOnboarding.pending')}</p>;
      }
      if (view.status === 'disabled') {
        return <p className="text-sm text-destructive">{t('payoutOnboarding.disabled')}</p>;
      }
      return (
        <>
          <p className="text-sm text-muted-foreground">
            {view.status === 'action_required'
              ? t('payoutOnboarding.actionRequired')
              : t('payoutOnboarding.onboarding')}
          </p>
          <Link
            to={`/payout-onboarding?token=${encodeURIComponent(token)}`}
            className={cn(buttonVariants(), 'w-full')}
          >
            {t('payoutOnboarding.continueSetup')}
          </Link>
        </>
      );
  }
}

/**
 * Runs the request once per attempt. StrictMode mounts effects twice in
 * development; the ref keeps that from minting two Stripe links.
 */
function usePayoutRequest(
  token: string | null,
  request: (token: string) => Promise<ViewState>,
): { view: ViewState; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<ViewState>(
    token == null || token === '' ? { kind: 'invalid' } : { kind: 'loading' },
  );
  const started = useRef(-1);

  useEffect(() => {
    if (token == null || token === '' || started.current === attempt) return;
    started.current = attempt;
    setView({ kind: 'loading' });
    request(token).then(setView, (err: unknown) => {
      setView(errorView(err));
    });
  }, [token, attempt, request]);

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);
  return { view, retry };
}

async function requestLink(token: string): Promise<ViewState> {
  const result = await api.post<{ url: string | null; status: PayoutState | null }>(
    '/v1/portal/payout-onboarding/link',
    { token },
  );
  if (result.url != null) {
    openStripeOnboarding(result.url);
    return { kind: 'redirecting' };
  }
  return { kind: 'status', status: result.status ?? 'active' };
}

async function requestStatus(token: string): Promise<ViewState> {
  const result = await api.post<{ status: PayoutState }>('/v1/portal/payout-onboarding/status', {
    token,
  });
  return { kind: 'status', status: result.status };
}

/** `/payout-onboarding?token=`: opens Stripe onboarding. */
export function PayoutOnboarding(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const { view, retry } = usePayoutRequest(token, requestLink);
  return (
    <PayoutOnboardingShell>
      <StatusMessage view={view} token={token ?? ''} onRetry={retry} />
    </PayoutOnboardingShell>
  );
}

/** `/payout-onboarding/return?token=`: where Stripe sends the site host back. */
export function PayoutOnboardingReturn(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const { view, retry } = usePayoutRequest(token, requestStatus);
  return (
    <PayoutOnboardingShell>
      <StatusMessage view={view} token={token ?? ''} onRetry={retry} />
    </PayoutOnboardingShell>
  );
}
