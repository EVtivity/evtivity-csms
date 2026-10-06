// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileAllowedTemplate } from '@evtivity/lib';

const TEMPLATES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const LANGUAGES = ['en', 'de', 'es', 'ko', 'zh', 'zh-TW'];

function renderEmail(language: string, event: string, variables: Record<string, string>): string {
  const source = readFileSync(
    resolve(TEMPLATES_DIR, language, 'driver', event, 'email.hbs'),
    'utf-8',
  );
  return compileAllowedTemplate(source)(variables);
}

describe('driver auth email templates', () => {
  // The driver can only sign in after opening this link (EMAIL_NOT_VERIFIED otherwise).
  it.each(LANGUAGES)('AccountVerification (%s) links to verifyUrl', (language) => {
    const verifyUrl = 'https://portal.example.com/verify-email?token=abc123';
    const html = renderEmail(language, 'AccountVerification', {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      verifyUrl,
    });
    // The renderer escapes the = of the query string; mail clients decode it.
    expect(html).toContain(`href='${verifyUrl.replace('=', '&#x3D;')}'`);
  });

  it.each(LANGUAGES)('ForgotPassword (%s) links to resetUrl', (language) => {
    const resetUrl = 'https://portal.example.com/reset-password?token=abc123';
    const html = renderEmail(language, 'ForgotPassword', {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      resetUrl,
    });
    expect(html).toContain(`href='${resetUrl.replace('=', '&#x3D;')}'`);
  });
});
