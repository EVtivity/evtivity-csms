// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { DEFAULT_PASSWORD_POLICY } from '@evtivity/lib/password-policy';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return { api: { get: getMock }, ApiError };
});

import { ApiError } from '@/lib/api';
import {
  usePasswordPolicy,
  useWeakPasswordReply,
  SECURITY_PUBLIC_QUERY_KEY,
} from '../use-password-policy';

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  getMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePasswordPolicy', () => {
  it('reads the policy from the public security endpoint under the sign-in pages key', async () => {
    const policy = {
      minLength: 16,
      requireUppercase: false,
      requireLowercase: true,
      requireNumber: true,
      requireSymbol: true,
    };
    getMock.mockResolvedValue({ recaptchaEnabled: false, passwordPolicy: policy });
    const { result } = renderHook(() => usePasswordPolicy(), { wrapper });
    expect(result.current).toEqual(DEFAULT_PASSWORD_POLICY);
    await waitFor(() => {
      expect(result.current).toEqual(policy);
    });
    expect(getMock).toHaveBeenCalledWith('/v1/security/public');
    expect(SECURITY_PUBLIC_QUERY_KEY).toEqual(['security-public']);
    expect(client.getQueryData(['security-public'])).toEqual({
      recaptchaEnabled: false,
      passwordPolicy: policy,
    });
  });

  it('falls back to the default policy and logs when the request fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    getMock.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => usePasswordPolicy(), { wrapper });
    await waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    expect(result.current).toEqual(DEFAULT_PASSWORD_POLICY);
  });

  it('uses the default policy when the reply has none', async () => {
    getMock.mockResolvedValue({ recaptchaEnabled: false });
    const { result } = renderHook(() => usePasswordPolicy(), { wrapper });
    await waitFor(() => {
      expect(getMock).toHaveBeenCalled();
    });
    expect(result.current).toEqual(DEFAULT_PASSWORD_POLICY);
  });
});

describe('useWeakPasswordReply', () => {
  it('returns the named rules and reloads the policy on a WEAK_PASSWORD reply', async () => {
    getMock.mockResolvedValue({ recaptchaEnabled: false });
    const { result } = renderHook(
      () => ({ policy: usePasswordPolicy(), read: useWeakPasswordReply() }),
      { wrapper },
    );
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledTimes(1);
    });
    const missing = result.current.read(
      new ApiError(400, { error: 'x', code: 'WEAK_PASSWORD', missing: ['symbol'] }),
    );
    expect(missing).toEqual(['symbol']);
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledTimes(2);
    });
  });

  it('returns null and keeps the policy for any other error', async () => {
    getMock.mockResolvedValue({ recaptchaEnabled: false });
    const { result } = renderHook(
      () => ({ policy: usePasswordPolicy(), read: useWeakPasswordReply() }),
      { wrapper },
    );
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledTimes(1);
    });
    expect(result.current.read(new ApiError(401, { code: 'INVALID_CREDENTIALS' }))).toBeNull();
    expect(result.current.read(new TypeError('Failed to fetch'))).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getMock).toHaveBeenCalledTimes(1);
  });
});
