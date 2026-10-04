// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  appReturnUrlError,
  appShopperContext,
  originMismatchError,
  shopperBrowserContext,
} from '../lib/shopper-browser.js';

describe('shopperBrowserContext', () => {
  it('builds the return URL from the app URL and keeps the browser info', () => {
    expect(
      shopperBrowserContext(
        { origin: 'https://portal.example', info: { language: 'de' } },
        'https://portal.example/',
        '/payments/return',
        { flow: 'guest', token: 'abc' },
      ),
    ).toEqual({
      origin: 'https://portal.example',
      returnUrl: 'https://portal.example/payments/return?flow=guest&token=abc',
      info: { language: 'de' },
    });
  });

  it('keeps a base path of the app URL and encodes query values', () => {
    expect(
      shopperBrowserContext(
        { origin: 'https://example.com' },
        'https://example.com/portal',
        '/payments/return',
        { flow: 'method', provider: 'adyen', attemptId: 'a b' },
      ),
    ).toEqual({
      origin: 'https://example.com',
      returnUrl:
        'https://example.com/portal/payments/return?flow=method&provider=adyen&attemptId=a+b',
    });
  });

  it('refuses another origin, a trailing slash, and a malformed app URL', () => {
    const query = { flow: 'guest' };
    expect(
      shopperBrowserContext(
        { origin: 'https://evil.example' },
        'https://portal.example',
        '/r',
        query,
      ),
    ).toBeNull();
    expect(
      shopperBrowserContext(
        { origin: 'https://portal.example/' },
        'https://portal.example',
        '/r',
        query,
      ),
    ).toBeNull();
    expect(shopperBrowserContext({ origin: 'x' }, 'not a url', '/r', query)).toBeNull();
  });
});

describe('originMismatchError', () => {
  it('names the expected origin', () => {
    expect(originMismatchError('http://localhost:7101/')).toEqual({
      error: 'browser.origin must be http://localhost:7101, the configured app URL',
      code: 'VALIDATION_ERROR',
    });
    expect(originMismatchError('bad').error).toContain('bad');
  });
});

describe('appShopperContext', () => {
  const apps = { urlSchemes: ['evtivity'], androidPackageNames: ['com.evtivity.driver'] };

  it('accepts a listed scheme on both platforms and the Adyen Android SDK URL', () => {
    expect(
      appShopperContext(
        { platform: 'ios', returnUrl: 'EVtivity://payments/adyen', info: { userAgent: 'x' } },
        apps,
      ),
    ).toEqual({
      channel: 'ios',
      returnUrl: 'EVtivity://payments/adyen',
      info: { userAgent: 'x' },
    });
    expect(
      appShopperContext({ platform: 'android', returnUrl: 'evtivity://payments/adyen' }, apps),
    ).toEqual({ channel: 'android', returnUrl: 'evtivity://payments/adyen' });
    expect(
      appShopperContext(
        { platform: 'android', returnUrl: 'adyencheckout://com.evtivity.driver/' },
        apps,
      ),
    ).toEqual({ channel: 'android', returnUrl: 'adyencheckout://com.evtivity.driver/' });
  });

  it('refuses URLs that lead to no configured app build', () => {
    for (const [platform, returnUrl] of [
      ['ios', 'adyencheckout://com.evtivity.driver'],
      ['android', 'adyencheckout://com.evtivity.driver?x=1'],
      ['android', 'adyencheckout://com.evtivity.driver#x'],
      ['android', 'adyencheckout://a:b@com.evtivity.driver'],
      ['android', 'adyencheckout://com.other'],
      ['ios', 'https://evtivity.com'],
      ['ios', '::'],
    ] as const) {
      expect(appShopperContext({ platform, returnUrl }, apps)).toBeNull();
    }
  });
});

describe('appReturnUrlError', () => {
  it('names the settings', () => {
    expect(appReturnUrlError()).toEqual({
      error: expect.stringContaining('mobile.app.urlSchemes') as unknown,
      code: 'VALIDATION_ERROR',
    });
  });
});
