// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The payment terminal flow (features/payment-terminals.md): the start
// (prompts, charging on an authorized hold), the pairing check before a
// start (a forged event never starts another station, case 269), the hold
// released when charging cannot start, device status polling and the
// offline alert, the reconciliation follow-up and the receipt link (a CSMS
// token, never the provider reference, case 273).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb } from './helpers/fake-db.js';

const h = vi.hoisted(() => ({
  fake: undefined as unknown as FakeDb,
  offlineClaims: [] as Record<string, unknown>[],
  claims: [] as unknown[],
  getProvider: vi.fn(),
  startTerminalPayment: vi.fn(),
  claimTerminalStart: vi.fn(),
  voidTerminalTransaction: vi.fn(),
  linkTerminalGuestSession: vi.fn(),
  ingestTerminalWebhook: vi.fn(),
  reconcileTerminalTransactions: vi.fn(),
  handleGuestSessionEvent: vi.fn(),
  settleTerminalSession: vi.fn(),
  startAdHocPayment: vi.fn(),
  syncPaymentTerminalDevice: vi.fn(),
  dispatchOneShotStationMessage: vi.fn(),
  dispatchSystemNotification: vi.fn(),
  renderStationMessage: vi.fn(),
}));

vi.mock('@evtivity/database', async () => {
  const { createFakeDb, fakeDatabaseModule } = await import('./helpers/fake-db.js');
  h.fake = createFakeDb();
  return fakeDatabaseModule(h.fake, {
    getCompanyCurrency: () => Promise.resolve('USD'),
    claimTerminalOfflineAlerts: (since: Date, now: Date) => {
      h.offlineClaims.push({ since, now });
      return Promise.resolve(h.claims);
    },
  });
});

vi.mock('@evtivity/lib', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dispatchOneShotStationMessage: h.dispatchOneShotStationMessage,
    dispatchSystemNotification: h.dispatchSystemNotification,
    renderStationMessage: h.renderStationMessage,
  };
});

vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: () => ({ marker: 'pubsub' }) }));

vi.mock('@evtivity/payments', () => ({
  claimTerminalStart: h.claimTerminalStart,
  handleGuestSessionEvent: h.handleGuestSessionEvent,
  ingestTerminalWebhook: h.ingestTerminalWebhook,
  reconcileTerminalTransactions: h.reconcileTerminalTransactions,
  linkTerminalGuestSession: h.linkTerminalGuestSession,
  settleTerminalSession: h.settleTerminalSession,
  startTerminalPayment: h.startTerminalPayment,
  terminalRegistry: () => ({ getProvider: h.getProvider }),
  voidTerminalTransaction: h.voidTerminalTransaction,
  withPaymentActor: (ctx: Record<string, unknown>, actor: unknown) => ({ ...ctx, actor }),
}));

vi.mock('@evtivity/payment-terminals', () => ({
  isTerminalProviderId: (id: string) => id === 'simulated' || id === 'idtech',
  SIMULATED_SIGNATURE_HEADER: 'x-evtivity-terminal-signature',
}));

vi.mock('../ad-hoc-payment.service.js', () => ({ startAdHocPayment: h.startAdHocPayment }));
vi.mock('../payment-terminal.service.js', () => ({
  syncPaymentTerminalDevice: h.syncPaymentTerminalDevice,
}));

const flow = await import('../payment-terminal-flow.js');

const warn = vi.fn();
const deps = {
  payments: { marker: 'payments' } as never,
  logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  portalUrl: 'https://portal.example//',
};

function terminal(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ptm_1',
    provider: 'simulated',
    providerDeviceId: 'sim_term_1',
    model: 'VP6825',
    stationId: 'sta_db',
    evseId: null,
    siteId: 'sit_1',
    label: 'Reader',
    serialNumber: 'SN1',
    ...over,
  };
}

/** Queues the three reads of `placeOf`. */
function queuePlace(
  t: Record<string, unknown> = terminal(),
  evses: { id: string; evseId: number }[] = [
    { id: 'evs_1', evseId: 1 },
    { id: 'evs_2', evseId: 2 },
  ],
): void {
  h.fake.queue('select:payment_terminals', [t]);
  h.fake.queue('select:charging_stations', [{ id: 'sta_db', stationId: 'CS-1' }]);
  h.fake.queue('select:evses', evses);
}

