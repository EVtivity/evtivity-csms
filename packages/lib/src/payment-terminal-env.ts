// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** The only NODE_ENV values under which the terminal mock and an unverified adapter are accepted. */
const TEST_NODE_ENVS: ReadonlySet<string> = new Set(['development', 'test']);

export interface PaymentTerminalEnv {
  NODE_ENV?: string | undefined;
  PAYMENT_TERMINAL_TEST_BASE_URL?: string | undefined;
}

/** True under NODE_ENV development or test: an adapter whose contract no live run verified may be built. */
export function allowsUnverifiedTerminalAdapters(env: PaymentTerminalEnv): boolean {
  return TEST_NODE_ENVS.has(env.NODE_ENV ?? '');
}

/**
 * The base URL of the payment terminal provider mock (no trailing slash), or
 * null when unset. Each adapter appends its own prefix (ID TECH:
 * `/idtech/api/v1`). An environment variable, not a setting, so an operator
 * cannot send terminal credentials elsewhere. Throws when it is set and
 * NODE_ENV is not development or test, or when it is not an http(s) URL
 * without credentials, query or fragment.
 */
export function resolvePaymentTerminalTestBaseUrl(env: PaymentTerminalEnv): string | null {
  const url = (env.PAYMENT_TERMINAL_TEST_BASE_URL ?? '').trim();
  if (url === '') return null;
  if (!TEST_NODE_ENVS.has(env.NODE_ENV ?? '')) {
    throw new Error(
      'PAYMENT_TERMINAL_TEST_BASE_URL needs NODE_ENV development or test: the payment terminal mock is for local development only',
    );
  }
  const parsed = URL.parse(url);
  if (parsed == null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Error('PAYMENT_TERMINAL_TEST_BASE_URL must be an http or https URL');
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('PAYMENT_TERMINAL_TEST_BASE_URL must have no credentials, query or fragment');
  }
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--;
  return url.slice(0, end);
}
