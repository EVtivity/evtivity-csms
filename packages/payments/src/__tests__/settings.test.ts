// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encryptString } from '@evtivity/lib';
import { defaultSimulatedSettings, emptyAdyenSettings } from './helpers/settings.js';

const mockSelect = vi.fn();
vi.mock('@evtivity/database', () => ({
  db: { select: mockSelect },
  settings: { key: 'key', value: 'value' },
  sitePaymentConfigs: {
    id: 'id',
    siteId: 'site_id',
    isEnabled: 'is_enabled',
    payoutAccountId: 'payout_account_id',
    payoutAccountStatus: 'payout_status',
    preAuthAmountCents: 'pre_auth',
  },
}));

const KEY = 'test-encryption-key-32chars-long!';

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  c['from'] = vi.fn(() => c);
  c['where'] = vi.fn(() =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  );
  return c;
}

function rows(values: Record<string, unknown>) {
  return Object.entries(values).map(([key, value]) => ({ key, value }));
}

async function load() {
  vi.resetModules();
  return import('../settings.js');
}

describe('getPaymentSettings', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('decrypts the Enc keys and reads the provider and hold amount', async () => {
    mockSelect.mockReturnValueOnce(
      chain(
        rows({
          'payments.provider': 'stripe',
          'stripe.secretKeyEnc': encryptString('sk_test_1', KEY),
          'stripe.publishableKey': 'pk_test_1',
          'stripe.webhookSecretEnc': encryptString('whsec_1', KEY),
          'stripe.connectWebhookSecretEnc': encryptString('whsec_connect_1', KEY),
          'payments.preAuthAmountCents': 7500,
          // Pre-P5 key, still written for the rolling upgrade: never read.
          'stripe.preAuthAmountCents': 9900,
        }),
      ),
    );
    const { getPaymentSettings } = await load();
    expect(await getPaymentSettings(KEY)).toEqual({
      provider: 'stripe',
      preAuthAmountCents: 7500,
      stripe: {
        secretKey: 'sk_test_1',
        publishableKey: 'pk_test_1',
        webhookSecret: 'whsec_1',
        connectWebhookSecret: 'whsec_connect_1',
      },
      adyen: emptyAdyenSettings(),
      simulated: defaultSimulatedSettings(),
    });
  });

  it('treats missing and empty values as not configured', async () => {
    mockSelect.mockReturnValueOnce(
      chain(
        rows({
          'payments.provider': '',
          'stripe.secretKeyEnc': '',
          'stripe.publishableKey': '',
          'stripe.connectWebhookSecretEnc': '',
        }),
      ),
    );
    const { getPaymentSettings } = await load();
    expect(await getPaymentSettings(KEY)).toEqual({
      provider: 'none',
      preAuthAmountCents: 5000,
      stripe: {
        secretKey: null,
        publishableKey: null,
        webhookSecret: null,
        connectWebhookSecret: null,
      },
      adyen: emptyAdyenSettings(),
      simulated: defaultSimulatedSettings(),
    });
  });

  it('reads the adyen keys and decrypts their Enc values', async () => {
    mockSelect.mockReturnValueOnce(
      chain(
        rows({
          'adyen.apiKeyEnc': encryptString('AQE_key', KEY),
          'adyen.merchantAccount': 'TestMerchant',
          'adyen.clientKey': 'live_CLIENTKEY',
          'adyen.environment': 'live',
          'adyen.liveUrlPrefix': '1797a841fbb37ca7-AdyenDemo',
          'adyen.liveRegion': 'us',
          'adyen.hmacKeyEnc': encryptString('44782DEF', KEY),
          'adyen.hmacKeyPreviousEnc': encryptString('0A0B', KEY),
          'adyen.webhookUsername': 'adyen-hook',
          'adyen.webhookPasswordEnc': encryptString('hook-password', KEY),
          'adyen.authorisationAdjustment': true,
        }),
      ),
    );
    const { getPaymentSettings } = await load();
    expect((await getPaymentSettings(KEY)).adyen).toEqual({
      apiKey: 'AQE_key',
      merchantAccount: 'TestMerchant',
      clientKey: 'live_CLIENTKEY',
      environment: 'live',
      liveUrlPrefix: '1797a841fbb37ca7-AdyenDemo',
      liveRegion: 'us',
      hmacKey: '44782DEF',
      hmacKeyPrevious: '0A0B',
      webhookUsername: 'adyen-hook',
      webhookPassword: 'hook-password',
      authorisationAdjustment: true,
    });
  });

  it('defaults an unknown adyen environment to test and region to eu', async () => {
    mockSelect.mockReturnValueOnce(
      chain(
        rows({
          'adyen.environment': 'production',
          'adyen.liveRegion': 'mars',
          'adyen.authorisationAdjustment': 'yes',
        }),
      ),
    );
    const { getPaymentSettings } = await load();
    const { adyen } = await getPaymentSettings(KEY);
    expect(adyen.environment).toBe('test');
    expect(adyen.liveRegion).toBe('eu');
    expect(adyen.authorisationAdjustment).toBe(false);
  });

  it('caches for 60 seconds and reads again after clearPaymentSettingsCache', async () => {
    mockSelect.mockReturnValue(chain(rows({ 'payments.provider': 'stripe' })));
    const mod = await load();
    const first = await mod.getPaymentSettings(KEY);
    vi.advanceTimersByTime(59_000);
    expect(await mod.getPaymentSettings(KEY)).toBe(first);
    expect(mockSelect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await mod.getPaymentSettings(KEY);
    expect(mockSelect).toHaveBeenCalledTimes(2);
    mod.clearPaymentSettingsCache();
    await mod.getPaymentSettings(KEY);
    expect(mockSelect).toHaveBeenCalledTimes(3);
  });

  it('returns the last value on a read failure and throws without one', async () => {
    const mod = await load();
    mockSelect.mockReturnValueOnce(chain(new Error('db down')));
    await expect(mod.getPaymentSettings(KEY)).rejects.toThrow('db down');

    mockSelect.mockReturnValueOnce(chain(rows({ 'payments.provider': 'stripe' })));
    const cached = await mod.getPaymentSettings(KEY);
    vi.advanceTimersByTime(61_000);
    mockSelect.mockReturnValueOnce(chain(new Error('db down')));
    expect(await mod.getPaymentSettings(KEY)).toBe(cached);
  });

  it('throws when a secret cannot be decrypted', async () => {
    mockSelect.mockReturnValueOnce(
      chain(
        rows({
          'stripe.secretKeyEnc': encryptString('sk_test_1', 'another-key-32-characters-long!!'),
        }),
      ),
    );
    const { getPaymentSettings } = await load();
    await expect(getPaymentSettings(KEY)).rejects.toThrow();
  });

  it('ignores a non-positive or non-integer hold amount', async () => {
    mockSelect.mockReturnValueOnce(chain(rows({ 'payments.preAuthAmountCents': -5 })));
    const { getPaymentSettings } = await load();
    expect((await getPaymentSettings(KEY)).preAuthAmountCents).toBe(5000);
  });

  it('reads the simulated settings', async () => {
    mockSelect.mockReturnValueOnce(
      chain(
        rows({
          'simulated.resultMode': 'async',
          'simulated.asyncDelaySeconds': 10,
          'simulated.randomFailureRate': '0.5',
        }),
      ),
    );
    const { getPaymentSettings } = await load();
    expect((await getPaymentSettings(KEY)).simulated).toEqual({
      resultMode: 'async',
      asyncDelaySeconds: 10,
      randomFailureRate: 0.5,
    });
  });

  it('defaults unknown or out-of-range simulated settings', async () => {
    mockSelect.mockReturnValueOnce(
      chain(
        rows({
          'simulated.resultMode': 'later',
          'simulated.asyncDelaySeconds': 7200,
          'simulated.randomFailureRate': '',
        }),
      ),
    );
    const { getPaymentSettings } = await load();
    expect((await getPaymentSettings(KEY)).simulated).toEqual(defaultSimulatedSettings());
  });
});

