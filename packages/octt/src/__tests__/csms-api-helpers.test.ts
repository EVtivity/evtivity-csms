// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import pino from 'pino';
import { WebSocketServer } from 'ws';
import type { TestContext } from '../types.js';
import {
  newTestPassword,
  reconnectWith,
  tryConnect,
  waitForOnline,
  signPendingCsr,
  waitFor,
  isPasswordString,
} from '../security-test-helpers.js';
import { newPspRef, requestAdHocPayment, setTokenCostLimit } from '../payment-test-helpers.js';
import {
  FIRMWARE_LOCATION,
  sendSecureFirmwareUpdate,
  signedFirmwareStep,
  futureFirmwareDateStep,
} from '../firmware-test-helpers.js';
import { FIRMWARE_SIGNATURE, FIRMWARE_SIGNING_CERTIFICATE } from '../firmware-fixtures.js';
import {
  enterEvConnectedPreSession,
  pushOcspRequestSteps,
  skippedWithoutOcsp,
} from '../ocsp-test-helpers.js';
import type { OcspTestService } from '../ocsp-test-service.js';
import { callPncApi } from '../pnc-api.js';
import {
  captureWebPayments,
  enableDynamicQr,
  visitQrUrl,
  runInvalidQrTest,
} from '../qr-test-helpers.js';
import type { StepResult } from '../types.js';

type Reply = { status: number; body: Record<string, unknown> };
type Handler = (method: string, path: string, body?: Record<string, unknown>) => Reply;

function makeCtx(
  handler: Handler | null,
  extra: Partial<TestContext> = {},
): { ctx: TestContext; callApi: ReturnType<typeof vi.fn> } {
  const callApi = vi.fn((method: string, path: string, body?: Record<string, unknown>) =>
    Promise.resolve(handler?.(method, path, body) ?? { status: 200, body: {} }),
  );
  return {
    callApi,
    ctx: {
      client: {} as TestContext['client'],
      stationId: 'OCTT-TEST-1',
      tokens: {} as TestContext['tokens'],
      stationDbId: 'sta_1',
      logger: pino({ level: 'silent' }),
      config: { serverUrl: 'ws://localhost:7103' },
      ...(handler != null ? { callApi: callApi } : {}),
      ...extra,
    },
  };
}

const online: Handler = (method, path) =>
  method === 'GET' && path === '/stations/sta_1'
    ? { status: 200, body: { isOnline: true } }
    : {
        status: 200,
        body: {},
      };

afterEach(() => {
  vi.useRealTimers();
});

