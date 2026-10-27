// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Real log and diagnostics uploads of the simulator (GetLog N01, 1.6 GetDiagnostics) to
// in-process FTP, SFTP and HTTP servers, and the file transfer protocols it reports.

import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSS_FILE_TRANSFER_PROTOCOLS_16, CSS_FILE_TRANSFER_PROTOCOLS_2X } from '@evtivity/lib';
import { makeHarness, priv, silenceConsole, type Harness } from './sim-harness.js';
import { startFtpServer, startSftpServer, type TestFileServer } from './file-transfer-servers.js';

const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  silenceConsole();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0)) await close();
});

function track(server: TestFileServer): TestFileServer {
  cleanups.push(() => server.close());
  return server;
}

async function httpServer(statuses: number[]): Promise<{ base: string; hits: () => number }> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const status = statuses[Math.min(hits, statuses.length - 1)] ?? 200;
      hits++;
      if (status === 0) return; // never answers
      res.writeHead(status, status === 302 ? { location: 'http://127.0.0.1:1/x' } : {});
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    hits: () => hits,
  };
}

async function settled(h: Harness, action: string, done: string[]): Promise<void> {
  await vi.waitFor(
    () => {
      const last = h.sent(action).at(-1);
      expect(done).toContain(last?.['status']);
    },
    { timeout: 10_000, interval: 20 },
  );
}

function statuses(h: Harness, action: string): unknown[] {
  return h.sent(action).map((m) => m['status']);
}

describe('GetLog (OCPP 2.1 N01) uploads the log file', () => {
  it('uploads to FTP with the file name it answered, then reports Uploaded', async () => {
    const ftp = track(await startFtpServer({ user: 'evtivity', password: 'evtivity' }));
    const h = await makeHarness();
    const res = await h.invoke('GetLog', {
      requestId: 11,
      logType: 'DiagnosticsLog',
      log: { remoteLocation: `ftp://evtivity:evtivity@127.0.0.1:${String(ftp.port)}/logs/` },
    });
    expect(res['status']).toBe('Accepted');
    await settled(h, 'LogStatusNotification', ['Uploaded', 'UploadFailure']);
    expect(h.sent('LogStatusNotification')).toEqual([
      { status: 'Uploading', requestId: 11 },
      { status: 'Uploaded', requestId: 11 },
    ]);
    const file = ftp.files.get(`logs/${String(res['filename'])}`);
    expect(file?.toString()).toContain('station: TEST-SIM');
    expect(file?.toString()).toContain('requestId: 11');
    expect(priv(h, 'logUploadStatus')).toBe('Idle');
    expect(priv(h, 'activeLogUploadRequestId')).toBeNull();
  });

  it('reports UploadFailure with reasonCode PermissionDenied for a wrong password', async () => {
    const sftp = track(await startSftpServer({ user: 'evtivity', password: 'evtivity' }));
    const h = await makeHarness({ config: { sftpHostKeySha256: String(sftp.hostKeySha256) } });
    await h.invoke('GetLog', {
      requestId: 12,
      logType: 'SecurityLog',
      log: { remoteLocation: `sftp://evtivity:wrong@127.0.0.1:${String(sftp.port)}/upload/` },
    });
    await settled(h, 'LogStatusNotification', ['Uploaded', 'UploadFailure']);
    expect(h.sent('LogStatusNotification').at(-1)).toEqual({
      status: 'UploadFailure',
      requestId: 12,
      statusInfo: { reasonCode: 'PermissionDenied' },
    });
    expect(sftp.files.size).toBe(0);
  });

  it('fails closed with UntrustedHostKey for an SFTP server whose host key is not trusted', async () => {
    const sftp = track(await startSftpServer({ user: 'evtivity', password: 'evtivity' }));
    const h = await makeHarness({ config: { sftpHostKeySha256: 'SHA256:not-this-key' } });
    await h.invoke('GetLog', {
      requestId: 16,
      logType: 'DiagnosticsLog',
      log: { remoteLocation: `sftp://evtivity:evtivity@127.0.0.1:${String(sftp.port)}/upload/` },
    });
    await settled(h, 'LogStatusNotification', ['Uploaded', 'UploadFailure']);
    expect(h.sent('LogStatusNotification').at(-1)).toMatchObject({
      status: 'UploadFailure',
      statusInfo: { reasonCode: 'UntrustedHostKey' },
    });
    expect(sftp.files.size).toBe(0);
  });

  it('accepts the SFTP host key when the station does not verify servers', async () => {
    const sftp = track(await startSftpServer({ user: 'evtivity', password: 'evtivity' }));
    const h = await makeHarness({ config: { verifyServerCertificate: false } });
    await h.invoke('GetLog', {
      requestId: 17,
      logType: 'DiagnosticsLog',
      log: { remoteLocation: `sftp://evtivity:evtivity@127.0.0.1:${String(sftp.port)}/upload/` },
    });
    await settled(h, 'LogStatusNotification', ['Uploaded', 'UploadFailure']);
    expect(statuses(h, 'LogStatusNotification')).toEqual(['Uploading', 'Uploaded']);
  });

  it('reports UploadFailure with reasonCode RedirectNotAllowed for a redirect (N01.FR.30)', async () => {
    const { base, hits } = await httpServer([302]);
    const h = await makeHarness();
    await h.invoke('GetLog', {
      requestId: 13,
      logType: 'DiagnosticsLog',
      log: { remoteLocation: `${base}/redirect` },
      retries: 3,
    });
    await settled(h, 'LogStatusNotification', ['Uploaded', 'UploadFailure']);
    expect(h.sent('LogStatusNotification').at(-1)).toMatchObject({
      status: 'UploadFailure',
      statusInfo: { reasonCode: 'RedirectNotAllowed' },
    });
    expect(hits()).toBe(1);
  });

  it('retries a failed upload as the request says', async () => {
    const { base, hits } = await httpServer([500, 201]);
    const h = await makeHarness();
    await h.invoke('GetLog', {
      requestId: 14,
      logType: 'DiagnosticsLog',
      log: { remoteLocation: `${base}/upload/` },
      retries: 1,
      retryInterval: 0,
    });
    await settled(h, 'LogStatusNotification', ['Uploaded', 'UploadFailure']);
    expect(statuses(h, 'LogStatusNotification')).toEqual(['Uploading', 'Uploaded']);
    expect(hits()).toBe(2);
  });

  it('cancels a running upload for a new GetLog: AcceptedCanceled (N01.FR.12/20)', async () => {
    const slow = await httpServer([0]);
    const ftp = track(await startFtpServer({ user: 'u', password: 'p' }));
    const h = await makeHarness();
    await h.invoke('GetLog', {
      requestId: 21,
      logType: 'DiagnosticsLog',
      log: { remoteLocation: `${slow.base}/upload/` },
    });
    await vi.waitFor(() => expect(slow.hits()).toBe(1), { timeout: 5000, interval: 20 });
    const second = await h.invoke('GetLog', {
      requestId: 22,
      logType: 'DiagnosticsLog',
      log: { remoteLocation: `ftp://u:p@127.0.0.1:${String(ftp.port)}/` },
    });
    expect(second['status']).toBe('AcceptedCanceled');
    await vi.waitFor(
      () => {
        const sent = h.sent('LogStatusNotification');
        expect(sent).toContainEqual({ status: 'AcceptedCanceled', requestId: 21 });
        expect(sent).toContainEqual({ status: 'Uploaded', requestId: 22 });
      },
      { timeout: 10_000, interval: 20 },
    );
    expect(ftp.files.size).toBe(1);
  });

  it('1.6 GetLog sends no statusInfo on a failure', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    await h.invoke('GetLog', {
      requestId: 15,
      logType: 'SecurityLog',
      log: { remoteLocation: 'http://169.254.169.254/upload/' },
    });
    await settled(h, 'LogStatusNotification', ['Uploaded', 'UploadFailure']);
    expect(h.sent('LogStatusNotification').at(-1)).toEqual({
      status: 'UploadFailure',
      requestId: 15,
    });
  });
});