describe('getSitePaymentConfig', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the enabled config with its payout account and status, cached per site', async () => {
    mockSelect.mockReturnValue(
      chain([
        { id: 3, accountId: 'acct_1', payoutAccountStatus: 'active', preAuthAmountCents: 9000 },
      ]),
    );
    const mod = await load();
    const config = await mod.getSitePaymentConfig('site-1');
    expect(config).toEqual({
      configId: 3,
      payoutAccountId: 'acct_1',
      payoutAccountStatus: 'active',
      preAuthAmountCents: 9000,
    });
    expect(await mod.getSitePaymentConfig('site-1')).toBe(config);
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockSelect).toHaveBeenCalledWith({
      id: 'id',
      accountId: 'payout_account_id',
      payoutAccountStatus: 'payout_status',
      preAuthAmountCents: 'pre_auth',
    });
    await mod.getSitePaymentConfig('site-2');
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it('returns null without an enabled config and maps an empty account to null', async () => {
    const mod = await load();
    mockSelect.mockReturnValueOnce(chain([]));
    expect(await mod.getSitePaymentConfig('site-1')).toBeNull();
    mockSelect.mockReturnValueOnce(chain([{ id: 4, accountId: '', preAuthAmountCents: 5000 }]));
    expect((await mod.getSitePaymentConfig('site-2'))?.payoutAccountId).toBeNull();
  });

  it('returns the last value on a read failure and throws without one', async () => {
    const mod = await load();
    mockSelect.mockReturnValueOnce(chain(new Error('db down')));
    await expect(mod.getSitePaymentConfig('site-1')).rejects.toThrow('db down');
    mockSelect.mockReturnValueOnce(chain([{ id: 3, accountId: null, preAuthAmountCents: 5000 }]));
    const cached = await mod.getSitePaymentConfig('site-1');
    vi.advanceTimersByTime(61_000);
    mockSelect.mockReturnValueOnce(chain(new Error('db down')));
    expect(await mod.getSitePaymentConfig('site-1')).toBe(cached);
  });
});
