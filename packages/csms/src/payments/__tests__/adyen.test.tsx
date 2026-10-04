// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { CardSetupProps } from '../types';

const adyen = vi.hoisted(() => {
  interface Actions {
    resolve: ReturnType<typeof vi.fn>;
    reject: ReturnType<typeof vi.fn>;
  }
  const state: {
    config: Record<string, unknown> | null;
    cardProps: Record<string, unknown> | null;
    card: {
      mount: ReturnType<typeof vi.fn>;
      unmount: ReturnType<typeof vi.fn>;
      submit: ReturnType<typeof vi.fn>;
      setStatus: ReturnType<typeof vi.fn>;
    } | null;
  } = { config: null, cardProps: null, card: null };
  const AdyenCheckout = vi.fn((config: Record<string, unknown>) => {
    state.config = config;
    return Promise.resolve({ core: true });
  });
  const Card = vi.fn(function (this: unknown, _checkout: unknown, props: Record<string, unknown>) {
    state.cardProps = props;
    const card = {
      mount: vi.fn(() => card),
      unmount: vi.fn(() => card),
      submit: vi.fn(),
      setStatus: vi.fn(() => card),
    };
    state.card = card;
    return card;
  });
  function actions(): Actions {
    return { resolve: vi.fn(), reject: vi.fn() };
  }
  /** Calls the checkout's onSubmit as Adyen Web does after card.submit(). */
  function submit(data: Record<string, unknown>): Actions {
    const a = actions();
    (state.config?.['onSubmit'] as (s: unknown, c: unknown, a: Actions) => void)(
      { data, isValid: true },
      {},
      a,
    );
    return a;
  }
  function details(data: Record<string, unknown>): Actions {
    const a = actions();
    (state.config?.['onAdditionalDetails'] as (s: unknown, c: unknown, a: Actions) => void)(
      { data },
      {},
      a,
    );
    return a;
  }
  return { state, AdyenCheckout, Card, submit, details };
});

vi.mock('@adyen/adyen-web', () => ({ AdyenCheckout: adyen.AdyenCheckout, Card: adyen.Card }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      typeof opts?.['reason'] === 'string' ? `${key}:${opts['reason']}` : key,
    i18n: { language: 'de' },
  }),
}));

import { ApiError } from '@/lib/api';
import adyenModule from '../adyen';
import { AdyenCardSetup } from '../adyen/AdyenCardSetup';
import {
  actionResultCode,
  adyenLocale,
  adyenRefusedMessage,
  readAdyenConfig,
} from '../adyen/config';

const paymentMethodsResponse = { paymentMethods: [{ type: 'scheme', name: 'Cards' }] };
const browserInfo = { userAgent: 'test', language: 'de' };
const cardData = { paymentMethod: { type: 'scheme', encryptedCardNumber: 'enc' }, browserInfo };
const redirect = { type: 'redirect', method: 'GET', url: 'https://issuer.example/3ds' };