describe('GetDiagnostics (OCPP 1.6) uploads the diagnostics file', () => {
  it('uploads into the location directory over SFTP and reports Uploaded', async () => {
    const sftp = track(await startSftpServer({ user: 'evtivity', password: 'evtivity' }));
    const h = await makeHarness({
      protocol: 'ocpp1.6',
      config: { sftpHostKeySha256: `SHA256:${String(sftp.hostKeySha256)}` },
    });
    const res = await h.invoke('GetDiagnostics', {
      location: `sftp://evtivity:evtivity@127.0.0.1:${String(sftp.port)}/upload`,
      startTime: '2026-10-27T00:00:00.000Z',
    });
    expect(String(res['fileName'])).toMatch(/^diagnostics-TEST-SIM-\d+\.log$/);
    await settled(h, 'DiagnosticsStatusNotification', ['Uploaded', 'UploadFailed']);
    expect(statuses(h, 'DiagnosticsStatusNotification')).toEqual(['Uploading', 'Uploaded']);
    const file = sftp.files.get(`/upload/${String(res['fileName'])}`);
    expect(file?.toString()).toContain('oldestTimestamp: 2026-10-27T00:00:00.000Z');
  });

  it('reports UploadFailed for a wrong FTP password', async () => {
    const ftp = track(await startFtpServer({ user: 'evtivity', password: 'evtivity' }));
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    await h.invoke('GetDiagnostics', {
      location: `ftp://evtivity:wrong@127.0.0.1:${String(ftp.port)}/`,
    });
    await settled(h, 'DiagnosticsStatusNotification', ['Uploaded', 'UploadFailed']);
    expect(statuses(h, 'DiagnosticsStatusNotification')).toEqual(['Uploading', 'UploadFailed']);
  });
});

describe('file transfer protocols', () => {
  it('a 2.1 station reports every implemented protocol, read-only', async () => {
    const h = await makeHarness();
    const vars = priv(h, 'configVariables') as Map<string, { value: string; readonly: boolean }>;
    expect(vars.get('OCPPCommCtrlr.FileTransferProtocols')).toEqual({
      value: CSS_FILE_TRANSFER_PROTOCOLS_2X,
      readonly: true,
    });
    expect(CSS_FILE_TRANSFER_PROTOCOLS_2X).toBe('FTP,FTPS,HTTP,HTTPS,SFTP');
  });

  it('a 1.6 station reports SupportedFileTransferProtocols without SFTP', async () => {
    const h = await makeHarness({ protocol: 'ocpp1.6' });
    const vars = priv(h, 'configVariables') as Map<string, { value: string; readonly: boolean }>;
    expect(vars.get('SupportedFileTransferProtocols')?.value).toBe(CSS_FILE_TRANSFER_PROTOCOLS_16);
    expect(CSS_FILE_TRANSFER_PROTOCOLS_16).toBe('FTP,FTPS,HTTP,HTTPS');
  });
});
