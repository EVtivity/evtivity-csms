// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  DRIVER_ACTION_CODES,
  DRIVER_AI_ANSWER_MAX_LENGTH,
  DRIVER_AI_ERROR_CODES,
  DRIVER_AI_NOTICE_VERSION,
  DRIVER_AI_NOTICE_VERSIONS,
  DRIVER_AI_OPEN_STATES,
  DRIVER_AI_SETTING_KEYS,
  DRIVER_AI_STATES,
  DRIVER_AI_TERMINAL_STATES,
  driverAiAnswerProblem,
  driverAiAnswerSchema,
  driverAiAnswerTextProblem,
  driverAiConsentInputSchema,
  driverAiJobId,
  isCurrentDriverAiNoticeVersion,
  isDriverAiTerminalState,
  isKnownDriverAiNoticeVersion,
} from '../driver-ai.js';
import { isAiSettingKey } from '../ai-config.js';
import { AI_INSIGHT_ERROR_CODES } from '../ai-insights.js';
import { AI_PROPOSAL_ERROR_CODES } from '../ai-proposals.js';
import { AI_USAGE_ERROR_CODES } from '../ai-usage.js';

const valid = {
  answer: 'The station reported a connector fault. Please try the other connector.',
  category: 'charging_failure',
  driverActions: ['try_other_connector'],
  needsOperator: false,
};

function answerWith(text: string): unknown {
  return { ...valid, answer: text };
}

describe('TC-AI-DR-01 driver AI answer schema', () => {
  it('accepts a plain-text answer with listed action codes', () => {
    expect(driverAiAnswerSchema.safeParse(valid).success).toBe(true);
    expect(driverAiAnswerProblem(valid)).toBeNull();
  });

  it(`rejects an answer over ${String(DRIVER_AI_ANSWER_MAX_LENGTH)} characters`, () => {
    expect(
      driverAiAnswerSchema.safeParse(answerWith('a'.repeat(DRIVER_AI_ANSWER_MAX_LENGTH))).success,
    ).toBe(true);
    expect(
      driverAiAnswerSchema.safeParse(answerWith('a'.repeat(DRIVER_AI_ANSWER_MAX_LENGTH + 1)))
        .success,
    ).toBe(false);
    expect(driverAiAnswerProblem(answerWith('a'.repeat(DRIVER_AI_ANSWER_MAX_LENGTH + 1)))).toBe(
      'answer: too_big',
    );
  });

  it('rejects an empty answer', () => {
    expect(driverAiAnswerSchema.safeParse(answerWith('   ')).success).toBe(false);
  });

  it.each([
    'See https://example.com/help for details.',
    'Open www.example.org to continue.',
    'Write to mailto:help@example.net.',
    'Visit evtivity-help.com for the steps.',
    'Use ftp://files.example.net/log.',
    'Pay at pay-now.xyz today.',
    'See evtivity.ai/help.',
    'Open 192.168.1.10/pay.',
    'Go to example\u3002com now.',
    'Call tel:+14155550100.',
    'Visit ｗｗｗ．example．com.',
  ])('rejects a URL: %s', (text) => {
    expect(driverAiAnswerSchema.safeParse(answerWith(text)).success).toBe(false);
    expect(driverAiAnswerTextProblem(text)).toBe('the answer contains a link or web address');
  });

  it.each([
    '# Steps\nTry again.',
    'Please **unplug** the cable.',
    'Use the `retry` button.',
    'Read [the guide](/help).',
    '> Quoted text',
    '* first\n* second',
    '| a | b |',
    'Please <b>unplug</b> the cable.',
  ])('rejects markdown: %j', (text) => {
    expect(driverAiAnswerSchema.safeParse(answerWith(text)).success).toBe(false);
    expect(driverAiAnswerTextProblem(text)).toBe('the answer contains markdown or HTML');
  });

  it('keeps plain sentences, numbered steps and hyphen lists', () => {
    for (const text of [
      'Your session stopped at 21.4 kWh. 1. Unplug. 2. Plug in again.',
      'Try this:\n- unplug the cable\n- plug it in again',
      'The fee was 2.50 EUR, e.g. for the hold.',
      'Charged 21.4 kWh at 10.5kW, i.e. about 2 hours.',
      'Bitte stecken Sie z.B. den Stecker neu ein.',
      '请尝试另一个接口。谢谢。',
    ]) {
      expect(driverAiAnswerTextProblem(text), text).toBeNull();
    }
  });

  it('rejects an action code outside DRIVER_ACTION_CODES, and duplicates', () => {
    expect(
      driverAiAnswerSchema.safeParse({ ...valid, driverActions: ['refund_driver'] }).success,
    ).toBe(false);
    expect(
      driverAiAnswerSchema.safeParse({
        ...valid,
        driverActions: ['retry_start', 'retry_start'],
      }).success,
    ).toBe(false);
    expect(
      driverAiAnswerSchema.safeParse({ ...valid, driverActions: [...DRIVER_ACTION_CODES] }).success,
    ).toBe(true);
  });

  it('rejects an unknown category and a missing needsOperator', () => {
    expect(driverAiAnswerSchema.safeParse({ ...valid, category: 'refund' }).success).toBe(false);
    expect(
      driverAiAnswerSchema.safeParse({
        answer: valid.answer,
        category: valid.category,
        driverActions: valid.driverActions,
      }).success,
    ).toBe(false);
  });

  it('rejects a card number (Luhn-valid) but keeps other long numbers', () => {
    expect(driverAiAnswerTextProblem('Your card 4242 4242 4242 4242 was declined.')).toBe(
      'the answer contains a card number',
    );
    expect(driverAiAnswerTextProblem('Card 4242424242424242.')).toBe(
      'the answer contains a card number',
    );
    expect(driverAiAnswerTextProblem('Session 1234567890123 ended.')).toBeNull();
    // A long id that starts outside the card networks (2 to 6) stays.
    expect(driverAiAnswerTextProblem('Transaction 1791000000001 ended.')).toBeNull();
  });

  it.each([
    'Please send us your password.',
    'Enter your PIN on the terminal.',
    'Tell us the CVV of your card.',
    'Reply with the verification code.',
    'Bitte nennen Sie Ihr Passwort.',
    'Indique su contraseña.',
    '비밀번호를 알려주세요.',
    '请提供验证码。',
    '請提供密碼。',
    'Bitte nennen Sie die Kreditkartennummer.',
    'Nutzen Sie Ihr Einmalpasswort.',
    'Indique su clave de acceso.',
    '암호를 입력하세요.',
    'Indique su contrase\u006e\u0303a.',
  ])('rejects a request for a secret: %s', (text) => {
    expect(driverAiAnswerTextProblem(text)).toBe(
      'the answer mentions a password, PIN, card number or code',
    );
  });

  it('refuses any mention of a secret, advice included (plan 2.6: the case reaches a person)', () => {
    expect(driverAiAnswerTextProblem('You can reset your password from the sign-in page.')).toBe(
      'the answer mentions a password, PIN, card number or code',
    );
    expect(driverAiAnswerTextProblem('Es un paso clave para cargar.')).toBeNull();
  });

  it('does not treat a lowercase pin as a PIN', () => {
    expect(driverAiAnswerTextProblem('Check the connector pin for damage.')).toBeNull();
  });

  it('names the problem without the answer text', () => {
    expect(driverAiAnswerProblem('text')).toBe('the answer is not a JSON object');
    expect(driverAiAnswerProblem(null)).toBe('the answer is not a JSON object');
    const problem = driverAiAnswerProblem(answerWith('Go to https://evil.example.com now'));
    expect(problem).toBe('answer: the answer contains a link or web address');
    expect(problem).not.toContain('evil');
  });
});

