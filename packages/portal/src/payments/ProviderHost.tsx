// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { loadPaymentModule } from './registry';
import type { CardSetupProps, GuestPaymentProps, PaymentProviderModule } from './types';

export type ProviderHostProps =
  | { provider: string; component: 'CardSetup'; props: CardSetupProps }
  | { provider: string; component: 'GuestPayment'; props: GuestPaymentProps };

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; module: PaymentProviderModule }
  | { kind: 'failed' }
  | { kind: 'unsupported' };

/**
 * Renders the provider module the API names. Hosts never import a provider SDK:
 * an unknown provider shows `providerNotSupported`, a chunk that fails to load
 * shows `loadFailed` with a retry.
 */
export function ProviderHost(hostProps: ProviderHostProps): React.JSX.Element {
  const { t } = useTranslation();
  const { provider } = hostProps;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    const pending = loadPaymentModule(provider);
    if (pending == null) {
      setState({ kind: 'unsupported' });
      return;
    }
    let active = true;
    setState({ kind: 'loading' });
    pending.then(
      (module) => {
        if (active) setState({ kind: 'ready', module });
      },
      () => {
        if (active) setState({ kind: 'failed' });
      },
    );
    return () => {
      active = false;
    };
  }, [provider, attempt]);

  if (state.kind === 'loading') {
    return (
      <div className="flex justify-center py-4" role="status" aria-label={t('common.loading')}>
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (state.kind === 'failed') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{t('paymentProviders.loadFailed')}</p>
        <Button
          variant="outline"
          onClick={() => {
            setAttempt((n) => n + 1);
          }}
        >
          {t('errors.retry')}
        </Button>
      </div>
    );
  }

  const unsupported = (
    <p className="text-sm text-destructive">{t('paymentProviders.providerNotSupported')}</p>
  );
  if (state.kind === 'unsupported') return unsupported;

  if (hostProps.component === 'CardSetup') {
    const { CardSetup } = state.module;
    return <CardSetup {...hostProps.props} />;
  }
  const { GuestPayment } = state.module;
  if (GuestPayment == null) return unsupported;
  return <GuestPayment {...hostProps.props} />;
}
