// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { getErrorMessage } from '@/lib/error-message';
import { formatCents } from '@/lib/utils';
import type { GuestPaymentProps } from '../types';
import { readTestCards } from './cards';
import { TestCardSelect, TestModeNotice } from './TestCardSelect';

/**
 * Guest payment of the test provider: the one-time card is a test card number.
 * It sends no browser context, so a card that requires authentication is declined
 * by the API (a 3DS action needs one); the API message is shown.
 */
export function SimulatedGuestPayment({
  config,
  amountCents,
  currency,
  disabled,
  pay,
}: GuestPaymentProps): React.JSX.Element {
  const { t } = useTranslation();
  const cards = readTestCards(config);
  const [testCard, setTestCard] = useState(cards[0]?.number ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.SyntheticEvent): Promise<void> {
    e.preventDefault();
    if (loading || disabled || testCard === '') return;
    setError('');
    setLoading(true);
    try {
      await pay({ testCard });
    } catch (err: unknown) {
      setError(getErrorMessage(err, t, 'guest.paymentFailed'));
    } finally {
      setLoading(false);
    }
  }

  if (cards.length === 0) {
    return <p className="text-sm text-destructive">{t('guest.paymentNotConfigured')}</p>;
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      <TestModeNotice />
      {error !== '' && <p className="text-sm text-destructive">{error}</p>}
      <TestCardSelect
        id="simulated-guest-card"
        cards={cards}
        value={testCard}
        disabled={loading}
        onChange={setTestCard}
      />
      <p className="text-xs text-muted-foreground">
        {t('guest.preAuthHold', { amount: formatCents(amountCents, currency) })}
      </p>
      <Button type="submit" className="w-full" size="lg" disabled={loading || disabled}>
        {loading ? t('guest.processing') : t('guest.startCharging')}
      </Button>
    </form>
  );
}
