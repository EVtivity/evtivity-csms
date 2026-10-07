// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { OCPP_NOTIFICATION_EVENT_TYPES } from '@evtivity/lib/notification-events';
import {
  OCPP_16_EVENTS,
  OCPP_21_EVENTS,
  OCPP_COMMON_EVENTS,
  OCPP_EVENT_TYPES,
  OPERATOR_EVENT_TYPES,
  OPERATOR_SESSION_EVENTS,
  TEMPLATE_VARIABLES,
} from '../template-variables';
import en from '../../i18n/locales/en.json';
import de from '../../i18n/locales/de.json';
import es from '../../i18n/locales/es.json';
import ko from '../../i18n/locales/ko.json';
import zh from '../../i18n/locales/zh.json';
import zhTW from '../../i18n/locales/zh-TW.json';

const LOCALES = { en, de, es, ko, zh, 'zh-TW': zhTW };

describe('operator session alert events', () => {
  it('lists session.EndRequestFailed as an operator event with its variables', () => {
    expect(OPERATOR_SESSION_EVENTS).toContain('session.EndRequestFailed');
    expect(OPERATOR_EVENT_TYPES).toContain('session.EndRequestFailed');
    const names = (TEMPLATE_VARIABLES['session.EndRequestFailed'] ?? []).map((v) => v.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'sessionId',
        'stationId',
        'siteName',
        'transactionId',
        'endRequestReason',
        'attempts',
        'startedAt',
        'endedAt',
      ]),
    );
  });

  it('names the event and its group in every locale', () => {
    for (const [lang, locale] of Object.entries(LOCALES)) {
      const notifications = locale.notifications as Record<string, unknown>;
      const eventNames = notifications['eventNames'] as Record<string, string>;
      expect(eventNames['session.EndRequestFailed'], lang).toBeTruthy();
      expect(notifications['sessionAlertEvents'], lang).toBeTruthy();
    }
  });
});

// Every OCPP and station template: ocpp/src/templates/<lang>/{ocpp,station}/<Event>/<channel>.hbs.
const OCPP_TEMPLATES = import.meta.glob<string>(
  [
    '../../../../ocpp/src/templates/*/ocpp/*/*.hbs',
    '../../../../ocpp/src/templates/*/station/*/*.hbs',
  ],
  { query: '?raw', import: 'default', eager: true },
);

function templateEvent(path: string): { language: string; event: string } {
  const [language, family, event] = path.split('/').slice(-4, -1);
  return { language: language ?? '', event: `${family ?? ''}.${event ?? ''}` };
}

describe('OCPP event groups', () => {
  it('split the shared OCPP event list into the common, 1.6 and 2.1 groups', () => {
    expect([...OCPP_COMMON_EVENTS, ...OCPP_16_EVENTS, ...OCPP_21_EVENTS].sort()).toEqual(
      [...OCPP_NOTIFICATION_EVENT_TYPES].sort(),
    );
    expect(OCPP_EVENT_TYPES).toEqual(OCPP_NOTIFICATION_EVENT_TYPES);
  });

  it('list every OCPP and station event with templates, in all six languages', () => {
    const listed = new Set<string>(OCPP_NOTIFICATION_EVENT_TYPES);
    const byLanguage = new Map<string, Set<string>>();
    for (const path of Object.keys(OCPP_TEMPLATES)) {
      const { language, event } = templateEvent(path);
      expect(listed.has(event), `${event} has templates but is in no OCPP group`).toBe(true);
      const events = byLanguage.get(language) ?? new Set<string>();
      events.add(event);
      byLanguage.set(language, events);
    }
    expect([...byLanguage.keys()].sort()).toEqual(Object.keys(LOCALES).sort());
    for (const [language, events] of byLanguage) {
      expect([...events].sort(), language).toEqual([...listed].sort());
    }
  });

  it('documents every variable the OCPP templates use', () => {
    for (const [path, source] of Object.entries(OCPP_TEMPLATES)) {
      const { event } = templateEvent(path);
      const documented = new Set((TEMPLATE_VARIABLES[event] ?? []).map((v) => v.name));
      for (const match of source.matchAll(/{{{?(?:#if |#unless |else if )?([a-zA-Z]+)}?}}/g)) {
        const name = match[1] ?? '';
        if (name === 'else' || name.startsWith('company')) continue;
        expect(documented.has(name), `${path}: {{${name}}}`).toBe(true);
      }
    }
  });
});
