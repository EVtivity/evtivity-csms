// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TFunction } from 'i18next';

const { supportsMock, autofillMock } = vi.hoisted(() => ({
  supportsMock: vi.fn(() => true),
  autofillMock: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: supportsMock,
  browserSupportsWebAuthnAutofill: autofillMock,
}));

vi.mock('../api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return { ApiError };
});

import { ApiError } from '../api';
import {
  ceremonyFailure,
  passkeyErrorText,
  webauthnAutofillSupported,
  webauthnSupported,
} from '../webauthn';

const t = ((key: string) => (key.startsWith('errors.') ? `translated:${key}` : key)) as TFunction;

function secure(value: boolean): void {
  Object.defineProperty(window, 'isSecureContext', { value, configurable: true });
}

function browserError(name: string, code?: string): Error {
  return Object.assign(new Error(name), { name, ...(code != null ? { code } : {}) });
}

beforeEach(() => {
  supportsMock.mockReturnValue(true);
  autofillMock.mockResolvedValue(true);
  secure(true);
});

describe('webauthnSupported', () => {
  it('needs a secure page and a browser with WebAuthn', () => {
    expect(webauthnSupported()).toBe(true);
    secure(false);
    expect(webauthnSupported()).toBe(false);
    secure(true);
    supportsMock.mockReturnValue(false);
    expect(webauthnSupported()).toBe(false);
  });

  it('never offers autofill on a page that cannot use passkeys', async () => {
    expect(await webauthnAutofillSupported()).toBe(true);
    secure(false);
    autofillMock.mockClear();
    expect(await webauthnAutofillSupported()).toBe(false);
    expect(autofillMock).not.toHaveBeenCalled();
  });
});

describe('ceremonyFailure', () => {
  it('tells a closed prompt, a cancelled one and a known authenticator apart', () => {
    expect(ceremonyFailure(browserError('NotAllowedError'))).toBe('cancelled');
    expect(ceremonyFailure(browserError('AbortError', 'ERROR_CEREMONY_ABORTED'))).toBe('aborted');
    expect(
      ceremonyFailure(
        browserError('InvalidStateError', 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED'),
      ),
    ).toBe('already_registered');
    expect(ceremonyFailure(new Error('WebAuthn is not supported in this browser'))).toBe('failed');
  });

  it('leaves API errors to the error codes', () => {
    expect(ceremonyFailure(new ApiError(400, { code: 'WEBAUTHN_VERIFICATION_FAILED' }))).toBeNull();
  });
});

describe('passkeyErrorText', () => {
  it('is quiet for a closed or cancelled prompt', () => {
    expect(passkeyErrorText(browserError('NotAllowedError'), t)).toEqual({
      message: 'passkeys.cancelled',
      quiet: true,
    });
    expect(passkeyErrorText(browserError('AbortError'), t).quiet).toBe(true);
  });

  it('translates the API error codes', () => {
    for (const code of [
      'WEBAUTHN_VERIFICATION_FAILED',
      'WEBAUTHN_CHALLENGE_EXPIRED',
      'PASSKEY_NOT_FOUND',
      'PASSKEY_LIMIT_REACHED',
    ]) {
      expect(passkeyErrorText(new ApiError(400, { code }), t)).toEqual({
        message: `translated:errors.${code}`,
        quiet: false,
      });
    }
  });

  it('never shows the browser message of another failure', () => {
    expect(
      passkeyErrorText(new Error('The operation is insecure.'), t, 'auth.passkeyFailed'),
    ).toEqual({ message: 'auth.passkeyFailed', quiet: false });
    expect(
      passkeyErrorText(
        browserError('InvalidStateError', 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED'),
        t,
      ).message,
    ).toBe('passkeys.alreadyRegistered');
  });
});
