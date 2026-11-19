// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  queries: [] as string[],
  recipients: [] as Record<string, unknown>[],
  failRecipients: false,
}));
const dispatch = vi.hoisted(() => vi.fn());

vi.mock('@evtivity/database', () => ({
  client: (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    state.queries.push(text);
    if (text.includes('FROM users u')) {
      return state.failRecipients
        ? Promise.reject(new Error('db down'))
        : Promise.resolve(state.recipients);
    }
    return Promise.resolve([{ first_name: 'Fleet', last_name: 'Manager' }]);
  },
}));
vi.mock('@evtivity/lib', () => ({ dispatchSystemNotification: dispatch }));
vi.mock('@evtivity/services/template-dirs', () => ({ ALL_TEMPLATES_DIRS: ['/templates'] }));
vi.mock('../lib/config.js', () => ({ config: { CSMS_URL: 'https://csms.example/' } }));

import { notifyFleetTaxIdChanged, FLEET_TAX_ID_CHANGED_EVENT } from '../lib/fleet-tax-id-notice.js';

const log = { warn: vi.fn() };

describe('notifyFleetTaxIdChanged', () => {
  beforeEach(() => {
    state.queries = [];
    state.failRecipients = false;
    state.recipients = [
      {
        id: 'usr_1',
        email: 'ops@example.com',
        phone: null,
        first_name: 'Ops',
        last_name: 'One',
        language: 'de',
        timezone: 'Europe/Berlin',
      },
    ];
    dispatch.mockReset();
    dispatch.mockResolvedValue({ delivered: [] });
    log.warn.mockReset();
  });

  it('sends one notice per operator with the old and new number and a link to the Billing tab', async () => {
    await notifyFleetTaxIdChanged(
      {
        fleetId: 'flt_000000000001',
        fleetName: 'Acme',
        previousTaxId: 'DE111',
        newTaxId: 'DE222',
        changedByUserId: 'usr_fleet',
      },
      log,
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [, event, recipient, variables] = dispatch.mock.calls[0] as unknown[];
    expect(event).toBe(FLEET_TAX_ID_CHANGED_EVENT);
    expect(recipient).toMatchObject({ email: 'ops@example.com', language: 'de', userId: 'usr_1' });
    expect(variables).toEqual({
      fleetName: 'Acme',
      previousTaxId: 'DE111',
      newTaxId: 'DE222',
      taxIdRemoved: false,
      changedBy: 'Fleet Manager',
      fleetUrl: 'https://csms.example/fleets/flt_000000000001?tab=billing',
    });
    // Recipients: all-site users with payments:write or fleetBilling:write, not the actor.
    const query = state.queries.find((q) => q.includes('FROM users u')) ?? '';
    expect(query).toContain('has_all_site_access');
    expect(query).toContain("'payments:write', 'fleetBilling:write'");
    expect(query).toContain('IS DISTINCT FROM');
  });

  it('says the number was removed', async () => {
    await notifyFleetTaxIdChanged(
      {
        fleetId: 'flt_1',
        fleetName: 'Acme',
        previousTaxId: 'DE111',
        newTaxId: null,
        changedByUserId: null,
      },
      log,
    );
    const variables = dispatch.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(variables.taxIdRemoved).toBe(true);
    expect(variables.changedBy).toBe('');
  });

  it('logs and goes on when a send or the recipient read fails', async () => {
    dispatch.mockRejectedValueOnce(new Error('smtp'));
    await notifyFleetTaxIdChanged(
      {
        fleetId: 'flt_1',
        fleetName: 'A',
        previousTaxId: null,
        newTaxId: 'X',
        changedByUserId: null,
      },
      log,
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
    state.failRecipients = true;
    await expect(
      notifyFleetTaxIdChanged(
        {
          fleetId: 'flt_1',
          fleetName: 'A',
          previousTaxId: null,
          newTaxId: 'X',
          changedByUserId: null,
        },
        log,
      ),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});
