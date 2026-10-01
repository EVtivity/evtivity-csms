// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { redactSensitiveNotificationContent } from '../notification-dispatch.js';

const TOKEN = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0';

describe('redactSensitiveNotificationContent', () => {
  it.each([
    ['plain', `https://portal.test/activate?token=${TOKEN}`],
    ['Handlebars-escaped', `https://portal.test/activate?token&#x3D;${TOKEN}`],
    ['decimal entity', `https://portal.test/activate?token&#61;${TOKEN}`],
    ['URL-encoded', `https://portal.test/activate?token%3D${TOKEN}`],
    ['escaped ampersand', `https://portal.test/x?a=1&amp;resetToken&#x3D;${TOKEN}`],
  ])('removes a %s token from a sensitive email body', (_label, link) => {
    const html = `<a href='${link}' style="color:#fff">Set Your Password</a>`;
    const out = redactSensitiveNotificationContent(html, 'driver.PortalInvite');
    expect(out).not.toContain(TOKEN);
    expect(out).toContain('<redacted>');
    expect(out).toContain('Set Your Password');
  });

  it('redacts the reset link in a forgot-password email', () => {
    const html = `<a href='https://portal.test/reset-password?token&#x3D;${TOKEN}'>Reset</a>`;
    expect(redactSensitiveNotificationContent(html, 'driver.ForgotPassword')).not.toContain(TOKEN);
  });

  it('redacts the set-password link in an operator account setup email', () => {
    const html = `<a href='https://csms.test/reset-password?token&#x3D;${TOKEN}'>Set</a>`;
    expect(redactSensitiveNotificationContent(html, 'operator.UserCreated')).not.toContain(TOKEN);
  });

  it('leaves non-sensitive events unchanged', () => {
    const html = `<a href='https://portal.test/activate?token&#x3D;${TOKEN}'>x</a>`;
    expect(redactSensitiveNotificationContent(html, 'session.Started')).toBe(html);
  });
});