describe('driver AI consent and states', () => {
  it('accepts only the current notice version for a new consent', () => {
    expect(isCurrentDriverAiNoticeVersion(DRIVER_AI_NOTICE_VERSION)).toBe(true);
    expect(isCurrentDriverAiNoticeVersion(DRIVER_AI_NOTICE_VERSION + 1)).toBe(false);
    expect(isCurrentDriverAiNoticeVersion('1')).toBe(false);
    expect(DRIVER_AI_NOTICE_VERSIONS).toContain(DRIVER_AI_NOTICE_VERSION);
    expect(isKnownDriverAiNoticeVersion(DRIVER_AI_NOTICE_VERSION)).toBe(true);
    expect(isKnownDriverAiNoticeVersion(0)).toBe(false);
    expect(isKnownDriverAiNoticeVersion(null)).toBe(false);
  });

  it('validates the consent input', () => {
    const consent = { decision: 'granted', noticeVersion: 1, language: 'zh-TW' };
    expect(driverAiConsentInputSchema.safeParse(consent).success).toBe(true);
    expect(driverAiConsentInputSchema.safeParse({ ...consent, decision: 'yes' }).success).toBe(
      false,
    );
    expect(driverAiConsentInputSchema.safeParse({ ...consent, language: 'fr' }).success).toBe(
      false,
    );
    expect(driverAiConsentInputSchema.safeParse({ ...consent, noticeVersion: 0 }).success).toBe(
      false,
    );
  });

  it('splits the states into open and terminal ones', () => {
    expect([...DRIVER_AI_OPEN_STATES, ...DRIVER_AI_TERMINAL_STATES].sort()).toEqual(
      [...DRIVER_AI_STATES].sort(),
    );
    for (const s of DRIVER_AI_TERMINAL_STATES) expect(isDriverAiTerminalState(s)).toBe(true);
    for (const s of DRIVER_AI_OPEN_STATES) expect(isDriverAiTerminalState(s)).toBe(false);
  });

  it('makes one job id per case', () => {
    expect(driverAiJobId('spc_1')).toBe('dai.spc_1');
  });
});

describe('driver AI setting keys and error codes', () => {
  it('names each setting key once, the limits under the existing AI limit prefixes', () => {
    const keys = Object.values(DRIVER_AI_SETTING_KEYS) as string[];
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys.filter((k) => k.startsWith('driverAi.'))) {
      expect(key).toMatch(/^driverAi\.[a-zA-Z]+$/);
    }
    // The budget and rate limit keys sit with the other AI limit keys.
    expect(isAiSettingKey(DRIVER_AI_SETTING_KEYS.driverDailyTokens)).toBe(true);
    expect(isAiSettingKey(DRIVER_AI_SETTING_KEYS.driverPerMinute)).toBe(true);
  });

  it('reserves its error codes with their HTTP status, apart from the other AI codes', () => {
    expect(DRIVER_AI_ERROR_CODES).toEqual({
      DRIVER_AI_NOTICE_OUTDATED: 409,
      SUPPORT_CASE_AI_NOT_AWAITING_FEEDBACK: 409,
    });
    const others = Object.keys({
      ...AI_INSIGHT_ERROR_CODES,
      ...AI_PROPOSAL_ERROR_CODES,
      ...AI_USAGE_ERROR_CODES,
    });
    for (const code of Object.keys(DRIVER_AI_ERROR_CODES)) expect(others).not.toContain(code);
  });
});