function cardProps(overrides: Partial<CardSetupProps> = {}): CardSetupProps {
  return {
    session: {
      provider: 'adyen',
      customerId: 'evt_1',
      clientKey: 'test_KEY',
      environment: 'test',
      countryCode: 'US',
      currency: 'USD',
      paymentMethodsResponse,
    },
    submit: vi.fn().mockResolvedValue({ status: 'saved' }),
    submitDetails: vi.fn().mockResolvedValue({ status: 'saved' }),
    onSaved: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

async function mounted(): Promise<void> {
  await waitFor(() => {
    expect(adyen.state.card?.mount).toHaveBeenCalled();
  });
}

const t = ((key: string, opts?: Record<string, unknown>) =>
  typeof opts?.['reason'] === 'string' ? `${key}:${opts['reason']}` : key) as never;

beforeEach(() => {
  adyen.state.config = null;
  adyen.state.card = null;
  adyen.AdyenCheckout.mockClear();
  adyen.Card.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('adyen module', () => {
  it('exposes card setup', () => {
    expect(adyenModule.id).toBe('adyen');
    expect(adyenModule.CardSetup).toBe(AdyenCardSetup);
    expect(adyenModule).not.toHaveProperty('GuestPayment');
  });

  describe('config', () => {
    it('reads the client config and refuses an unusable one', () => {
      expect(
        readAdyenConfig(
          { provider: 'adyen', clientKey: 'k', environment: 'live-us', countryCode: 'US' },
          { value: 100, currency: 'USD' },
        ),
      ).toEqual({
        clientKey: 'k',
        environment: 'live-us',
        countryCode: 'US',
        amount: { value: 100, currency: 'USD' },
      });
      expect(readAdyenConfig({ provider: 'adyen', environment: 'test' })).toBeNull();
      // Adyen Web refuses to start without a country.
      expect(
        readAdyenConfig({ provider: 'adyen', clientKey: 'k', environment: 'test' }),
      ).toBeNull();
      expect(readAdyenConfig({ provider: 'adyen', clientKey: 'k', environment: 'x' })).toBeNull();
    });

    it('maps app languages to Adyen locales', () => {
      expect(adyenLocale('en')).toBe('en-US');
      expect(adyenLocale('zh')).toBe('zh-CN');
      expect(adyenLocale('zh-TW')).toBe('zh-TW');
      expect(adyenLocale('ko')).toBe('ko-KR');
      expect(adyenLocale('fr')).toBe('en-US');
    });

    it('names the result code of an action by its type', () => {
      expect(actionResultCode(redirect)).toBe('RedirectShopper');
      expect(actionResultCode({ type: 'threeDS2', subtype: 'fingerprint' })).toBe(
        'IdentifyShopper',
      );
      expect(actionResultCode({ type: 'threeDS2', subtype: 'challenge' })).toBe('ChallengeShopper');
      expect(actionResultCode({ type: 'qrCode' })).toBe('Pending');
    });

    it('maps known refusal reasons and shows others with the Adyen reason', () => {
      expect(adyenRefusedMessage('3D Not Authenticated', t)).toBe(
        'paymentProviders.refused.authentication_failed',
      );
      expect(adyenRefusedMessage('CVC Declined', t)).toBe(
        'paymentProviders.adyen.refused:CVC Declined',
      );
    });
  });

  describe('AdyenCardSetup', () => {
    it('mounts the Card component from the setup session', async () => {
      render(<AdyenCardSetup {...cardProps()} />);
      await mounted();
      expect(adyen.state.config).toMatchObject({
        clientKey: 'test_KEY',
        environment: 'test',
        countryCode: 'US',
        locale: 'de-DE',
        paymentMethodsResponse,
        showPayButton: false,
      });
      expect(adyen.state.config?.['amount']).toBeUndefined();
      expect(adyen.state.cardProps).toMatchObject({
        hasHolderName: false,
        enableStoreDetails: false,
      });
    });

    it('submits through the Card component when the save button is pressed', async () => {
      render(<AdyenCardSetup {...cardProps()} />);
      await mounted();
      fireEvent.click(screen.getByRole('button', { name: 'payments.addCard' }));
      expect(adyen.state.card?.submit).toHaveBeenCalled();
    });

    it('posts state.data with the currency and the browser, then saves', async () => {
      const props = cardProps();
      render(<AdyenCardSetup {...props} />);
      await mounted();
      const actions = adyen.submit(cardData);
      await waitFor(() => {
        expect(props.onSaved).toHaveBeenCalled();
      });
      expect(props.submit).toHaveBeenCalledWith(
        { ...cardData, currency: 'USD' },
        { origin: window.location.origin, info: browserInfo },
      );
      expect(actions.resolve).toHaveBeenCalledWith({ resultCode: 'Authorised' });
    });

    it('hands a 3D Secure action to Adyen Web and posts the details it returns', async () => {
      const props = cardProps({
        submit: vi.fn().mockResolvedValue({
          status: 'action_required',
          action: { provider: 'adyen', data: redirect },
        }),
      });
      render(<AdyenCardSetup {...props} />);
      await mounted();
      const submitted = adyen.submit(cardData);
      await waitFor(() => {
        expect(submitted.resolve).toHaveBeenCalledWith({
          resultCode: 'RedirectShopper',
          action: redirect,
        });
      });
      expect(screen.getByText('paymentProviders.adyen.authenticate')).toBeTruthy();
      expect(props.onSaved).not.toHaveBeenCalled();

      const detailsData = { details: { threeDSResult: 'abc' } };
      const continued = adyen.details(detailsData);
      await waitFor(() => {
        expect(props.onSaved).toHaveBeenCalled();
      });
      expect(props.submitDetails).toHaveBeenCalledWith(detailsData);
      expect(continued.resolve).toHaveBeenCalledWith({ resultCode: 'Authorised' });
    });

    it('shows the refusal and keeps the card for another try', async () => {
      const props = cardProps({
        submit: vi.fn().mockResolvedValue({ status: 'refused', reason: 'CVC Declined' }),
      });
      render(<AdyenCardSetup {...props} />);
      await mounted();
      const actions = adyen.submit(cardData);
      await waitFor(() => {
        expect(screen.getByText('paymentProviders.adyen.refused:CVC Declined')).toBeTruthy();
      });
      expect(actions.resolve).toHaveBeenCalledWith({ resultCode: 'Refused' });
      (adyen.state.config?.['onPaymentFailed'] as () => void)();
      expect(adyen.state.card?.setStatus).toHaveBeenCalledWith('ready');
      expect(props.onSaved).not.toHaveBeenCalled();
    });

    it('starts a fresh card after a refusal that followed a 3D Secure step', async () => {
      const props = cardProps({
        submit: vi.fn().mockResolvedValue({
          status: 'action_required',
          action: { provider: 'adyen', data: { type: 'threeDS2', subtype: 'challenge' } },
        }),
        submitDetails: vi
          .fn()
          .mockResolvedValue({ status: 'refused', reason: '3D Not Authenticated' }),
      });
      render(<AdyenCardSetup {...props} />);
      await mounted();
      adyen.submit(cardData);
      await waitFor(() => {
        expect(screen.getByText('paymentProviders.adyen.authenticate')).toBeTruthy();
      });
      const first = adyen.state.card;
      adyen.details({ details: { threeDSResult: 'x' } });
      await waitFor(() => {
        expect(screen.getByText('paymentProviders.refused.authentication_failed')).toBeTruthy();
      });
      (adyen.state.config?.['onPaymentFailed'] as () => void)();
      await waitFor(() => {
        expect(adyen.AdyenCheckout).toHaveBeenCalledTimes(2);
      });
      await waitFor(() => {
        expect(adyen.state.card).not.toBe(first);
      });
      expect(first?.unmount).toHaveBeenCalled();
    });

    it('rejects the step and shows the API error', async () => {
      const props = cardProps({
        submit: vi
          .fn()
          .mockRejectedValue(new ApiError(400, { error: 'x', code: 'VALIDATION_ERROR' })),
      });
      render(<AdyenCardSetup {...props} />);
      await mounted();
      const actions = adyen.submit(cardData);
      await waitFor(() => {
        expect(actions.reject).toHaveBeenCalled();
      });
      expect(screen.getByRole('alert')).toBeTruthy();
    });

    it('shows the setup error for a session without a client key', () => {
      render(
        <AdyenCardSetup {...cardProps({ session: { provider: 'adyen', customerId: 'c' } })} />,
      );
      expect(screen.getByText('payments.setupFailed')).toBeTruthy();
      expect(adyen.AdyenCheckout).not.toHaveBeenCalled();
    });

    it('offers a retry when Adyen Web cannot start', async () => {
      adyen.AdyenCheckout.mockImplementationOnce(() => Promise.reject(new Error('bad key')));
      render(<AdyenCardSetup {...cardProps()} />);
      await waitFor(() => {
        expect(screen.getByText('paymentProviders.loadFailed')).toBeTruthy();
      });
      fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
      await mounted();
    });
  });
});