function txn(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ptx_1',
    paymentTerminalId: 'ptm_1',
    stationId: 'sta_db',
    state: 'authorized',
    requestedCents: 5000,
    authorizedCents: 5000,
    providerTxnRef: 'ref_1',
    evseNumber: null,
    cardLast4: '4242',
    cardBin: '424242',
    receiptEmail: 'a@example.com',
    guestSessionId: null,
    receiptUrl: null,
    ...over,
  };
}

function displayProvider(display = true) {
  return {
    capabilities: { display, deviceStatus: true },
    displayMessage: vi.fn(),
    getDevice: vi.fn(),
  };
}

function setClaims(claims: unknown[]): void {
  h.claims = claims;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.fake.reset();
  h.offlineClaims.length = 0;
  setClaims([]);
  h.renderStationMessage.mockResolvedValue('Rendered');
  h.getProvider.mockResolvedValue(displayProvider());
});

describe('showTerminalPrompt', () => {
  const place = { terminal: terminal() as never, stationOcppId: 'CS-1', stationDbId: 'sta_db' };

  it('shows the prompt on a terminal with a screen, with the receipt QR', async () => {
    const provider = displayProvider();
    h.getProvider.mockResolvedValue(provider);
    await flow.showTerminalPrompt(place, 'terminal_receipt', { receiptUrl: 'https://r' }, deps);
    expect(provider.displayMessage).toHaveBeenCalledWith('sim_term_1', {
      kind: 'receipt',
      text: 'Rendered',
      qrUrl: 'https://r',
    });
    expect(h.renderStationMessage).toHaveBeenCalledWith(
      'terminal_receipt',
      expect.objectContaining({ stationOcppId: 'CS-1', receiptUrl: 'https://r' }),
    );
    expect(h.dispatchOneShotStationMessage).not.toHaveBeenCalled();
  });

  it('maps the card and result states to their display kinds', async () => {
    const provider = displayProvider();
    h.getProvider.mockResolvedValue(provider);
    await flow.showTerminalPrompt(place, 'terminal_card', {}, deps);
    await flow.showTerminalPrompt(place, 'terminal_result', { paymentApproved: true }, deps);
    expect(provider.displayMessage.mock.calls.map((c) => (c[1] as { kind: string }).kind)).toEqual([
      'present_card',
      'result',
    ]);
    expect(provider.displayMessage.mock.calls[0]![1]).not.toHaveProperty('qrUrl');
  });

  it('uses the station display for a reader without a screen (60 s)', async () => {
    await flow.showTerminalPrompt(
      { ...place, terminal: terminal({ model: 'VP7200' }) as never },
      'terminal_card',
      { terminalAmount: '$50.00' },
      deps,
    );
    expect(h.getProvider).not.toHaveBeenCalled();
    expect(h.dispatchOneShotStationMessage).toHaveBeenCalledWith(
      { marker: 'pubsub' },
      expect.anything(),
      expect.objectContaining({
        stationOcppId: 'CS-1',
        stationDbId: 'sta_db',
        state: 'terminal_card',
      }),
      { ttlSeconds: 60 },
    );
  });

  it('falls back to the station display when the provider cannot show it (120 s receipt)', async () => {
    h.getProvider.mockResolvedValue(displayProvider(false));
    await flow.showTerminalPrompt(place, 'terminal_receipt', {}, deps);
    expect(h.dispatchOneShotStationMessage.mock.calls[0]![3]).toEqual({ ttlSeconds: 120 });
    h.getProvider.mockResolvedValue(null);
    await flow.showTerminalPrompt(
      { ...place, terminal: terminal({ providerDeviceId: null }) as never },
      'terminal_result',
      {},
      deps,
    );
    await flow.showTerminalPrompt(
      { ...place, terminal: terminal({ provider: 'ocpp' }) as never },
      'terminal_result',
      {},
      deps,
    );
    expect(h.dispatchOneShotStationMessage).toHaveBeenCalledTimes(3);
  });

  it('warns and never throws when showing fails (fail-open)', async () => {
    h.getProvider.mockRejectedValue(new Error('down'));
    await expect(
      flow.showTerminalPrompt(place, 'terminal_card', {}, deps),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ paymentTerminalId: 'ptm_1', state: 'terminal_card' }),
      'Terminal prompt not shown',
    );
  });
});

