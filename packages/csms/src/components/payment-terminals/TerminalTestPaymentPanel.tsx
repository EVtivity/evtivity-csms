// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { DecimalInput } from '@/components/ui/decimal-input';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TabPanel } from '@/components/ui/tab-panel';
import { StartButton } from '@/components/start-button';
import { preAuthAmountError } from '@/components/settings/payment-amount-validation';
import { useCompanyCurrency } from '@/hooks/use-company-currency';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { formatCents } from '@/lib/formatting';
import {
  PRE_AUTH_AMOUNT_MAX_CENTS,
  PRE_AUTH_AMOUNT_MIN_CENTS,
  parseMajorInputToCents,
} from '@evtivity/lib/currency';
import {
  PAYMENT_TERMINALS_KEY,
  txnStateLabel,
  txnStateVariant,
  type PaymentTerminal,
  type TerminalTransaction,
} from './payment-terminal-types';

/** `POST /v1/payment-terminals/:id/payments`. */
interface StartPaymentReply {
  transaction: TerminalTransaction;
  chargingStarted: boolean;
  /** Why charging did not start (an error code); the hold was released. */
  startError: string | null;
}

const EMAIL = /^\S+@\S+\.\S+$/;

/** The translated message of an API error code, or the code itself when unknown. */
function errorCodeText(t: TFunction, code: string): string {
  const key = `errors.${code}` as 'errors.unknown';
  const text: string = t(key);
  return text !== key ? text : code;
}

/**
 * Start Test Payment: asks the terminal for a card. The hold is the site hold
 * amount unless an amount is given; once the card is authorized the CSMS starts
 * charging on the paired connector.
 */
export function TerminalTestPaymentPanel({
  terminal,
}: {
  terminal: PaymentTerminal;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { currency } = useCompanyCurrency();
  const [amount, setAmount] = useState('');
  const [email, setEmail] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const start = useMutation({
    mutationFn: (body: { amountCents?: number; receiptEmail?: string }) =>
      api.post<StartPaymentReply>(`/v1/payment-terminals/${terminal.id}/payments`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PAYMENT_TERMINALS_KEY });
      void queryClient.invalidateQueries({ queryKey: ['audit', 'payment_terminal'] });
    },
  });

  const errors: { amount?: string; email?: string } = {};
  if (amount.trim() !== '') {
    const amountError = preAuthAmountError(amount, t, {
      minCents: PRE_AUTH_AMOUNT_MIN_CENTS,
      maxCents: PRE_AUTH_AMOUNT_MAX_CENTS,
    });
    if (amountError != null) errors.amount = amountError;
  }
  if (email.trim() !== '' && !EMAIL.test(email.trim())) errors.email = t('validation.email');
  const shown = hasSubmitted ? errors : {};

  const blocked =
    terminal.status !== 'active'
      ? t('paymentTerminals.testPayment.inactive')
      : terminal.stationId == null
        ? t('paymentTerminals.testPayment.notPaired')
        : null;

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0 || blocked != null) return;
    const body: { amountCents?: number; receiptEmail?: string } = {};
    const cents = amount.trim() !== '' ? parseMajorInputToCents(amount) : null;
    if (cents != null) body.amountCents = cents;
    if (email.trim() !== '') body.receiptEmail = email.trim();
    start.mutate(body);
  }

  const reply = start.data;

  return (
    <TabPanel
      title={t('paymentTerminals.testPayment.title')}
      description={t('paymentTerminals.testPayment.description')}
    >
      <form
        onSubmit={handleSubmit}
        noValidate
        className="space-y-4"
        data-testid="terminal-test-payment"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="terminal-test-amount" className="leading-6">
              {t('paymentTerminals.testPayment.amount', { currency })}
            </Label>
            <DecimalInput
              id="terminal-test-amount"
              value={amount}
              decimalScale={2}
              className={shown.amount != null ? 'border-destructive' : ''}
              onChange={(value) => {
                setAmount(value);
                start.reset();
              }}
            />
            {shown.amount != null && <p className="text-sm text-destructive">{shown.amount}</p>}
            <p className="text-xs text-muted-foreground">
              {t('paymentTerminals.testPayment.amountHint')}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="terminal-test-email" className="leading-6">
              {t('paymentTerminals.testPayment.receiptEmail')}
            </Label>
            <Input
              id="terminal-test-email"
              type="email"
              value={email}
              autoComplete="off"
              className={shown.email != null ? 'border-destructive' : ''}
              onChange={(e) => {
                setEmail(e.target.value);
                start.reset();
              }}
            />
            {shown.email != null && <p className="text-sm text-destructive">{shown.email}</p>}
            <p className="text-xs text-muted-foreground">
              {t('paymentTerminals.testPayment.receiptEmailHint')}
            </p>
          </div>
        </div>
        {blocked != null && <p className="text-sm text-muted-foreground">{blocked}</p>}
        {start.isError && (
          <p className="text-sm text-destructive">{getErrorMessage(start.error, t)}</p>
        )}
        {reply != null && (
          <div className="space-y-1 text-sm" data-testid="terminal-test-payment-result">
            <p className="flex flex-wrap items-center gap-2">
              <Badge variant={txnStateVariant(reply.transaction.state)}>
                {txnStateLabel(t, reply.transaction.state)}
              </Badge>
              <span>
                {formatCents(
                  reply.transaction.authorizedCents ?? reply.transaction.requestedCents,
                  reply.transaction.currency,
                )}
              </span>
            </p>
            {reply.chargingStarted ? (
              <p className="text-success">{t('paymentTerminals.testPayment.chargingStarted')}</p>
            ) : reply.startError != null ? (
              <p className="text-destructive">
                {t('paymentTerminals.testPayment.chargingNotStarted', {
                  reason: errorCodeText(t, reply.startError),
                })}
              </p>
            ) : (
              <p className="text-muted-foreground">{t('paymentTerminals.testPayment.waiting')}</p>
            )}
          </div>
        )}
        <div className="flex justify-end">
          <StartButton
            type="submit"
            label={t('paymentTerminals.testPayment.start')}
            onClick={() => undefined}
            disabled={start.isPending}
          />
        </div>
      </form>
    </TabPanel>
  );
}
