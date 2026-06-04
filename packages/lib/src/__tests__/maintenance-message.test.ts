// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_MAINTENANCE_MESSAGE_TEMPLATE,
  renderMaintenanceMessage,
} from '../maintenance-message.js';

interface SqlCall {
  key: unknown;
}

let sqlCalls: SqlCall[] = [];
let settingValues: Record<string, string | null>;

function createSqlMock() {
  const sqlFn = (_strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const key = values[0] as string;
    sqlCalls.push({ key });
    const value = settingValues[key];
    const rows = value == null ? [] : [{ value }];
    return Promise.resolve(rows);
  };
  return sqlFn as never;
}

const sql = createSqlMock();

function event(
  overrides: Partial<{
    customMessage: string | null;
    reason: string | null;
    plannedStartAt: Date;
    plannedEndAt: Date;
  }> = {},
) {
  return {
    customMessage: null,
    reason: null,
    plannedStartAt: new Date('2026-06-01T10:00:00.000Z'),
    plannedEndAt: new Date('2026-06-01T11:00:00.000Z'),
    ...overrides,
  };
}

describe('DEFAULT_MAINTENANCE_MESSAGE_TEMPLATE', () => {
  it('is the package default constant', () => {
    expect(DEFAULT_MAINTENANCE_MESSAGE_TEMPLATE).toBe(
      'This site is temporarily unavailable for maintenance. {{reason}}',
    );
  });
});

