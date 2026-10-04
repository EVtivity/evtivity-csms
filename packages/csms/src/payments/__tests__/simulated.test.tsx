// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { CardSetupProps } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key.startsWith('errors.') ? `translated:${key}` : key),
  }),
}));

import { ApiError } from '@/lib/api';
import { SimulatedCardSetup } from '../simulated/SimulatedCardSetup';
import {
  challengeMethodId,
  readTestCards,
  refusedMessage,
  testCardLabel,
} from '../simulated/cards';
import simulatedModule from '../simulated';
import { providerLabel } from '../provider-label';

const testCards = [
  { number: '4242424242424242', label: 'Approve (Visa)', scenario: 'approve' },
  { number: '5555555555554444', label: 'Approve (Mastercard)', scenario: 'approve' },
  { number: '4000000000009995', label: 'Decline: insufficient funds', scenario: 'nofunds' },
  { number: '4000002500003155', label: 'Requires authentication', scenario: 'action' },
];

function cardProps(overrides: Partial<CardSetupProps> = {}): CardSetupProps {
  return {
    session: { provider: 'simulated', customerId: 'cus_sim_1', resultMode: 'sync', testCards },
    submit: vi.fn().mockResolvedValue({ status: 'saved' }),
    submitDetails: vi.fn().mockResolvedValue({ status: 'saved' }),
    onSaved: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

const t = ((key: string) => key) as never;

afterEach(() => {
  cleanup();
});

describe('simulated module', () => {
  it('exposes card setup', () => {
    expect(simulatedModule.id).toBe('simulated');
    expect(simulatedModule.CardSetup).toBe(SimulatedCardSetup);
  });

  it('reads cards, labels them and maps refusals', () => {
    expect(readTestCards({ provider: 'simulated', testCards: [...testCards, {}] })).toEqual(
      testCards,
    );
    expect(readTestCards({ provider: 'simulated', testCards: 'x' })).toEqual([]);
    expect(testCardLabel({ number: '5555555555554444', label: 'x', scenario: 'approve' }, t)).toBe(
      'paymentProviders.simulated.scenario.approve (•••• 4444)',
    );
    expect(testCardLabel({ number: '4000000000000001', label: 'New', scenario: 'later' }, t)).toBe(
      'New (•••• 0001)',
    );
    expect(refusedMessage('card_declined', t)).toBe('paymentProviders.refused.card_declined');
    expect(refusedMessage('other', t)).toBe('paymentProviders.refused.default');
    expect(challengeMethodId({ challenge: 'method_setup', methodId: 'pm_x' })).toBe('pm_x');
    expect(challengeMethodId({ challenge: 'hold' })).toBeNull();
    expect(challengeMethodId('x')).toBeNull();
  });

  it('names known providers and shows plugin ids as is', () => {
    expect(providerLabel('simulated', t)).toBe('paymentProviders.names.simulated');
    expect(providerLabel('stripe', t)).toBe('paymentProviders.names.stripe');
    expect(providerLabel('acme', t)).toBe('acme');
    expect(providerLabel('toString', t)).toBe('toString');
  });

  describe('SimulatedCardSetup', () => {
    it('submits the selected test card', async () => {
      const props = cardProps();
      render(<SimulatedCardSetup {...props} />);
      expect(screen.getByText('paymentProviders.simulated.testMode')).toBeTruthy();
      fireEvent.change(screen.getByLabelText('paymentProviders.simulated.testCard'), {
        target: { value: '5555555555554444' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'payments.addCard' }));
      await waitFor(() => {
        expect(props.onSaved).toHaveBeenCalled();
      });
      expect(props.submit).toHaveBeenCalledWith({ testCard: '5555555555554444' });
    });

    it('shows the refusal reason', async () => {
      const props = cardProps({
        submit: vi.fn().mockResolvedValue({ status: 'refused', reason: 'insufficient_funds' }),
      });
      render(<SimulatedCardSetup {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'payments.addCard' }));
      expect(await screen.findByText('paymentProviders.refused.insufficient_funds')).toBeTruthy();
      expect(props.onSaved).not.toHaveBeenCalled();
    });

    it('answers the challenge', async () => {
      const props = cardProps({
        submit: vi.fn().mockResolvedValue({
          status: 'action_required',
          action: { provider: 'simulated', data: { challenge: 'method_setup', methodId: 'pm_a' } },
        }),
      });
      render(<SimulatedCardSetup {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'payments.addCard' }));
      fireEvent.click(
        await screen.findByRole('button', { name: 'paymentProviders.simulated.challengeApprove' }),
      );
      await waitFor(() => {
        expect(props.onSaved).toHaveBeenCalled();
      });
      expect(props.submitDetails).toHaveBeenCalledWith({ methodId: 'pm_a', outcome: 'approve' });
    });

    it('shows the failed challenge and returns to the select', async () => {
      const props = cardProps({
        submit: vi.fn().mockResolvedValue({
          status: 'action_required',
          action: { provider: 'simulated', data: { challenge: 'method_setup', methodId: 'pm_a' } },
        }),
        submitDetails: vi
          .fn()
          .mockResolvedValue({ status: 'refused', reason: 'authentication_failed' }),
      });
      render(<SimulatedCardSetup {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'payments.addCard' }));
      fireEvent.click(
        await screen.findByRole('button', { name: 'paymentProviders.simulated.challengeFail' }),
      );
      expect(
        await screen.findByText('paymentProviders.refused.authentication_failed'),
      ).toBeTruthy();
      expect(props.submitDetails).toHaveBeenCalledWith({ methodId: 'pm_a', outcome: 'fail' });
      expect(screen.getByLabelText('paymentProviders.simulated.testCard')).toBeTruthy();
    });

    it('shows a setup failure for an unknown action', async () => {
      const props = cardProps({
        submit: vi.fn().mockResolvedValue({
          status: 'action_required',
          action: { provider: 'simulated', data: null },
        }),
      });
      render(<SimulatedCardSetup {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'payments.addCard' }));
      expect(await screen.findByText('payments.setupFailed')).toBeTruthy();
    });

    it('shows the API error when the submit throws', async () => {
      const props = cardProps({
        submit: vi.fn().mockRejectedValue(new ApiError(403, { code: 'FORBIDDEN' })),
      });
      render(<SimulatedCardSetup {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'payments.addCard' }));
      expect(await screen.findByText('translated:errors.FORBIDDEN')).toBeTruthy();
    });

    it('cancels, also without test cards', () => {
      const props = cardProps({ session: { provider: 'simulated', customerId: 'cus_sim_1' } });
      render(<SimulatedCardSetup {...props} />);
      expect(screen.getByText('payments.setupFailed')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
      expect(props.onCancel).toHaveBeenCalled();
    });
  });
});
