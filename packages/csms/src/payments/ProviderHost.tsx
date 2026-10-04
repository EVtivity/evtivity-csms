// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { LoadingLogo } from '@/components/loading-logo';
import { loadPaymentModule } from './registry';
import type { CardSetupProps, PaymentProviderModule } from './types';

export interface ProviderHostProps {
  provider: string;
  props: CardSetupProps;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; module: PaymentProviderModule }
  | { kind: 'failed' }
  | { kind: 'unsupported' };

/**
 * Renders the card setup of the provider module the API names. Hosts never import a
 * provider SDK: an unknown provider shows `providerNotSupported`, a chunk that fails to
 * load shows `loadFailed` with a retry.
 */
export function ProviderHost({ provider, props }: ProviderHostProps): React.JSX.Element {
  const { t } = useTranslation();
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

  if (state.kind === 'loading') return <LoadingLogo size="inline" />;

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
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  if (state.kind === 'unsupported') {
    return <p className="text-sm text-destructive">{t('paymentProviders.providerNotSupported')}</p>;
  }

  const { CardSetup } = state.module;
  return <CardSetup {...props} />;
}