describe('renderMaintenanceMessage', () => {
  beforeEach(() => {
    sqlCalls = [];
    settingValues = {};
  });

  describe('template selection', () => {
    it('uses the custom message when set and skips the default-template lookup', async () => {
      settingValues['company.name'] = 'Acme Power';
      const result = await renderMaintenanceMessage(
        sql,
        event({ customMessage: 'Closed: {{reason}}', reason: 'storm damage' }),
        'North Lot',
      );
      expect(result).toBe('Closed: storm damage');
      expect(sqlCalls.map((c) => c.key)).toEqual(['company.name']);
    });

    it('trims whitespace around the custom message before deciding to use it', async () => {
      settingValues['company.name'] = 'Acme Power';
      const result = await renderMaintenanceMessage(
        sql,
        event({ customMessage: '  Down at {{siteName}}  ', reason: 'x' }),
        'South Lot',
      );
      // The trimmed custom message is what gets compiled, so the surrounding
      // spaces are gone.
      expect(result).toBe('Down at South Lot');
      expect(sqlCalls.map((c) => c.key)).toEqual(['company.name']);
    });

    it('falls back to the default-template setting when custom message is null', async () => {
      settingValues['maintenance.defaultMessageTemplate'] =
        'Maint at {{siteName}} for {{durationMinutes}}m';
      settingValues['company.name'] = 'Acme Power';
      const result = await renderMaintenanceMessage(sql, event(), 'Depot A');
      expect(result).toBe('Maint at Depot A for 60m');
      expect(sqlCalls.map((c) => c.key)).toEqual([
        'maintenance.defaultMessageTemplate',
        'company.name',
      ]);
    });

    it('falls back to the default-template setting when custom message is an empty string', async () => {
      settingValues['maintenance.defaultMessageTemplate'] = 'Setting template';
      settingValues['company.name'] = 'Acme Power';
      const result = await renderMaintenanceMessage(sql, event({ customMessage: '' }), 'Depot B');
      expect(result).toBe('Setting template');
      expect(sqlCalls.map((c) => c.key)).toEqual([
        'maintenance.defaultMessageTemplate',
        'company.name',
      ]);
    });

    it('falls back to the default-template setting when custom message is only whitespace', async () => {
      settingValues['maintenance.defaultMessageTemplate'] = 'Setting template';
      settingValues['company.name'] = 'Acme Power';
      const result = await renderMaintenanceMessage(
        sql,
        event({ customMessage: '   ' }),
        'Depot C',
      );
      expect(result).toBe('Setting template');
      expect(sqlCalls.map((c) => c.key)).toEqual([
        'maintenance.defaultMessageTemplate',
        'company.name',
      ]);
    });

    it('uses the package default constant when no custom message and no setting exist', async () => {
      settingValues['company.name'] = 'Acme Power';
      const result = await renderMaintenanceMessage(
        sql,
        event({ reason: 'cable replacement' }),
        'Depot D',
      );
      expect(result).toBe(
        'This site is temporarily unavailable for maintenance. cable replacement',
      );
    });
  });

  describe('variable substitution', () => {
    it('substitutes every variable correctly', async () => {
      settingValues['company.name'] = 'Volt Co';
      const result = await renderMaintenanceMessage(
        sql,
        event({
          customMessage:
            '{{companyName}} | {{siteName}} | {{endTime}} | {{durationMinutes}} | {{reason}}',
          reason: 'panel swap',
          plannedStartAt: new Date('2026-06-01T10:00:00.000Z'),
          plannedEndAt: new Date('2026-06-01T12:30:00.000Z'),
        }),
        'Main Site',
      );
      expect(result).toBe('Volt Co | Main Site | 2026-06-01T12:30:00.000Z | 150 | panel swap');
    });

    it('renders endTime as the ISO 8601 plannedEndAt', async () => {
      settingValues['company.name'] = 'Volt Co';
      const result = await renderMaintenanceMessage(
        sql,
        event({
          customMessage: '{{endTime}}',
          plannedEndAt: new Date('2026-12-31T23:59:59.000Z'),
        }),
        'Site',
      );
      expect(result).toBe('2026-12-31T23:59:59.000Z');
    });
  });

  describe('companyName default', () => {
    it('defaults companyName to "EVtivity" when the company.name setting is absent', async () => {
      const result = await renderMaintenanceMessage(
        sql,
        event({ customMessage: 'By {{companyName}}' }),
        'Site',
      );
      expect(result).toBe('By EVtivity');
    });

    it('uses the configured company.name when present', async () => {
      settingValues['company.name'] = 'Charge Network LLC';
      const result = await renderMaintenanceMessage(
        sql,
        event({ customMessage: 'By {{companyName}}' }),
        'Site',
      );
      expect(result).toBe('By Charge Network LLC');
    });
  });

  describe('reason default', () => {
    it('renders an empty string for reason when reason is null', async () => {
      settingValues['company.name'] = 'EVtivity';
      const result = await renderMaintenanceMessage(
        sql,
        event({ customMessage: 'Reason:[{{reason}}]', reason: null }),
        'Site',
      );
      expect(result).toBe('Reason:[]');
    });

    it('renders the supplied reason text when present', async () => {
      settingValues['company.name'] = 'EVtivity';
      const result = await renderMaintenanceMessage(
        sql,
        event({ customMessage: 'Reason:[{{reason}}]', reason: 'flooding' }),
        'Site',
      );
      expect(result).toBe('Reason:[flooding]');
    });
  });

  describe('durationMinutes rounding', () => {
    it('rounds the duration to whole minutes (round half up)', async () => {
      settingValues['company.name'] = 'EVtivity';
      const result = await renderMaintenanceMessage(
        sql,
        event({
          customMessage: '{{durationMinutes}}',
          plannedStartAt: new Date('2026-06-01T10:00:00.000Z'),
          plannedEndAt: new Date('2026-06-01T10:00:30.000Z'),
        }),
        'Site',
      );
      // 30 seconds rounds to 1 minute.
      expect(result).toBe('1');
    });

    it('rounds a sub-30-second window down to zero', async () => {
      settingValues['company.name'] = 'EVtivity';
      const result = await renderMaintenanceMessage(
        sql,
        event({
          customMessage: '{{durationMinutes}}',
          plannedStartAt: new Date('2026-06-01T10:00:00.000Z'),
          plannedEndAt: new Date('2026-06-01T10:00:29.000Z'),
        }),
        'Site',
      );
      expect(result).toBe('0');
    });

    it('produces a negative duration when end precedes start', async () => {
      settingValues['company.name'] = 'EVtivity';
      const result = await renderMaintenanceMessage(
        sql,
        event({
          customMessage: '{{durationMinutes}}',
          plannedStartAt: new Date('2026-06-01T11:00:00.000Z'),
          plannedEndAt: new Date('2026-06-01T10:00:00.000Z'),
        }),
        'Site',
      );
      expect(result).toBe('-60');
    });
  });

  describe('fetchSetting non-string handling', () => {
    it('treats a non-string company.name row value as absent and uses the EVtivity default', async () => {
      // settings row exists but value is not a string -> fetchSetting returns null.
      settingValues = {};
      const sqlWithNonString = ((_s: TemplateStringsArray, ...values: unknown[]) => {
        const key = values[0] as string;
        sqlCalls.push({ key });
        if (key === 'company.name') return Promise.resolve([{ value: 42 }]);
        return Promise.resolve([]);
      }) as never;
      const result = await renderMaintenanceMessage(
        sqlWithNonString,
        event({ customMessage: 'By {{companyName}}' }),
        'Site',
      );
      expect(result).toBe('By EVtivity');
    });

    it('treats a non-string default-template row value as absent and uses the package constant', async () => {
      const sqlWithNonString = ((_s: TemplateStringsArray, ...values: unknown[]) => {
        const key = values[0] as string;
        sqlCalls.push({ key });
        if (key === 'maintenance.defaultMessageTemplate') {
          return Promise.resolve([{ value: { not: 'a string' } }]);
        }
        if (key === 'company.name') return Promise.resolve([{ value: 'EVtivity' }]);
        return Promise.resolve([]);
      }) as never;
      const result = await renderMaintenanceMessage(
        sqlWithNonString,
        event({ reason: 'maintenance' }),
        'Site',
      );
      expect(result).toBe('This site is temporarily unavailable for maintenance. maintenance');
    });
  });

  describe('noEscape compilation', () => {
    it('does not HTML-escape special characters in substituted values', async () => {
      settingValues['company.name'] = 'A & B <Co>';
      const result = await renderMaintenanceMessage(
        sql,
        event({ customMessage: '{{companyName}} / {{reason}}', reason: '"quotes" & <tags>' }),
        'Site',
      );
      expect(result).toBe('A & B <Co> / "quotes" & <tags>');
    });
  });
});
