// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { CardSetupProps, GuestPaymentProps } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key.startsWith('errors.') ? `translated:${key}` : key),
  }),
}));

import { ApiError } from '@/lib/api';
import { SimulatedCardSetup } from '../simulated/SimulatedCardSetup';
import { SimulatedGuestPayment } from '../simulated/SimulatedGuestPayment';
import {
  challengeMethodId,
  readTestCards,
  refusedMessage,
  testCardLabel,
} from '../simulated/cards';
import simulatedModule from '../simulated';

const testCards = [
  { number: '4242424242424242', label: 'Approve (Visa)', scenario: 'approve' },
  { number: '4000000000000002', label: 'Decline: card declined', scenario: 'decline' },
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

function guestProps(overrides: Partial<GuestPaymentProps> = {}): GuestPaymentProps {
  return {
    config: { provider: 'simulated', resultMode: 'sync', testCards },
    amountCents: 5000,
    currency: 'USD',
    disabled: false,
    pay: vi.fn().mockResolvedValue({ status: 'done' }),
    payDetails: vi.fn(),
    ...overrides,
  };
}

const t = ((key: string) => key) as never;

afterEach(() => {
  cleanup();
});

describe('simulated module', () => {
  it('exposes card setup and guest payment', () => {
    expect(simulatedModule.id).toBe('simulated');
    expect(simulatedModule.CardSetup).toBe(SimulatedCardSetup);
    expect(simulatedModule.GuestPayment).toBe(SimulatedGuestPayment);
  });

  describe('cards', () => {
    it('reads valid test cards and skips malformed entries', () => {
      const cards = readTestCards({
        provider: 'simulated',
        testCards: [...testCards, { number: 42 }, null, 'x'],
      });
      expect(cards).toEqual(testCards);
      expect(readTestCards({ provider: 'simulated' })).toEqual([]);
    });

    it('labels a card by its localized scenario and last 4 digits', () => {
      expect(
        testCardLabel({ number: '4242424242424242', label: 'x', scenario: 'approve' }, t),
      ).toBe('paymentProviders.simulated.scenario.approve (•••• 4242)');
      expect(
        testCardLabel({ number: '4000000000009999', label: 'Something new', scenario: 'new' }, t),
      ).toBe('Something new (•••• 9999)');
    });

    it('maps refusal reasons and falls back to the generic text', () => {
      expect(refusedMessage('insufficient_funds', t)).toBe(
        'paymentProviders.refused.insufficient_funds',
      );
      expect(refusedMessage('do_not_honor', t)).toBe('paymentProviders.refused.default');
    });

    it('reads the method id of a method setup challenge only', () => {
      expect(challengeMethodId({ challenge: 'method_setup', methodId: 'pm_sim_1' })).toBe(
        'pm_sim_1',
      );
      expect(challengeMethodId({ challenge: 'hold', paymentId: 'pi_sim_1' })).toBeNull();
      expect(challengeMethodId({ challenge: 'method_setup', methodId: '' })).toBeNull();
      expect(challengeMethodId(null)).toBeNull();
    });
  });

  describe('SimulatedCardSetup', () => {
    it('shows the test mode notice and submits the selected test card', async () => {
      const props = cardProps();
      render(<SimulatedCardSetup {...props} />);
      expect(screen.getByText('paymentProviders.simulated.testMode')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'payments.saveCard' }));
      await waitFor(() => {
        expect(props.onSaved).toHaveBeenCalled();
      });
      expect(props.submit).toHaveBeenCalledWith({ testCard: '4242424242424242' });
    });

    it('shows the refusal reason and keeps the form open', async () => {
      const props = cardProps({
        submit: vi.fn().mockResolvedValue({ status: 'refused', reason: 'card_declined' }),
      });
      render(<SimulatedCardSetup {...props} />);
      fireEvent.change(screen.getByLabelText('paymentProviders.simulated.testCard'), {
        target: { value: '4000000000000002' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'payments.saveCard' }));
      expect(await screen.findByText('paymentProviders.refused.card_declined')).toBeTruthy();
      expect(props.submit).toHaveBeenCalledWith({ testCard: '4000000000000002' });
      expect(props.onSaved).not.toHaveBeenCalled();
    });

    it('answers the challenge with approve and saves', async () => {
      const props = cardProps({
        submit: vi.fn().mockResolvedValue({
          status: 'action_required',
          action: {
            provider: 'simulated',
            data: { challenge: 'method_setup', methodId: 'pm_sim_action' },
          },
        }),
      });
      render(<SimulatedCardSetup {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'payments.saveCard' }));
      expect(await screen.findByText('paymentProviders.simulated.challengeTitle')).toBeTruthy();
      fireEvent.click(
        screen.getByRole('button', { name: 'paymentProviders.simulated.challengeApprove' }),
      );
      await waitFor(() => {
        expect(props.onSaved).toHaveBeenCalled();
      });
      expect(props.submitDetails).toHaveBeenCalledWith({
        methodId: 'pm_sim_action',
        outcome: 'approve',
      });
    });

    it('returns to the card select when the challenge fails', async () => {
      const props = cardProps({
        submit: vi.fn().mockResolvedValue({
          status: 'action_required',
          action: {
            provider: 'simulated',
            data: { challenge: 'method_setup', methodId: 'pm_sim_action' },
          },
        }),
        submitDetails: vi
          .fn()
          .mockResolvedValue({ status: 'refused', reason: 'authentication_failed' }),
      });
      render(<SimulatedCardSetup {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'payments.saveCard' }));
      fireEvent.click(
        await screen.findByRole('button', { name: 'paymentProviders.simulated.challengeFail' }),
      );
      expect(
        await screen.findByText('paymentProviders.refused.authentication_failed'),
      ).toBeTruthy();
      expect(props.submitDetails).toHaveBeenCalledWith({
        methodId: 'pm_sim_action',
        outcome: 'fail',
      });
      expect(screen.getByLabelText('paymentProviders.simulated.testCard')).toBeTruthy();
    });

    it('shows a setup failure for an action it cannot answer', async () => {
      const props = cardProps({
        submit: vi.fn().mockResolvedValue({
          status: 'action_required',
          action: { provider: 'simulated', data: { challenge: 'unknown' } },
        }),
      });
      render(<SimulatedCardSetup {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'payments.saveCard' }));
      expect(await screen.findByText('payments.cardSetupFailed')).toBeTruthy();
    });

    it('shows the API error when the submit throws', async () => {
      const props = cardProps({
        submit: vi.fn().mockRejectedValue(new ApiError(400, { code: 'VALIDATION_ERROR' })),
      });
      render(<SimulatedCardSetup {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'payments.saveCard' }));
      expect(await screen.findByText('translated:errors.VALIDATION_ERROR')).toBeTruthy();
    });

    it('cancels', () => {
      const props = cardProps();
      render(<SimulatedCardSetup {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
      expect(props.onCancel).toHaveBeenCalled();
    });

    it('shows a failure without test cards', () => {
      render(
        <SimulatedCardSetup
          {...cardProps({ session: { provider: 'simulated', customerId: 'cus_sim_1' } })}
        />,
      );
      expect(screen.getByText('payments.cardSetupFailed')).toBeTruthy();
    });
  });

  describe('SimulatedGuestPayment', () => {
    it('pays with the selected test card', async () => {
      const props = guestProps();
      render(<SimulatedGuestPayment {...props} />);
      expect(screen.getByText('paymentProviders.simulated.testMode')).toBeTruthy();
      fireEvent.change(screen.getByLabelText('paymentProviders.simulated.testCard'), {
        target: { value: '4000002500003155' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'guest.startCharging' }));
      await waitFor(() => {
        expect(props.pay).toHaveBeenCalledWith({ testCard: '4000002500003155' });
      });
    });

    it('shows the error when pay rejects', async () => {
      const props = guestProps({
        pay: vi.fn().mockRejectedValue(new ApiError(400, { code: 'PAYMENT_FAILED' })),
      });
      render(<SimulatedGuestPayment {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'guest.startCharging' }));
      expect(await screen.findByText('translated:errors.PAYMENT_FAILED')).toBeTruthy();
    });

    it('does not pay while disabled', () => {
      const props = guestProps({ disabled: true });
      render(<SimulatedGuestPayment {...props} />);
      const button = screen.getByRole('button', { name: 'guest.startCharging' });
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });

    it('shows not configured without test cards', () => {
      render(<SimulatedGuestPayment {...guestProps({ config: { provider: 'simulated' } })} />);
      expect(screen.getByText('guest.paymentNotConfigured')).toBeTruthy();
    });
  });
});
