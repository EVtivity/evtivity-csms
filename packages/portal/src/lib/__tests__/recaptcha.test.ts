// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// reCAPTCHA v3 on the sign-in pages: the script is loaded once per page with
// the site key, the badge is hidden once, and a token is asked for the action.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Grecaptcha = {
  ready: (cb: () => void) => void;
  execute: (key: string, opts: { action: string }) => Promise<string>;
};

async function load(): Promise<typeof import('../recaptcha')> {
  vi.resetModules();
  return import('../recaptcha');
}

function scripts(): HTMLScriptElement[] {
  return [...document.head.querySelectorAll('script')];
}

/** Settles the script tag the loader added: loaded or failed. */
function finish(ok: boolean): void {
  const s = scripts().at(-1);
  if (s == null) throw new Error('no script');
  if (ok) s.onload?.(new Event('load'));
  else s.onerror?.(new Event('error'));
}

let execute: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.head.replaceChildren();
  execute = vi.fn(() => Promise.resolve('token-1'));
  (window as unknown as { grecaptcha: Grecaptcha }).grecaptcha = {
    ready: (cb) => {
      cb();
    },
    execute: execute as unknown as Grecaptcha['execute'],
  };
});

afterEach(() => {
  delete (window as unknown as { grecaptcha?: Grecaptcha }).grecaptcha;
});

describe('executeRecaptcha', () => {
  it('loads the script with the site key, then returns the token for the action', async () => {
    const { executeRecaptcha } = await load();
    const pending = executeRecaptcha('site-key', 'login');
    const [script] = scripts();
    expect(script?.src).toBe('https://www.google.com/recaptcha/api.js?render=site-key');
    expect(script?.async).toBe(true);
    finish(true);
    await expect(pending).resolves.toBe('token-1');
    expect(execute).toHaveBeenCalledWith('site-key', { action: 'login' });
    // The badge is hidden by one style rule.
    const styles = [...document.head.querySelectorAll('style')];
    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toContain('.grecaptcha-badge');
  });

  it('loads the script once and hides the badge once for later tokens', async () => {
    const { executeRecaptcha } = await load();
    const first = executeRecaptcha('site-key', 'login');
    finish(true);
    await first;
    await expect(executeRecaptcha('site-key', 'forgot_password')).resolves.toBe('token-1');
    expect(scripts()).toHaveLength(1);
    expect(document.head.querySelectorAll('style')).toHaveLength(1);
    expect(execute).toHaveBeenLastCalledWith('site-key', { action: 'forgot_password' });
  });

  it('fails when the script does not load, and tries again on the next call', async () => {
    const { executeRecaptcha } = await load();
    const failed = executeRecaptcha('site-key', 'login');
    finish(false);
    await expect(failed).rejects.toThrow('Failed to load reCAPTCHA script');
    expect(execute).not.toHaveBeenCalled();
    const retry = executeRecaptcha('site-key', 'login');
    expect(scripts()).toHaveLength(2);
    finish(true);
    await expect(retry).resolves.toBe('token-1');
  });

  it('passes on a refused token request', async () => {
    execute.mockRejectedValueOnce(new Error('invalid site key'));
    const { executeRecaptcha } = await load();
    const pending = executeRecaptcha('bad-key', 'login');
    finish(true);
    await expect(pending).rejects.toThrow('invalid site key');
  });
});