describe('startTerminalPaymentFlow', () => {
  it('offers the station EVSEs on a station-wide terminal and shows the card prompt', async () => {
    queuePlace();
    h.startTerminalPayment.mockResolvedValue({
      kind: 'started',
      transaction: txn({ state: 'presenting' }),
    });
    const out = await flow.startTerminalPaymentFlow('ptm_1', { amountCents: 5000 }, deps);
    expect(out.kind).toBe('started');
    expect(h.startTerminalPayment).toHaveBeenCalledWith(
      {
        terminalId: 'ptm_1',
        amountCents: 5000,
        receiptEmail: null,
        evseChoices: [1, 2],
        evseNumber: null,
      },
      deps.payments,
    );
    expect(h.renderStationMessage).toHaveBeenCalledWith(
      'terminal_card',
      expect.objectContaining({ terminalAmount: '$50.00' }),
    );
  });

  it('starts on the paired EVSE with no choices', async () => {
    queuePlace(terminal({ evseId: 'evs_2' }));
    h.startTerminalPayment.mockResolvedValue({
      kind: 'started',
      transaction: txn({ state: 'requested' }),
    });
    await flow.startTerminalPaymentFlow('ptm_1', { receiptEmail: 'd@example.com' }, deps);
    expect(h.startTerminalPayment.mock.calls[0]![0]).toEqual({
      terminalId: 'ptm_1',
      receiptEmail: 'd@example.com',
      evseChoices: [],
      evseNumber: 2,
    });
  });

  it('starts on the only EVSE of a one-connector station', async () => {
    queuePlace(terminal(), [{ id: 'evs_1', evseId: 1 }]);
    h.startTerminalPayment.mockResolvedValue({ kind: 'not_found' });
    expect((await flow.startTerminalPaymentFlow('ptm_1', {}, deps)).kind).toBe('not_found');
    expect(h.startTerminalPayment.mock.calls[0]![0]).toMatchObject({
      evseChoices: [],
      evseNumber: 1,
    });
  });

  it('passes no EVSE for an unpaired terminal and returns the outcome as is', async () => {
    h.fake.queue('select:payment_terminals', [terminal({ stationId: null })]);
    h.startTerminalPayment.mockResolvedValue({
      kind: 'started',
      transaction: txn({ state: 'presenting' }),
    });
    const out = await flow.startTerminalPaymentFlow('ptm_1', {}, deps);
    expect(out.kind).toBe('started');
    expect(h.startTerminalPayment.mock.calls[0]![0]).toMatchObject({
      evseChoices: [],
      evseNumber: null,
    });
    expect(h.renderStationMessage).not.toHaveBeenCalled();
  });

  it('shows a decline on the terminal', async () => {
    queuePlace();
    h.startTerminalPayment.mockResolvedValue({
      kind: 'started',
      transaction: txn({ state: 'declined' }),
    });
    await flow.startTerminalPaymentFlow('ptm_1', {}, deps);
    expect(h.renderStationMessage).toHaveBeenCalledWith(
      'terminal_result',
      expect.objectContaining({ paymentApproved: false }),
    );
  });

  it('shows nothing for another started state', async () => {
    queuePlace();
    h.startTerminalPayment.mockResolvedValue({
      kind: 'started',
      transaction: txn({ state: 'voided' }),
    });
    await flow.startTerminalPaymentFlow('ptm_1', {}, deps);
    expect(h.renderStationMessage).not.toHaveBeenCalled();
  });

  it('starts charging when the card is authorized at once', async () => {
    queuePlace();
    h.startTerminalPayment.mockResolvedValue({ kind: 'started', transaction: txn() });
    h.claimTerminalStart.mockResolvedValue(null);
    const out = await flow.startTerminalPaymentFlow('ptm_1', {}, deps);
    expect(h.claimTerminalStart).toHaveBeenCalledWith('ptx_1');
    expect(out).toEqual({ kind: 'started', transaction: txn() });
  });
});

