// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlaskConical } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/cancel-button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { getErrorMessage } from '@/lib/error-message';
import type { CardSetupProps, SetupStepResult } from '../types';
import { challengeMethodId, readTestCards, refusedMessage, testCardLabel } from './cards';
import { SimulatedChallenge, type ChallengeOutcome } from './SimulatedChallenge';

/**
 * Card setup of the test provider: pick one of the allowlisted test cards (no free
 * text) and answer its challenge if it has one.
 */
export function SimulatedCardSetup({
  session,
  submit,
  submitDetails,
  onSaved,
  onCancel,
}: CardSetupProps): React.JSX.Element {
  const { t } = useTranslation();
  const cards = readTestCards(session);
  const [testCard, setTestCard] = useState(cards[0]?.number ?? '');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function apply(result: SetupStepResult): void {
    if (result.status === 'saved') {
      onSaved();
      return;
    }
    if (result.status === 'refused') {
      setChallenge(null);
      setError(refusedMessage(result.reason, t));
      return;
    }
    const methodId = challengeMethodId(result.action.data);
    if (methodId == null) {
      setChallenge(null);
      setError(t('payments.setupFailed'));
      return;
    }
    setChallenge(methodId);
  }

  async function run(step: () => Promise<SetupStepResult>): Promise<void> {
    setError(null);
    setLoading(true);
    try {
      apply(await step());
    } catch (err: unknown) {
      setError(getErrorMessage(err, t, 'payments.setupFailed'));
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    if (loading || testCard === '') return;
    void run(() => submit({ testCard }));
  }

  function handleChallenge(outcome: ChallengeOutcome): void {
    if (loading || challenge == null) return;
    const methodId = challenge;
    void run(() => submitDetails({ methodId, outcome }));
  }

  if (cards.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">{t('payments.setupFailed')}</p>
        <div className="flex justify-end">
          <CancelButton onClick={onCancel} />
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Alert variant="warning">
        <FlaskConical />
        <AlertDescription>{t('paymentProviders.simulated.testMode')}</AlertDescription>
      </Alert>
      {challenge != null ? (
        <SimulatedChallenge busy={loading} onResolve={handleChallenge} />
      ) : (
        <div className="space-y-2">
          <Label htmlFor="simulated-test-card">{t('paymentProviders.simulated.testCard')}</Label>
          <Select
            id="simulated-test-card"
            value={testCard}
            disabled={loading}
            onChange={(e) => {
              setTestCard(e.target.value);
            }}
          >
            {cards.map((card) => (
              <option key={card.number} value={card.number}>
                {testCardLabel(card, t)}
              </option>
            ))}
          </Select>
        </div>
      )}
      {error != null && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        {challenge == null && (
          <Button type="submit" disabled={loading}>
            {loading ? t('common.saving') : t('payments.addCard')}
          </Button>
        )}
        <CancelButton onClick={onCancel} />
      </div>
    </form>
  );
}
