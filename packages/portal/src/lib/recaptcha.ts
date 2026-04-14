// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

let scriptLoaded = false;
let badgeHidden = false;

function hideBadge(): void {
  if (badgeHidden) return;
  badgeHidden = true;
  const style = document.createElement('style');
  style.textContent = '.grecaptcha-badge { visibility: hidden !important; }';
  document.head.appendChild(style);
}

export function loadRecaptchaScript(siteKey: string): Promise<void> {
  if (scriptLoaded) {
    hideBadge();
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://www.google.com/recaptcha/api.js?render=${siteKey}`;
    script.async = true;
    script.onload = () => {
      scriptLoaded = true;
      hideBadge();
      resolve();
    };
    script.onerror = () => {
      reject(new Error('Failed to load reCAPTCHA script'));
    };
    document.head.appendChild(script);
  });
}

export async function executeRecaptcha(siteKey: string, action: string): Promise<string> {
  await loadRecaptchaScript(siteKey);

  const grecaptcha = (
    window as unknown as {
      grecaptcha: {
        ready: (cb: () => void) => void;
        execute: (key: string, opts: { action: string }) => Promise<string>;
      };
    }
  ).grecaptcha;

  return new Promise((resolve, reject) => {
    grecaptcha.ready(() => {
      hideBadge();
      grecaptcha.execute(siteKey, { action }).then(resolve).catch(reject);
    });
  });
}