describe('startChargingForTerminal', () => {
  it('does nothing when the start was already claimed', async () => {
    h.claimTerminalStart.mockResolvedValue(txn({ providerTxnRef: null }));
    const out = await flow.startChargingForTerminal(txn() as never, deps);
    expect(out.kind).toBe('started');
    expect(h.startAdHocPayment).not.toHaveBeenCalled();
    h.claimTerminalStart.mockResolvedValue(txn({ authorizedCents: null }));
    await flow.startChargingForTerminal(txn() as never, deps);
    expect(h.startAdHocPayment).not.toHaveBeenCalled();
  });

  it('releases the hold when the terminal is no longer paired to that station', async () => {
    h.claimTerminalStart.mockResolvedValue(txn({ stationId: 'sta_other' }));
    queuePlace();
    const out = await flow.startChargingForTerminal(txn() as never, deps);
    expect(out).toMatchObject({
      kind: 'charging_not_started',
      code: 'PAYMENT_TERMINAL_NOT_PAIRED',
    });
    expect(h.voidTerminalTransaction).toHaveBeenCalledWith(
      'ptx_1',
      'terminal_unpaired',
      deps.payments,
    );
    expect(h.startAdHocPayment).not.toHaveBeenCalled();
  });

  it('releases the hold when the terminal is gone', async () => {
    h.claimTerminalStart.mockResolvedValue(txn());
    const out = await flow.startChargingForTerminal(txn() as never, deps);
    expect(out.kind).toBe('charging_not_started');
  });

  it('releases the hold when the station row is gone', async () => {
    h.claimTerminalStart.mockResolvedValue(txn());
    h.fake.queue('select:payment_terminals', [terminal()]);
    const out = await flow.startChargingForTerminal(txn() as never, deps);
    expect(out.kind).toBe('charging_not_started');
  });

  it('starts on the picked EVSE with the stored pairing, links the session and approves', async () => {
    h.claimTerminalStart.mockResolvedValue(txn({ evseNumber: 2 }));
    queuePlace();
    h.startAdHocPayment.mockResolvedValue({ ok: true, guestSessionId: 'gst_1' });
    const out = await flow.startChargingForTerminal(txn() as never, deps);
    expect(out).toMatchObject({
      kind: 'charging_started',
      transaction: { guestSessionId: 'gst_1' },
    });
    const [input, options] = h.startAdHocPayment.mock.calls[0]! as [
      Record<string, unknown>,
      { siteAllowed: () => boolean; terminalToken: boolean; actor: Record<string, unknown> },
    ];
    expect(input).toEqual({
      stationId: 'CS-1',
      evseId: 2,
      pspRef: 'ref_1',
      cardLast4Digits: '4242',
      cardBin: '424242',
      maxCostCents: 5000,
      email: 'a@example.com',
    });
    expect(options.siteAllowed()).toBe(true);
    expect(options.terminalToken).toBe(true);
    expect(options.actor).toMatchObject({ actor: 'system', actorLabel: 'payment-terminal' });
    expect(h.linkTerminalGuestSession).toHaveBeenCalledWith('ptx_1', 'gst_1', 2);
    expect(h.renderStationMessage).toHaveBeenCalledWith(
      'terminal_result',
      expect.objectContaining({ paymentApproved: true, plugInAnyConnector: false }),
    );
  });

  it('starts station-wide (EVSE 0) without card fields and says plug in any connector', async () => {
    h.claimTerminalStart.mockResolvedValue(
      txn({ cardLast4: null, cardBin: null, receiptEmail: null, evseNumber: 9 }),
    );
    queuePlace();
    h.startAdHocPayment.mockResolvedValue({ ok: true, guestSessionId: 'gst_2' });
    await flow.startChargingForTerminal(txn() as never, deps);
    expect(h.startAdHocPayment.mock.calls[0]![0]).toEqual({
      stationId: 'CS-1',
      evseId: 0,
      pspRef: 'ref_1',
      maxCostCents: 5000,
    });
    expect(h.renderStationMessage).toHaveBeenCalledWith(
      'terminal_result',
      expect.objectContaining({ plugInAnyConnector: true }),
    );
  });

  it('releases the hold and shows a decline when the start fails', async () => {
    h.claimTerminalStart.mockResolvedValue(txn());
    queuePlace();
    h.startAdHocPayment.mockResolvedValue({ ok: false, code: 'STATION_OFFLINE' });
    const out = await flow.startChargingForTerminal(txn() as never, deps);
    expect(out).toMatchObject({ kind: 'charging_not_started', code: 'STATION_OFFLINE' });
    expect(h.voidTerminalTransaction).toHaveBeenCalledWith(
      'ptx_1',
      'start_station_offline',
      deps.payments,
    );
    expect(h.linkTerminalGuestSession).not.toHaveBeenCalled();
    expect(h.renderStationMessage).toHaveBeenCalledWith(
      'terminal_result',
      expect.objectContaining({ paymentApproved: false }),
    );
  });
});

