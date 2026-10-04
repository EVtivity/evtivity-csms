// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { getErrorMessage } from '@/lib/error-message';
import type { CardSetupProps, SetupStepResult } from '../types';
import { challengeMethodId, readTestCards, refusedMessage } from './cards';
import { SimulatedChallenge, type ChallengeOutcome } from './SimulatedChallenge';
import { TestCardSelect, TestModeNotice } from './TestCardSelect';

/** Card setup of the test provider: pick a test card, answer its challenge if it has one. */
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
  const [error, setError] = useState('');

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
      setError(t('payments.cardSetupFailed'));
      return;
    }
    setChallenge(methodId);
  }

  async function run(step: () => Promise<SetupStepResult>): Promise<void> {
    setError('');
    setLoading(true);
    try {
      apply(await step());
    } catch (err: unknown) {
      setError(getErrorMessage(err, t, 'payments.failedSave'));
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
    return <p className="text-sm text-destructive">{t('payments.cardSetupFailed')}</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <TestModeNotice />
      {error !== '' && <p className="text-sm text-destructive">{error}</p>}
      {challenge != null ? (
        <SimulatedChallenge busy={loading} onResolve={handleChallenge} />
      ) : (
        <TestCardSelect
          id="simulated-test-card"
          cards={cards}
          value={testCard}
          disabled={loading}
          onChange={setTestCard}
        />
      )}
      <div className="flex gap-2">
        {challenge == null && (
          <Button type="submit" className="flex-1" disabled={loading}>
            {loading ? t('common.saving') : t('payments.saveCard')}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          className={challenge == null ? undefined : 'flex-1'}
          onClick={onCancel}
          disabled={loading}
        >
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
