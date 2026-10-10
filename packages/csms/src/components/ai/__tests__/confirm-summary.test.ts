// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeAll, describe, expect, it } from 'vitest';
import i18next, { type i18n } from 'i18next';
import en from '../../../i18n/locales/en.json';
import de from '../../../i18n/locales/de.json';
import es from '../../../i18n/locales/es.json';
import ko from '../../../i18n/locales/ko.json';
import zh from '../../../i18n/locales/zh.json';
import zhTW from '../../../i18n/locales/zh-TW.json';
import { confirmSummary, humanToolName, type ConfirmSummaryInput } from '../confirm-summary';

const LOCALES = { en, de, es, ko, zh, 'zh-TW': zhTW } as const;
type Lang = keyof typeof LOCALES;

let instance: i18n;

beforeAll(async () => {
  instance = i18next.createInstance();
  await instance.init({
    lng: 'en',
    fallbackLng: false,
    resources: Object.fromEntries(
      Object.entries(LOCALES).map(([lng, translation]) => [lng, { translation }]),
    ),
    interpolation: { escapeValue: false },
  });
});

function summary(lang: Lang, input: Partial<ConfirmSummaryInput> & { name: string }): string {
  return confirmSummary(instance.getFixedT(lang), {
    method: 'POST',
    path: '/v1/x',
    arguments: {},
    ...input,
  });
}

const RESET_21 = {
  name: 'ocppv21_reset',
  path: '/v1/ocpp/commands/v21/Reset',
  arguments: { stationId: 'IOCHARGER-002', type: 'OnIdle' },
};

function keys(value: unknown, prefix = ''): string[] {
  if (value == null || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    keys(v, prefix === '' ? k : `${prefix}.${k}`),
  );
}