describe('handleTerminalResult(s)', () => {
  it('ignores a result without a transaction', async () => {
    await flow.handleTerminalResult({ transition: 'authorized', transaction: null } as never, deps);
    expect(h.claimTerminalStart).not.toHaveBeenCalled();
  });

  it('starts charging on an authorization', async () => {
    h.claimTerminalStart.mockResolvedValue(null);
    await flow.handleTerminalResult(
      { transition: 'authorized', transaction: txn() } as never,
      deps,
    );
    expect(h.claimTerminalStart).toHaveBeenCalledWith('ptx_1');
  });

  it('shows a decline or an expiry when the terminal is placed, else nothing', async () => {
    queuePlace();
    await flow.handleTerminalResult({ transition: 'declined', transaction: txn() } as never, deps);
    await flow.handleTerminalResult({ transition: 'expired', transaction: txn() } as never, deps);
    await flow.handleTerminalResult({ transition: 'captured', transaction: txn() } as never, deps);
    expect(h.renderStationMessage).toHaveBeenCalledTimes(1);
  });

  it('syncs the device of a known terminal and ignores an unknown one', async () => {
    const device = { providerDeviceId: 'sim_term_1', online: true, lastSeenAt: null };
    h.fake.queue('select:payment_terminals', [{ id: 'ptm_1' }]);
    await flow.handleTerminalResults(
      [
        { eventId: 'e1', applied: null, device },
        { eventId: 'e2', applied: null, device: { ...device, providerDeviceId: 'zzz' } },
      ] as never,
      'simulated',
      deps,
    );
    expect(h.syncPaymentTerminalDevice).toHaveBeenCalledTimes(1);
    expect(h.syncPaymentTerminalDevice).toHaveBeenCalledWith(
      'ptm_1',
      device,
      expect.objectContaining({
        actor: {
          audit: { actor: 'system', actorLabel: 'terminal-webhook:simulated' },
          userId: null,
        },
      }),
    );
  });

  it('keeps going after a failed event (fail-open per event)', async () => {
    h.claimTerminalStart.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(null);
    await flow.handleTerminalResults(
      [
        { eventId: 'e1', applied: { transition: 'authorized', transaction: txn() } },
        { eventId: 'e2', applied: { transition: 'authorized', transaction: txn({ id: 'ptx_2' }) } },
      ] as never,
      'simulated',
      deps,
    );
    expect(h.claimTerminalStart).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'e1' }),
      'Terminal event follow-up failed',
    );
  });
});

describe('pollTerminalDevices', () => {
  const now = new Date('2026-11-12T10:00:00Z');
  const pdeps = { ...deps, templatesDirs: ['/t'] };

  it('polls active cloud terminals, counts changes and errors, and stops at a rate limit', async () => {
    h.fake.queue('select:payment_terminals', [
      terminal({ id: 'a' }),
      terminal({ id: 'b', providerDeviceId: null }),
      terminal({ id: 'c', provider: 'ocpp' }),
      terminal({ id: 'd', provider: 'idtech' }),
      terminal({ id: 'e', provider: 'idtech' }),
      terminal({ id: 'f' }),
      terminal({ id: 'g' }),
    ]);
    const sim = displayProvider();
    sim.getDevice
      .mockResolvedValueOnce({ online: true, lastSeenAt: now, firmwareVersion: '1', iccid: '89' })
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('timeout'));
    const idtech = displayProvider();
    const limit = Object.assign(new Error('slow down'), { kind: 'rate_limited' });
    idtech.getDevice.mockRejectedValue(limit);
    h.getProvider.mockImplementation((id: string) =>
      Promise.resolve(id === 'idtech' ? idtech : sim),
    );
    h.syncPaymentTerminalDevice
      .mockResolvedValueOnce({ onlineChanged: true, online: true })
      .mockResolvedValueOnce(null);
    const out = await flow.pollTerminalDevices(pdeps, now);
    expect(out).toEqual({ polled: 2, changed: 1, errors: 2, alerted: 0 });
    // The second idtech terminal is skipped after the first rate limit.
    expect(idtech.getDevice).toHaveBeenCalledTimes(1);
    expect(h.syncPaymentTerminalDevice.mock.calls[0]).toEqual([
      'a',
      { online: true, lastSeenAt: now, firmwareVersion: '1', iccid: '89' },
      expect.objectContaining({
        actor: { audit: { actor: 'system', actorLabel: 'payment-terminal-status' }, userId: null },
      }),
      now,
    ]);
    expect(h.syncPaymentTerminalDevice.mock.calls[1]![1]).toEqual({
      online: false,
      lastSeenAt: null,
      firmwareVersion: null,
      iccid: null,
    });
    expect(h.offlineClaims[0]!['since']).toEqual(new Date(now.getTime() - 15 * 60_000));
  });

  it('skips providers that do not report device status', async () => {
    h.fake.queue('select:payment_terminals', [terminal()]);
    h.getProvider.mockResolvedValue({ capabilities: { deviceStatus: false } });
    expect(await flow.pollTerminalDevices(pdeps, now)).toEqual({
      polled: 0,
      changed: 0,
      errors: 0,
      alerted: 0,
    });
  });
});