describe('security test helpers', () => {
  it('newTestPassword makes passwordStrings of the requested length', () => {
    const a = newTestPassword();
    expect(a).toHaveLength(20);
    expect(a.startsWith('OCTT')).toBe(true);
    expect(isPasswordString(a)).toBe(true);
    expect(newTestPassword(40)).toHaveLength(40);
    expect(newTestPassword()).not.toBe(a);
  });

  it('isPasswordString accepts the OCPP characters only', () => {
    expect(isPasswordString('aZ09*-_=:+|@.')).toBe(true);
    expect(isPasswordString('with space')).toBe(false);
    expect(isPasswordString('')).toBe(false);
    expect(isPasswordString('a/b')).toBe(false);
  });

  it('waitForOnline polls the station until it is online', async () => {
    vi.useFakeTimers();
    let polls = 0;
    const { ctx, callApi } = makeCtx(() => ({
      status: 200,
      body: { isOnline: ++polls >= 3 },
    }));
    const wait = waitForOnline(ctx, 5000);
    await vi.advanceTimersByTimeAsync(600);
    await expect(wait).resolves.toBe(true);
    expect(callApi).toHaveBeenCalledTimes(3);
    expect(callApi).toHaveBeenCalledWith('GET', '/stations/sta_1');
  });

  it('waitForOnline gives up after the timeout, and without the API', async () => {
    vi.useFakeTimers();
    const { ctx } = makeCtx(() => ({ status: 200, body: { isOnline: false } }));
    const wait = waitForOnline(ctx, 1000);
    await vi.advanceTimersByTimeAsync(1500);
    await expect(wait).resolves.toBe(false);
    await expect(waitForOnline(makeCtx(null).ctx)).resolves.toBe(false);
    await expect(waitForOnline(makeCtx(online, { stationDbId: null }).ctx)).resolves.toBe(false);
  });

  it('signPendingCsr signs the pending CSR of the station', async () => {
    const { ctx, callApi } = makeCtx((method, path) => {
      if (method === 'GET') return { status: 200, body: { data: [{ id: 12 }] } };
      return path === '/pnc/csr-requests/12/sign'
        ? { status: 200, body: {} }
        : { status: 404, body: {} };
    });
    await expect(signPendingCsr(ctx, 'CHAIN')).resolves.toBeNull();
    expect(callApi).toHaveBeenNthCalledWith(
      1,
      'GET',
      '/pnc/csr-requests?stationId=sta_1&status=pending&limit=1',
    );
    expect(callApi).toHaveBeenNthCalledWith(2, 'POST', '/pnc/csr-requests/12/sign', {
      signedCertificateChain: 'CHAIN',
    });
  });

  it('signPendingCsr reports a missing CSR, a failed sign and a missing API', async () => {
    await expect(
      signPendingCsr(makeCtx(() => ({ status: 200, body: { data: [] } })).ctx, 'C'),
    ).resolves.toBe('No pending CSR (HTTP 200)');
    await expect(signPendingCsr(makeCtx(() => ({ status: 500, body: {} })).ctx, 'C')).resolves.toBe(
      'No pending CSR (HTTP 500)',
    );
    await expect(
      signPendingCsr(
        makeCtx((m) =>
          m === 'GET' ? { status: 200, body: { data: [{ id: 'x' }] } } : { status: 409, body: {} },
        ).ctx,
        'C',
      ),
    ).resolves.toBe('Sign failed: HTTP 409');
    await expect(signPendingCsr(makeCtx(null).ctx, 'C')).resolves.toBe('API client not available');
  });

  it('waitFor polls until the condition holds or the timeout passes', async () => {
    vi.useFakeTimers();
    let flag = false;
    const wait = waitFor(() => flag, 1000);
    await vi.advanceTimersByTimeAsync(300);
    flag = true;
    await vi.advanceTimersByTimeAsync(100);
    await expect(wait).resolves.toBe(true);

    const never = waitFor(() => false, 500);
    await vi.advanceTimersByTimeAsync(600);
    await expect(never).resolves.toBe(false);
  });

  it('reconnectWith updates the client and resolves when it connects again', async () => {
    let onConnected: (() => void) | null = null;
    const client = {
      setDisconnectedHandler: vi.fn(),
      setConnectedHandler: vi.fn((fn: () => void) => {
        onConnected = fn;
      }),
      updateConnection: vi.fn(),
      simulateConnectionLoss: vi.fn(() => {
        onConnected?.();
      }),
    };
    const { ctx } = makeCtx(null, { client: client as unknown as TestContext['client'] });
    await expect(reconnectWith(ctx, { password: 'p', securityProfile: 1 })).resolves.toBe(true);
    expect(client.updateConnection).toHaveBeenCalledWith({ password: 'p', securityProfile: 1 });
  });

  it('reconnectWith resolves false when the client never reconnects', async () => {
    vi.useFakeTimers();
    const client = {
      setDisconnectedHandler: vi.fn(),
      setConnectedHandler: vi.fn(),
      updateConnection: vi.fn(),
      simulateConnectionLoss: vi.fn(),
    };
    const { ctx } = makeCtx(null, { client: client as unknown as TestContext['client'] });
    const wait = reconnectWith(ctx, {}, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(wait).resolves.toBe(false);
  });

  describe('tryConnect', () => {
    let wss: WebSocketServer | null = null;
    afterEach(async () => {
      await new Promise((resolve) => wss?.close(resolve) ?? resolve(undefined));
      wss = null;
    });

    async function startServer(password: string): Promise<string> {
      const expected = 'Basic ' + Buffer.from(`OCTT-TEST-1:${password}`).toString('base64');
      wss = new WebSocketServer({
        port: 0,
        host: '127.0.0.1',
        handleProtocols: () => 'ocpp2.1',
        verifyClient: (info, done) => {
          if (info.req.headers['authorization'] === expected) done(true);
          else done(false, 401);
        },
      });
      await new Promise((resolve) => wss?.once('listening', resolve));
      const addr = wss.address() as { port: number };
      return `ws://127.0.0.1:${String(addr.port)}`;
    }

    const client = { protocol: 'ocpp2.1' } as unknown as TestContext['client'];

    it('reports 101 for accepted credentials and the HTTP status otherwise', async () => {
      const url = await startServer('right-password');
      const { ctx } = makeCtx(null, { client });
      await expect(tryConnect(ctx, { serverUrl: url, password: 'right-password' })).resolves.toBe(
        101,
      );
      await expect(tryConnect(ctx, { serverUrl: url, password: 'wrong' })).resolves.toBe(401);
      await expect(tryConnect(ctx, { serverUrl: url })).resolves.toBe(401);
    });

    it('reports 0 when no server listens', async () => {
      const url = await startServer('x');
      const addr = url;
      await new Promise((resolve) => wss?.close(resolve));
      wss = null;
      const { ctx } = makeCtx(null, {
        client,
        config: { serverUrl: addr, tlsCaCert: 'unused' },
      });
      await expect(tryConnect(ctx, { serverUrl: addr })).resolves.toBe(0);
    });
  });
});

describe('payment test helpers', () => {
  it('newPspRef makes unique uppercase references', () => {
    const ref = newPspRef();
    expect(ref).toMatch(/^OCTT-PSP-[0-9A-F]{12}$/);
    expect(newPspRef()).not.toBe(ref);
  });

  it('requestAdHocPayment retries while the EVSE is not known yet', async () => {
    vi.useFakeTimers();
    let posts = 0;
    const { ctx, callApi } = makeCtx((method, path) => {
      if (method === 'GET') return online(method, path);
      return ++posts < 3
        ? { status: 404, body: { code: 'EVSE_NOT_FOUND' } }
        : { status: 200, body: {} };
    });
    const req = requestAdHocPayment(ctx, { pspRef: 'P1', evseId: 1, maxCostCents: 500 });
    await vi.advanceTimersByTimeAsync(600);
    await expect(req).resolves.toBeNull();
    expect(callApi).toHaveBeenLastCalledWith('POST', '/ad-hoc-payments', {
      stationId: 'OCTT-TEST-1',
      pspRef: 'P1',
      evseId: 1,
      maxCostCents: 500,
    });
    expect(posts).toBe(3);
  });

  it('requestAdHocPayment reports other errors at once', async () => {
    const { ctx } = makeCtx((method, path) =>
      method === 'GET' ? online(method, path) : { status: 402, body: { code: 'DECLINED' } },
    );
    await expect(requestAdHocPayment(ctx, { pspRef: 'P', evseId: 1 })).resolves.toBe(
      'HTTP 402 DECLINED',
    );
    const noCode = makeCtx((method, path) =>
      method === 'GET' ? online(method, path) : { status: 500, body: {} },
    );
    await expect(requestAdHocPayment(noCode.ctx, { pspRef: 'P', evseId: 1 })).resolves.toBe(
      'HTTP 500 ',
    );
  });

  it('requestAdHocPayment stops retrying at the deadline', async () => {
    vi.useFakeTimers();
    const { ctx } = makeCtx((method, path) =>
      method === 'GET' ? online(method, path) : { status: 404, body: { code: 'EVSE_NOT_FOUND' } },
    );
    const req = requestAdHocPayment(ctx, { pspRef: 'P', evseId: 9 }, 1000);
    await vi.advanceTimersByTimeAsync(1500);
    await expect(req).resolves.toBe('HTTP 404 EVSE_NOT_FOUND');
  });

  it('requestAdHocPayment needs the API and an online station', async () => {
    await expect(requestAdHocPayment(makeCtx(null).ctx, { pspRef: 'P', evseId: 1 })).resolves.toBe(
      'API client not available',
    );
    vi.useFakeTimers();
    const offline = makeCtx(() => ({ status: 200, body: { isOnline: false } }));
    const req = requestAdHocPayment(offline.ctx, { pspRef: 'P', evseId: 1 }, 2000);
    await vi.advanceTimersByTimeAsync(2500);
    await expect(req).resolves.toBe('Station not online in the CSMS within 2 s');
  });

  it('setTokenCostLimit sets the prepaid balance of the matching token', async () => {
    const { ctx, callApi } = makeCtx((method) =>
      method === 'GET'
        ? {
            status: 200,
            body: {
              data: [
                { id: 'tok_other', idToken: 'TOKEN-10' },
                { id: 'tok_1', idToken: 'TOKEN-1' },
              ],
            },
          }
        : { status: 200, body: {} },
    );
    await expect(setTokenCostLimit(ctx, 'TOKEN-1', 250)).resolves.toBeNull();
    expect(callApi).toHaveBeenNthCalledWith(1, 'GET', '/tokens?search=TOKEN-1&limit=10');
    expect(callApi).toHaveBeenNthCalledWith(2, 'PATCH', '/tokens/tok_1', {
      prepaidBalanceCents: 250,
    });
  });

  it('setTokenCostLimit reports lookup and update failures', async () => {
    await expect(setTokenCostLimit(makeCtx(null).ctx, 'T', 1)).resolves.toBe(
      'API client not available',
    );
    await expect(
      setTokenCostLimit(makeCtx(() => ({ status: 500, body: {} })).ctx, 'T', 1),
    ).resolves.toBe('Token lookup HTTP 500');
    await expect(
      setTokenCostLimit(makeCtx(() => ({ status: 200, body: {} })).ctx, 'T', 1),
    ).resolves.toBe('Token T not found');
    await expect(
      setTokenCostLimit(
        makeCtx((m) =>
          m === 'GET'
            ? { status: 200, body: { data: [{ id: 't', idToken: 'T' }] } }
            : { status: 400, body: {} },
        ).ctx,
        'T',
        1,
      ),
    ).resolves.toBe('Token update HTTP 400');
  });
});

describe('firmware test helpers', () => {
  it('sendSecureFirmwareUpdate posts the configured signing material', async () => {
    const { ctx, callApi } = makeCtx(online);
    await sendSecureFirmwareUpdate(ctx, {
      requestId: 7,
      retrieveDateTime: '2030-01-01T00:00:00.000Z',
      installDateTime: '2030-01-02T00:00:00.000Z',
    });
    expect(callApi).toHaveBeenLastCalledWith('POST', '/ocpp/commands/v21/UpdateFirmware', {
      stationId: 'OCTT-TEST-1',
      requestId: 7,
      firmware: {
        location: FIRMWARE_LOCATION,
        retrieveDateTime: '2030-01-01T00:00:00.000Z',
        installDateTime: '2030-01-02T00:00:00.000Z',
        signingCertificate: FIRMWARE_SIGNING_CERTIFICATE,
        signature: FIRMWARE_SIGNATURE,
      },
    });
  });

  it('sendSecureFirmwareUpdate accepts a station rejection (502) and throws on other errors', async () => {
    const reply = (status: number, body: Record<string, unknown> = {}): Handler => {
      return (method, path) => (method === 'GET' ? online(method, path) : { status, body });
    };
    await expect(sendSecureFirmwareUpdate(makeCtx(reply(502)).ctx)).resolves.toBeUndefined();
    await expect(sendSecureFirmwareUpdate(makeCtx(reply(202)).ctx)).resolves.toBeUndefined();
    await expect(
      sendSecureFirmwareUpdate(makeCtx(reply(400, { code: 'INVALID' })).ctx),
    ).rejects.toThrow('UpdateFirmware route returned HTTP 400 INVALID');
    await expect(sendSecureFirmwareUpdate(makeCtx(reply(500)).ctx)).rejects.toThrow(
      'UpdateFirmware route returned HTTP 500',
    );
    await expect(sendSecureFirmwareUpdate(makeCtx(null).ctx)).rejects.toThrow(
      'API client not available',
    );
  });

  it('sendSecureFirmwareUpdate throws when the station is not online', async () => {
    vi.useFakeTimers();
    const req = sendSecureFirmwareUpdate(
      makeCtx(() => ({ status: 200, body: { isOnline: false } })).ctx,
    );
    const check = expect(req).rejects.toThrow('Station not online in the CSMS');
    await vi.advanceTimersByTimeAsync(10_500);
    await check;
  });

  it('signedFirmwareStep checks the signing certificate and signature', () => {
    const ok = signedFirmwareStep(3, {
      firmware: { signingCertificate: FIRMWARE_SIGNING_CERTIFICATE, signature: FIRMWARE_SIGNATURE },
    });
    expect(ok).toMatchObject({
      step: 3,
      status: 'passed',
      actual: 'signingCertificate matches, signature matches',
    });
    const bad = signedFirmwareStep(3, { firmware: { signature: FIRMWARE_SIGNATURE } });
    expect(bad).toMatchObject({
      status: 'failed',
      actual: 'signingCertificate does not match, signature matches',
    });
    expect(signedFirmwareStep(1, null).status).toBe('failed');
  });

  it('futureFirmwareDateStep needs a dateTime after the send time', () => {
    const sentAt = Date.parse('2030-01-01T00:00:00Z');
    const payload = (v: unknown): Record<string, unknown> => ({ firmware: { installDateTime: v } });
    expect(
      futureFirmwareDateStep(2, payload('2030-01-01T00:00:01Z'), 'installDateTime', sentAt).status,
    ).toBe('passed');
    expect(
      futureFirmwareDateStep(2, payload('2030-01-01T00:00:00Z'), 'installDateTime', sentAt).status,
    ).toBe('failed');
    const missing = futureFirmwareDateStep(2, null, 'retrieveDateTime', sentAt);
    expect(missing).toMatchObject({
      status: 'failed',
      actual: 'firmware.retrieveDateTime = undefined',
    });
    expect(futureFirmwareDateStep(2, payload(123), 'installDateTime', sentAt).status).toBe(
      'failed',
    );
  });
});

describe('OCSP test helpers', () => {
  it('enterEvConnectedPreSession plugs in and starts a transaction on EVConnected', async () => {
    const sendCall = vi.fn(() => Promise.resolve({}));
    const { ctx } = makeCtx(null, { client: { sendCall } as unknown as TestContext['client'] });
    const txId = await enterEvConnectedPreSession(ctx);
    expect(txId).toMatch(/^OCTT-TX-\d+$/);
    expect(sendCall).toHaveBeenNthCalledWith(
      1,
      'StatusNotification',
      expect.objectContaining({ connectorStatus: 'Occupied', evseId: 1, connectorId: 1 }),
    );
    expect(sendCall).toHaveBeenNthCalledWith(
      2,
      'TransactionEvent',
      expect.objectContaining({
        eventType: 'Started',
        triggerReason: 'CablePluggedIn',
        seqNo: 0,
        transactionInfo: { transactionId: txId, chargingState: 'EVConnected' },
      }),
    );
  });

  function ocspWith(requests: Array<{ status: string }>): OcspTestService {
    return {
      responder: { requestsFor: vi.fn(() => requests) },
    } as unknown as OcspTestService;
  }

  it('pushOcspRequestSteps passes when a request was answered with the expected status', () => {
    const steps: StepResult[] = [];
    const ocsp = ocspWith([{ status: 'unknown' }, { status: 'revoked' }]);
    pushOcspRequestSteps(steps, ocsp, 'ab12', 'revoked');
    expect(ocsp.responder.requestsFor).toHaveBeenCalledWith('ab12');
    expect(steps).toMatchObject([
      { step: 2, status: 'passed', actual: '2 request(s) received' },
      { step: 3, status: 'passed', actual: 'unknown, revoked' },
    ]);
  });

  it('pushOcspRequestSteps fails without a request', () => {
    const steps: StepResult[] = [];
    pushOcspRequestSteps(steps, ocspWith([]), 'ab12', 'good');
    expect(steps[0]?.status).toBe('failed');
    expect(steps[0]?.actual).toContain('No OCSP request received');
    expect(steps[1]).toMatchObject({ status: 'failed', actual: 'none' });
  });

  it('skippedWithoutOcsp reports a skipped test', () => {
    expect(skippedWithoutOcsp()).toMatchObject({
      status: 'skipped',
      steps: [{ step: 1, status: 'skipped', actual: 'No OCSP responder configured' }],
    });
  });
});

describe('callPncApi', () => {
  it('returns the first answer that is not PNC_DISABLED', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const callApi = vi.fn(() =>
      Promise.resolve(
        ++calls < 3
          ? { status: 409, body: { code: 'PNC_DISABLED' } }
          : { status: 201, body: { id: 1 } },
      ),
    );
    const res = callPncApi(callApi, 'POST', '/pnc/x', { a: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(res).resolves.toEqual({ status: 201, body: { id: 1 } });
    expect(callApi).toHaveBeenCalledWith('POST', '/pnc/x', { a: 1 });
    expect(callApi).toHaveBeenCalledTimes(3);
  });

  it('gives up retrying PNC_DISABLED after 70 s', async () => {
    vi.useFakeTimers();
    const callApi = vi.fn(() => Promise.resolve({ status: 409, body: { code: 'PNC_DISABLED' } }));
    const res = callPncApi(callApi, 'GET', '/pnc/y');
    await vi.advanceTimersByTimeAsync(80_000);
    await expect(res).resolves.toEqual({ status: 409, body: { code: 'PNC_DISABLED' } });
    expect(callApi.mock.calls.length).toBeGreaterThanOrEqual(15);
  });
});

describe('dynamic QR helpers', () => {
  const qrHandler =
    (capture: ReturnType<typeof captureWebPayments>, putStatus = 200, setValues = true): Handler =>
    (method, path, body) => {
      if (method === 'GET' && path === '/stations/sta_1') return online(method, path);
      if (method === 'GET' && path === '/stations/sta_1/connectors') {
        return { status: 200, body: [{ evseId: 1 }] as unknown as Record<string, unknown> };
      }
      if (method === 'PUT') {
        expect(path).toBe('/stations/sta_1/web-payments');
        expect(body).toEqual({ validitySeconds: 60, totpLength: 8 });
        if (setValues) {
          capture.handle('SetVariables', {
            setVariableData: [
              ['SharedSecret', 's3cret'],
              ['URLTemplate', 'http://portal/qr/{chargingstationid}/{evse}/{totp}/{version}'],
              ['ValidityTime', '60'],
              ['Length', '8'],
            ].map(([name, value]) => ({
              component: { name: 'WebPaymentsCtrlr' },
              variable: { name },
              attributeValue: value,
            })),
          });
        }
        return { status: putStatus, body: putStatus === 200 ? {} : { code: 'OFFLINE' } };
      }
      if (method === 'POST' && path === '/portal/guest/qr/validate') {
        return { status: 200, body: { valid: false, reason: 'invalid_totp' } };
      }
      return { status: 404, body: {} };
    };

  it('enableDynamicQr has the CSMS configure the station', async () => {
    const capture = captureWebPayments();
    const { ctx } = makeCtx(qrHandler(capture));
    await expect(enableDynamicQr(ctx, capture)).resolves.toBeNull();
    expect(capture.values['SharedSecret']).toBe('s3cret');
  });

  it('enableDynamicQr reports a refused route and missing values', async () => {
    const c1 = captureWebPayments();
    await expect(enableDynamicQr(makeCtx(qrHandler(c1, 409)).ctx, c1)).resolves.toBe(
      'HTTP 409 OFFLINE',
    );
    const c2 = captureWebPayments();
    await expect(enableDynamicQr(makeCtx(qrHandler(c2, 200, false)).ctx, c2)).resolves.toBe(
      'WebPaymentsCtrlr SharedSecret or URLTemplate not set',
    );
    await expect(enableDynamicQr(makeCtx(null).ctx, c2)).resolves.toBe('API client not available');
  });

  it('enableDynamicQr reports a station that never came online', async () => {
    vi.useFakeTimers();
    const capture = captureWebPayments();
    const req = enableDynamicQr(
      makeCtx(() => ({ status: 200, body: { isOnline: false } })).ctx,
      capture,
    );
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(req).resolves.toBe('Station not online in the CSMS within 30 s');
  });

  it('visitQrUrl returns the CSMS verdict or the HTTP error', async () => {
    const capture = captureWebPayments();
    await expect(visitQrUrl(makeCtx(qrHandler(capture)).ctx, 'http://x')).resolves.toEqual({
      valid: false,
      reason: 'invalid_totp',
    });
    await expect(
      visitQrUrl(makeCtx(() => ({ status: 500, body: {} })).ctx, 'http://x'),
    ).resolves.toBe('HTTP 500');
    await expect(visitQrUrl(makeCtx(null).ctx, 'http://x')).resolves.toBe(
      'API client not available',
    );
  });

  function qrClient(): {
    client: TestContext['client'];
    incoming: () => (id: string, action: string, payload: Record<string, unknown>) => unknown;
  } {
    let handler:
      | ((id: string, action: string, payload: Record<string, unknown>) => unknown)
      | null = null;
    const client = {
      sendCall: vi.fn((action: string) =>
        Promise.resolve(action === 'BootNotification' ? { status: 'Accepted' } : {}),
      ),
      setIncomingCallHandler: vi.fn((fn: typeof handler) => {
        handler = fn;
      }),
    };
    return {
      client: client as unknown as TestContext['client'],
      incoming: () => handler as NonNullable<typeof handler>,
    };
  }

  it('runInvalidQrTest passes when the CSMS refuses the URL and sends no start', async () => {
    vi.useFakeTimers();
    const { client, incoming } = qrClient();
    const capture = captureWebPayments();
    // The station-side capture in the test is the one the helper creates: route
    // the PUT through the incoming call handler as the CSMS would.
    const handler: Handler = (method, path, body) => {
      if (method === 'PUT') {
        void incoming()('m1', 'SetVariables', {
          setVariableData: [
            ['SharedSecret', 's3cret'],
            ['URLTemplate', 'http://portal/qr/{chargingstationid}/{evse}/{totp}/{version}'],
          ].map(([name, value]) => ({
            component: { name: 'WebPaymentsCtrlr' },
            variable: { name },
            attributeValue: value,
          })),
        });
        return { status: 200, body: {} };
      }
      return qrHandler(capture)(method, path, body);
    };
    const { ctx, callApi } = makeCtx(handler, { client });
    const run = runInvalidQrTest(ctx, 'wrong TOTP', (values) => ({
      chargingStationId: ctx.stationId,
      evseId: 1,
      totp: `X${String(values['SharedSecret'])}`,
      version: 'v1',
    }));
    await vi.advanceTimersByTimeAsync(6000);
    const result = await run;
    expect(result.status).toBe('passed');
    expect(result.steps.map((s) => s.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(callApi).toHaveBeenCalledWith('POST', '/portal/guest/qr/validate', {
      url: 'http://portal/qr/OCTT-TEST-1/1/Xs3cret/v1',
    });
    // Other incoming calls get the default 2.1 reply.
    await expect(incoming()('m2', 'UnknownAction', {})).rejects.toThrow('NotImplemented');
  });

  it('runInvalidQrTest fails when the CSMS sends RequestStartTransaction', async () => {
    vi.useFakeTimers();
    const { client, incoming } = qrClient();
    const capture = captureWebPayments();
    const handler: Handler = (method, path, body) => {
      if (method === 'PUT') {
        void incoming()('m1', 'SetVariables', {
          setVariableData: [
            ['SharedSecret', 's'],
            ['URLTemplate', 'http://portal/{evse}/{totp}/{version}'],
          ].map(([name, value]) => ({
            component: { name: 'WebPaymentsCtrlr' },
            variable: { name },
            attributeValue: value,
          })),
        });
        return { status: 200, body: {} };
      }
      if (method === 'POST' && path === '/portal/guest/qr/validate') {
        void incoming()('m3', 'RequestStartTransaction', {});
        return { status: 200, body: { valid: true } };
      }
      return qrHandler(capture)(method, path, body);
    };
    const { ctx } = makeCtx(handler, { client });
    const run = runInvalidQrTest(ctx, 'old TOTP', () => ({ evseId: 1, totp: 't', version: 'v1' }));
    await vi.advanceTimersByTimeAsync(6000);
    const result = await run;
    expect(result.status).toBe('failed');
    expect(result.steps[2]?.status).toBe('failed');
    expect(result.steps[3]).toMatchObject({
      status: 'failed',
      actual: 'RequestStartTransaction received',
    });
  });

  it('runInvalidQrTest stops when the CSMS cannot configure the QR code', async () => {
    const { client } = qrClient();
    const { ctx } = makeCtx(
      (method, path) =>
        method === 'GET' ? online(method, path) : { status: 503, body: { code: 'OFFLINE' } },
      { client },
    );
    const result = await runInvalidQrTest(ctx, 'x', () => ({ evseId: 1, totp: 't', version: 'v' }));
    expect(result.status).toBe('failed');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1]).toMatchObject({ status: 'failed', actual: 'HTTP 503 OFFLINE' });
  });

  it('runInvalidQrTest stops when the CSMS never lists EVSE 1', async () => {
    vi.useFakeTimers();
    const { client, incoming } = qrClient();
    const handler: Handler = (method, path) => {
      if (method === 'GET' && path === '/stations/sta_1') return online(method, path);
      if (method === 'GET') return { status: 200, body: [] as unknown as Record<string, unknown> };
      void incoming()('m1', 'SetVariables', {
        setVariableData: [
          ['SharedSecret', 's'],
          ['URLTemplate', 'u'],
        ].map(([name, value]) => ({
          component: { name: 'WebPaymentsCtrlr' },
          variable: { name },
          attributeValue: value,
        })),
      });
      return { status: 200, body: {} };
    };
    const { ctx } = makeCtx(handler, { client });
    const run = runInvalidQrTest(ctx, 'x', () => ({ evseId: 1, totp: 't', version: 'v' }));
    await vi.advanceTimersByTimeAsync(31_000);
    const result = await run;
    expect(result.status).toBe('failed');
    expect(result.steps[2]).toMatchObject({
      step: 3,
      status: 'failed',
      expected: 'EVSE 1 known to the CSMS',
    });
    expect(result.steps[2]?.actual).toContain('EVSE 1 not known to the CSMS within 30 s');
  });
});