describe('confirmSummary', () => {
  it('has the same confirmAction keys in all six locales', () => {
    const expected = keys(en.ai.confirmAction).sort();
    for (const [lang, locale] of Object.entries(LOCALES)) {
      expect(keys(locale.ai.confirmAction).sort(), lang).toEqual(expected);
    }
  });

  it.each([
    ['en', 'Reset station IOCHARGER-002 (when idle)'],
    ['de', 'Station IOCHARGER-002 zurücksetzen (im Leerlauf)'],
    ['es', 'Reiniciar la estación IOCHARGER-002 (cuando esté inactiva)'],
    ['ko', '충전소 IOCHARGER-002 재설정 (유휴 상태일 때)'],
    ['zh', '重置充电站 IOCHARGER-002（空闲时）'],
    ['zh-TW', '重設充電站 IOCHARGER-002（閒置時）'],
  ] as const)('describes an OCPP 2.1 reset (%s)', (lang, text) => {
    expect(summary(lang, RESET_21)).toBe(text);
  });

  it('describes the common station commands of both OCPP versions', () => {
    expect(
      summary('en', {
        name: 'ocppv16_reset',
        arguments: { stationId: 'CS-1', type: 'Soft' },
      }),
    ).toBe('Reset station CS-1 (soft reset)');
    expect(
      summary('en', {
        name: 'ocppv21_reset',
        arguments: { stationId: 'CS-1', type: 'Immediate', evseId: 2 },
      }),
    ).toBe('Reset EVSE 2 of station CS-1 (immediately)');
    expect(
      summary('en', {
        name: 'ocppv21_change_availability',
        arguments: { stationId: 'CS-1', operationalStatus: 'Inoperative', evse: { id: 1 } },
      }),
    ).toBe('Set EVSE 1 of station CS-1 to inoperative');
    expect(
      summary('en', {
        name: 'ocppv16_change_availability',
        arguments: { stationId: 'CS-1', connectorId: 0, type: 'Operative' },
      }),
    ).toBe('Set station CS-1 to operative');
    expect(
      summary('en', {
        name: 'ocppv21_unlock_connector',
        arguments: { stationId: 'CS-1', evseId: 1, connectorId: 2 },
      }),
    ).toBe('Unlock EVSE 1, connector 2 of station CS-1');
    expect(
      summary('en', {
        name: 'ocppv16_unlock_connector',
        arguments: { stationId: 'CS-1', connectorId: 1 },
      }),
    ).toBe('Unlock connector 1 of station CS-1');
    expect(
      summary('en', {
        name: 'ocppv21_request_start_transaction',
        arguments: { stationId: 'CS-1', evseId: 1, idToken: { idToken: 'x', type: 'Central' } },
      }),
    ).toBe('Start charging at EVSE 1 of station CS-1');
    expect(
      summary('en', {
        name: 'ocppv16_remote_start_transaction',
        arguments: { stationId: 'CS-1', idTag: 'TAG' },
      }),
    ).toBe('Start charging at station CS-1');
    expect(
      summary('en', {
        name: 'ocppv21_request_stop_transaction',
        arguments: { stationId: 'CS-1', transactionId: 'tx-9' },
      }),
    ).toBe('Stop transaction tx-9 at station CS-1');
    expect(
      summary('en', {
        name: 'ocppv16_remote_stop_transaction',
        arguments: { stationId: 'CS-1', transactionId: 42 },
      }),
    ).toBe('Stop transaction 42 at station CS-1');
    expect(
      summary('en', {
        name: 'ocppv21_set_charging_profile',
        arguments: { stationId: 'CS-1', evseId: 0, chargingProfile: {} },
      }),
    ).toBe('Set a charging profile on station CS-1');
    expect(
      summary('en', {
        name: 'ocppv16_set_charging_profile',
        arguments: { stationId: 'CS-1', connectorId: 1, csChargingProfiles: {} },
      }),
    ).toBe('Set a charging profile on connector 1 of station CS-1');
  });

  it.each(Object.keys(LOCALES) as Lang[])(
    'fills every placeholder of every command sentence (%s)',
    (lang) => {
      const inputs = [
        RESET_21,
        { ...RESET_21, arguments: { stationId: 'S', type: 'Hard' }, name: 'ocppv16_reset' },
        {
          name: 'ocppv21_change_availability',
          arguments: {
            stationId: 'S',
            operationalStatus: 'Operative',
            evse: { id: 1, connectorId: 2 },
          },
        },
        {
          name: 'ocppv21_unlock_connector',
          arguments: { stationId: 'S', evseId: 1, connectorId: 1 },
        },
        { name: 'ocppv21_request_start_transaction', arguments: { stationId: 'S', evseId: 1 } },
        {
          name: 'ocppv21_request_stop_transaction',
          arguments: { stationId: 'S', transactionId: 't' },
        },
        { name: 'ocppv16_set_charging_profile', arguments: { stationId: 'S', connectorId: 1 } },
        {
          name: 'ocppv21_clear_cache',
          path: '/v1/ocpp/commands/v21/ClearCache',
          arguments: { stationId: 'S' },
        },
      ];
      for (const input of inputs) {
        const text = summary(lang, input);
        expect(text).not.toMatch(/\{\{|ai\.confirm/);
        expect(text).toContain(input.arguments.stationId);
      }
    },
  );

  it('names any other OCPP command by its action and station', () => {
    expect(
      summary('de', {
        name: 'ocppv21_clear_cache',
        path: '/v1/ocpp/commands/v21/ClearCache',
        arguments: { stationId: 'CS-1' },
      }),
    ).toBe('ClearCache an Station CS-1 senden');
  });

  it('falls back to the method template with the humanized tool name', () => {
    expect(
      summary('en', {
        name: 'update_station',
        method: 'PATCH',
        path: '/v1/stations/sta_1',
        arguments: { id: 'sta_1' },
      }),
    ).toBe('Update: update station');
    // An OCPP tool without a station id is not described as a station command.
    expect(summary('en', { name: 'ocppv21_reset', arguments: { type: 'OnIdle' } })).toBe(
      'Create or run: ocppv21 reset',
    );
    expect(humanToolName('reset_station')).toBe('reset station');
  });
});