describe('alertOfflineTerminals', () => {
  const adeps = { logger: deps.logger, templatesDirs: ['/t'] };

  it('notifies each permitted user of the terminal site with the terminal variables', async () => {
    setClaims([
      {
        id: 'ptm_1',
        siteId: 'sit_1',
        label: null,
        serialNumber: 'SN1',
        model: 'VP7200',
        offlineSince: new Date('2026-11-12T09:00:00Z'),
      },
    ]);
    h.fake.queue('client:FROM payment_terminals pt', [
      { station_ocpp_id: 'CS-1', site_name: 'Depot' },
    ]);
    h.fake.queue('client:FROM users u', [
      {
        id: 'usr_1',
        email: 'o@example.com',
        phone: null,
        first_name: 'Ola',
        last_name: null,
        language: 'de',
        timezone: 'Europe/Berlin',
      },
    ]);
    expect(await flow.alertOfflineTerminals(adeps)).toBe(1);
    expect(h.dispatchSystemNotification).toHaveBeenCalledWith(
      expect.anything(),
      flow.PAYMENT_TERMINAL_OFFLINE_EVENT,
      {
        email: 'o@example.com',
        phone: undefined,
        firstName: 'Ola',
        lastName: undefined,
        language: 'de',
        timezone: 'Europe/Berlin',
        userId: 'usr_1',
      },
      {
        terminalLabel: 'SN1',
        terminalModel: 'VP7200',
        stationId: 'CS-1',
        siteName: 'Depot',
        offlineSince: '2026-11-12T09:00:00.000Z',
        minutes: 15,
      },
      ['/t'],
    );
    const users = h.fake.find('client', 'FROM users u')[0]!;
    expect(users.params).toContain('sit_1');
  });

  it('uses fallbacks for an unplaced terminal and warns on a failed send', async () => {
    setClaims([
      {
        id: 'ptm_2',
        siteId: null,
        label: null,
        serialNumber: null,
        model: null,
        offlineSince: null,
      },
    ]);
    h.fake.queue('client:FROM users u', [
      {
        id: 'u',
        email: 'e',
        phone: '+1',
        first_name: null,
        last_name: 'L',
        language: 'en',
        timezone: 'UTC',
      },
    ]);
    h.dispatchSystemNotification.mockRejectedValue(new Error('smtp'));
    expect(await flow.alertOfflineTerminals(adeps)).toBe(1);
    expect(h.dispatchSystemNotification.mock.calls[0]![3]).toEqual({
      terminalLabel: 'ptm_2',
      terminalModel: '',
      stationId: '',
      siteName: '',
      offlineSince: '',
      minutes: 15,
    });
    expect(h.dispatchSystemNotification.mock.calls[0]![2]).toMatchObject({
      phone: '+1',
      lastName: 'L',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ paymentTerminalId: 'ptm_2' }),
      'Terminal offline alert not sent',
    );
  });
});

describe('reconcileTerminals and runTerminalEventJob', () => {
  it('finishes each settled session and keeps going after a failure', async () => {
    h.reconcileTerminalTransactions.mockResolvedValue({ settledSessionIds: ['ses_1', 'ses_2'] });
    h.handleGuestSessionEvent
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValueOnce(undefined);
    h.settleTerminalSession.mockResolvedValue({ kind: 'nothing' });
    const now = new Date('2026-11-12T10:00:00Z');
    const out = await flow.reconcileTerminals({ ...deps, templatesDirs: ['/t'] }, now);
    expect(out).toEqual({ settledSessionIds: ['ses_1', 'ses_2'] });
    expect(h.reconcileTerminalTransactions).toHaveBeenCalledWith(deps.payments, now);
    expect(h.handleGuestSessionEvent).toHaveBeenCalledWith(
      { type: 'TransactionEnded', sessionId: 'ses_2' },
      expect.objectContaining({ templatesDirs: ['/t'] }),
    );
    expect(h.settleTerminalSession).toHaveBeenCalledTimes(1);
    expect(h.settleTerminalSession.mock.calls[0]![0]).toBe('ses_2');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_1' }),
      'Terminal session finish after reconciliation failed',
    );
  });

  it('verifies a queued event like a webhook and acts on its results', async () => {
    h.ingestTerminalWebhook.mockResolvedValue({ applied: [] });
    await flow.runTerminalEventJob(
      { provider: 'simulated', rawBody: '{"a":1}', signature: 'sig' } as never,
      deps,
    );
    const [provider, body, headers] = h.ingestTerminalWebhook.mock.calls[0]! as [
      string,
      Buffer,
      unknown,
    ];
    expect(provider).toBe('simulated');
    expect(body.toString('utf8')).toBe('{"a":1}');
    expect(headers).toEqual({ 'x-evtivity-terminal-signature': 'sig' });
  });
});

describe('terminalReceiptUrl and finishTerminalSession', () => {
  it('links the guest session page by its CSMS token, without trailing slashes', async () => {
    h.fake.queue('select:guest_sessions', [{ token: 'a'.repeat(20) }]);
    expect(
      await flow.terminalReceiptUrl(
        { guestSessionId: 1, receiptUrl: 'https://psp/r' },
        'https://p//',
      ),
    ).toBe(`https://p/guest-session/${'a'.repeat(20)}`);
  });

  it('never links a token that is not a CSMS token, and falls back to the stored URL', async () => {
    h.fake.queue('select:guest_sessions', [{ token: 'ref_sequential_1' }]);
    expect(
      await flow.terminalReceiptUrl(
        { guestSessionId: 1, receiptUrl: 'https://psp/r' },
        'https://p',
      ),
    ).toBe('https://psp/r');
    expect(
      await flow.terminalReceiptUrl({ guestSessionId: 99, receiptUrl: null }, 'https://p'),
    ).toBeNull();
    expect(
      await flow.terminalReceiptUrl({ guestSessionId: null, receiptUrl: 'u' }, 'https://p'),
    ).toBe('u');
  });

  it('shows the receipt with the captured amount after a capture', async () => {
    h.settleTerminalSession.mockResolvedValue({
      kind: 'captured',
      capturedCents: 1234,
      transaction: txn({ guestSessionId: 'gst_1' }),
    });
    queuePlace();
    h.fake.queue('select:guest_sessions', [{ token: 'b'.repeat(20) }]);
    const out = await flow.finishTerminalSession('ses_1', deps);
    expect(out.kind).toBe('captured');
    expect(h.settleTerminalSession.mock.calls[0]![1]).toMatchObject({
      actor: { actor: 'system', actorLabel: 'terminal-settlement' },
    });
    expect(h.renderStationMessage).toHaveBeenCalledWith(
      'terminal_receipt',
      expect.objectContaining({
        terminalAmount: '$12.34',
        receiptUrl: `https://portal.example/guest-session/${'b'.repeat(20)}`,
      }),
    );
  });

  it('shows no receipt without a link or a placed terminal, and none for other outcomes', async () => {
    h.settleTerminalSession.mockResolvedValue({
      kind: 'captured',
      capturedCents: 1,
      transaction: txn(),
    });
    queuePlace();
    await flow.finishTerminalSession('ses_1', deps);
    expect(h.renderStationMessage.mock.calls[0]![1]).not.toHaveProperty('receiptUrl');
    h.renderStationMessage.mockClear();
    await flow.finishTerminalSession('ses_1', deps);
    expect(h.renderStationMessage).not.toHaveBeenCalled();
    h.settleTerminalSession.mockResolvedValue({ kind: 'voided' });
    expect((await flow.finishTerminalSession('ses_1', deps)).kind).toBe('voided');
  });
});
