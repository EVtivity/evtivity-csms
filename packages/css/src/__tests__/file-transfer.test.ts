// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The simulator's file transfers against in-process HTTP(S), FTP(S) and SFTP servers.

import 'reflect-metadata';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  FileTransferError,
  downloadFile as downloadFileGuarded,
  hostKeySha256,
  uploadFile as uploadFileGuarded,
  uploadTargetUrl,
  type FileTransferOptions,
} from '../lib/file-transfer.js';
import {
  selfSignedCert,
  startFtpServer,
  startSftpServer,
  type TestCert,
  type TestFileServer,
} from './file-transfer-servers.js';

const BODY = Buffer.from('2026-10-27 INFO station log line\n');

// The test servers listen on 127.0.0.1: these checks allow private networks, as development
// and test do. The address rules have their own describe block below.
const LOCAL: FileTransferOptions = { allowPrivateNetworks: true };
const uploadFile = (location: string, name: string, body: Buffer, o: FileTransferOptions = {}) =>
  uploadFileGuarded(location, name, body, { ...LOCAL, ...o });
const downloadFile = (location: string, maxBytes: number, o: FileTransferOptions = {}) =>
  downloadFileGuarded(location, maxBytes, { ...LOCAL, ...o });
const cleanups: Array<() => Promise<void>> = [];
let cert: TestCert;

beforeAll(async () => {
  cert = await selfSignedCert();
});

afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

async function failure(promise: Promise<unknown>): Promise<FileTransferError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof FileTransferError) return err;
    throw err;
  }
  throw new Error('expected the transfer to fail');
}

interface Received {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

async function httpServer(
  answer: (req: Received) => { status: number; headers?: Record<string, string>; body?: Buffer },
  secure = false,
): Promise<{ base: string; received: Received[] }> {
  const received: Received[] = [];
  const handler = (req: IncomingMessage, res: import('node:http').ServerResponse): void => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry: Received = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      received.push(entry);
      const out = answer(entry);
      res.writeHead(out.status, out.headers);
      res.end(out.body);
    });
  };
  const server: Server = secure ? createHttpsServer(cert, handler) : createHttpServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { base: `${secure ? 'https' : 'http'}://127.0.0.1:${String(port)}`, received };
}

function track(server: TestFileServer): TestFileServer {
  cleanups.push(() => server.close());
  return server;
}

describe('uploadTargetUrl', () => {
  it('appends the file name to a location ending with a slash (N01.FR.21)', () => {
    expect(uploadTargetUrl('ftp://h/logs/', 'a b.log').href).toBe('ftp://h/logs/a%20b.log');
  });

  it('uses any other location as received (N01.FR.29)', () => {
    expect(uploadTargetUrl('https://h/upload?x=1', 'a.log').href).toBe('https://h/upload?x=1');
  });

  it('refuses a location that is not a URL', () => {
    expect(() => uploadTargetUrl('not a url', 'a.log')).toThrow(FileTransferError);
  });
});

describe('HTTP and HTTPS upload', () => {
  it('PUTs the file with Basic authentication from the userinfo (N01.FR.25)', async () => {
    const { base, received } = await httpServer(() => ({ status: 201 }));
    const location = base.replace('://', '://up%40load:p%3Ass@') + '/logs/';
    await uploadFile(location, 'diag.log', BODY);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: 'PUT', url: '/logs/diag.log', body: BODY });
    expect(received[0]?.headers['content-type']).toBe('application/octet-stream');
    expect(received[0]?.headers['authorization']).toBe(
      `Basic ${Buffer.from('up@load:p:ss').toString('base64')}`,
    );
  });

  it('never follows a redirect and fails with RedirectNotAllowed (N01.FR.30)', async () => {
    const target = await httpServer(() => ({ status: 201 }));
    const { base } = await httpServer(() => ({
      status: 302,
      headers: { location: `${target.base}/elsewhere` },
    }));
    const err = await failure(uploadFile(`${base}/redirect`, 'x.log', BODY));
    expect(err.reason).toBe('RedirectNotAllowed');
    expect(target.received).toHaveLength(0);
  });

  it('reports a refused login as PermissionDenied and a server error as TransferFailed', async () => {
    const denied = await httpServer(() => ({ status: 401 }));
    expect((await failure(uploadFile(`${denied.base}/u`, 'x.log', BODY))).reason).toBe(
      'PermissionDenied',
    );
    const broken = await httpServer(() => ({ status: 500 }));
    expect((await failure(uploadFile(`${broken.base}/u`, 'x.log', BODY))).reason).toBe(
      'TransferFailed',
    );
  });

  it('uploads over HTTPS to a server signed by the given CA, and refuses it without', async () => {
    const { base, received } = await httpServer(() => ({ status: 200 }), true);
    await uploadFile(`${base}/u`, 'x.log', BODY, { caPem: cert.cert });
    expect(received).toHaveLength(1);
    expect((await failure(uploadFile(`${base}/u`, 'x.log', BODY))).reason).toBe('TransferFailed');
  });

  it('refuses cloud metadata and unroutable addresses before connecting', async () => {
    for (const location of [
      'http://169.254.169.254/latest/',
      'ftp://169.254.169.254/x/',
      'sftp://[::ffff:169.254.169.254]/x/',
      'https://0.0.0.0/x',
    ]) {
      expect((await failure(uploadFile(location, 'x.log', BODY))).reason).toBe(
        'BlockedDestination',
      );
    }
  });

  it('refuses a protocol it does not implement', async () => {
    expect((await failure(uploadFile('gopher://h/x/', 'x.log', BODY))).reason).toBe(
      'UnsupportedProtocol',
    );
  });

  it('reports a canceled upload as Canceled and a timeout as TransferFailed', async () => {
    const { base } = await httpServer(() => ({ status: 200 }));
    const controller = new AbortController();
    controller.abort();
    expect(
      (await failure(uploadFile(`${base}/u`, 'x.log', BODY, { signal: controller.signal }))).reason,
    ).toBe('Canceled');
    // A server that never answers.
    const silent = createHttpServer(() => {
      // fail-open: the test server never answers, so the client times out
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          silent.closeAllConnections();
          silent.close(() => resolve());
        }),
    );
    const { port } = silent.address() as AddressInfo;
    const err = await failure(
      uploadFile(`http://127.0.0.1:${String(port)}/u`, 'x.log', BODY, { timeoutMs: 200 }),
    );
    expect(err.reason).toBe('TransferFailed');
    expect(err.message).toMatch(/timed out/);
  });
});

describe('FTP and FTPS', () => {
  it('uploads in passive mode to the path relative to the login directory', async () => {
    const ftp = track(await startFtpServer({ user: 'evtivity', password: 's3cret' }));
    await uploadFile(`ftp://evtivity:s3cret@127.0.0.1:${String(ftp.port)}/logs/`, 'a.log', BODY);
    expect(ftp.files.get('logs/a.log')).toEqual(BODY);
    expect(ftp.commands).toContain('EPSV');
    expect(ftp.commands).toContain('PASS ***');
  });

  it('reports a wrong password as PermissionDenied', async () => {
    const ftp = track(await startFtpServer({ user: 'evtivity', password: 's3cret' }));
    const err = await failure(
      uploadFile(`ftp://evtivity:wrong@127.0.0.1:${String(ftp.port)}/`, 'a.log', BODY),
    );
    expect(err.reason).toBe('PermissionDenied');
    expect(ftp.files.size).toBe(0);
  });

  it('uploads over explicit FTPS (AUTH TLS, PROT P) with the given CA', async () => {
    const ftp = track(await startFtpServer({ user: 'u', password: 'p', tlsCert: cert }));
    await uploadFile(`ftps://u:p@127.0.0.1:${String(ftp.port)}/up/`, 'a.log', BODY, {
      caPem: cert.cert,
    });
    expect(ftp.files.get('up/a.log')).toEqual(BODY);
    expect(ftp.commands).toEqual(expect.arrayContaining(['AUTH TLS', 'PROT P']));
  });

  it('downloads a file and refuses one over the size cap', async () => {
    const ftp = track(await startFtpServer({ user: 'u', password: 'p' }));
    ftp.files.set('fw/image.bin', Buffer.alloc(64, 1));
    const url = `ftp://u:p@127.0.0.1:${String(ftp.port)}/fw/image.bin`;
    expect(await downloadFile(url, 64)).toEqual(Buffer.alloc(64, 1));
    expect((await failure(downloadFile(url, 63))).reason).toBe('TooLarge');
  });
});

describe('SFTP', () => {
  it('uploads to the absolute path with the password from the userinfo', async () => {
    const sftp = track(await startSftpServer({ user: 'evtivity', password: 's3cret' }));
    await uploadFile(
      `sftp://evtivity:s3cret@127.0.0.1:${String(sftp.port)}/upload/`,
      'a.log',
      BODY,
      { sftpHostKeySha256: `SHA256:${String(sftp.hostKeySha256)}` },
    );
    expect(sftp.files.get('/upload/a.log')).toEqual(BODY);
  });

  it('fails closed without a configured host key while verification is on', async () => {
    const sftp = track(await startSftpServer({ user: 'u', password: 'p' }));
    const url = `sftp://u:p@127.0.0.1:${String(sftp.port)}/upload/`;
    expect((await failure(uploadFile(url, 'a.log', BODY))).reason).toBe('UntrustedHostKey');
    expect(
      (await failure(uploadFile(url, 'a.log', BODY, { sftpHostKeySha256: 'SHA256:AAAA' }))).reason,
    ).toBe('UntrustedHostKey');
    expect(sftp.files.size).toBe(0);
    expect(sftp.commands).toEqual([]);
  });

  it('accepts any host key with verification off', async () => {
    const sftp = track(await startSftpServer({ user: 'u', password: 'p' }));
    await uploadFile(`sftp://u:p@127.0.0.1:${String(sftp.port)}/upload/`, 'a.log', BODY, {
      rejectUnauthorized: false,
    });
    expect(sftp.files.get('/upload/a.log')).toEqual(BODY);
  });

  it('computes the OpenSSH fingerprint of a host key blob', () => {
    expect(hostKeySha256(Buffer.from('key'))).toBe('LHDhK3oGRvkiefQnx7OOczTY5Tic/xZ6HcMOc/gmtoM');
  });

  it('reports a wrong password and a refused path as PermissionDenied', async () => {
    const sftp = track(await startSftpServer({ user: 'evtivity', password: 's3cret' }));
    const base = `127.0.0.1:${String(sftp.port)}`;
    const key = { sftpHostKeySha256: String(sftp.hostKeySha256) };
    expect(
      (await failure(uploadFile(`sftp://evtivity:wrong@${base}/upload/`, 'a.log', BODY, key)))
        .reason,
    ).toBe('PermissionDenied');
    expect(
      (await failure(uploadFile(`sftp://evtivity:s3cret@${base}/denied/`, 'a.log', BODY, key)))
        .reason,
    ).toBe('PermissionDenied');
    expect(sftp.files.size).toBe(0);
  });

  it('downloads a file and refuses one over the size cap', async () => {
    const sftp = track(await startSftpServer({ user: 'u', password: 'p' }));
    sftp.files.set('/fw/image.bin', Buffer.alloc(100, 7));
    const url = `sftp://u:p@127.0.0.1:${String(sftp.port)}/fw/image.bin`;
    const key = { sftpHostKeySha256: String(sftp.hostKeySha256) };
    expect(await downloadFile(url, 100, key)).toEqual(Buffer.alloc(100, 7));
    expect((await failure(downloadFile(url, 99, key))).reason).toBe('TooLarge');
  });
});

describe('HTTP download', () => {
  it('downloads from a private test server and refuses a file over the cap', async () => {
    const { base } = await httpServer(() => ({ status: 200, body: Buffer.alloc(32, 2) }));
    expect(await downloadFile(`${base}/fw.bin`, 32)).toEqual(Buffer.alloc(32, 2));
    expect((await failure(downloadFile(`${base}/fw.bin`, 31))).reason).toBe('TooLarge');
  });

  it('reports a missing file as TransferFailed', async () => {
    const { base } = await httpServer(() => ({ status: 404 }));
    expect((await failure(downloadFile(`${base}/fw.bin`, 32))).reason).toBe('TransferFailed');
  });
});

describe('private addresses', () => {
  it('refuses a private address without development mode or an allowed host', async () => {
    const { base, received } = await httpServer(() => ({ status: 201 }));
    const ftp = track(await startFtpServer({ user: 'u', password: 'p' }));
    const ftpUrl = `ftp://u:p@127.0.0.1:${String(ftp.port)}/`;
    // One transfer at a time: a transfer started before the previous one is
    // awaited rejects with nothing listening (an unhandled rejection).
    for (const transfer of [
      () => uploadFileGuarded(`${base}/u`, 'x.log', BODY),
      () => uploadFileGuarded(ftpUrl, 'x.log', BODY),
      () =>
        uploadFileGuarded(`sftp://u:p@localhost:22/x/`, 'x.log', BODY, {
          rejectUnauthorized: false,
        }),
      () => downloadFileGuarded(`${base}/fw.bin`, 10),
    ]) {
      expect((await failure(transfer())).reason).toBe('BlockedDestination');
    }
    expect(received).toHaveLength(0);
    expect(ftp.commands).toEqual([]);
  });

  it('allows a host named in allowedPrivateHosts, by host or host:port', async () => {
    const { base, received } = await httpServer(() => ({ status: 201 }));
    const port = new URL(base).port;
    await uploadFileGuarded(`${base}/u`, 'x.log', BODY, { allowedPrivateHosts: ['127.0.0.1'] });
    await uploadFileGuarded(`${base}/u`, 'x.log', BODY, {
      allowedPrivateHosts: [` 127.0.0.1:${port} `],
    });
    expect(received).toHaveLength(2);
    expect(
      (
        await failure(
          uploadFileGuarded(`${base}/u`, 'x.log', BODY, { allowedPrivateHosts: ['127.0.0.1:1'] }),
        )
      ).reason,
    ).toBe('BlockedDestination');
  });

  it('never lets an allowed host redirect a download elsewhere', async () => {
    const target = await httpServer(() => ({ status: 200, body: Buffer.from('fw') }));
    const { base } = await httpServer(() => ({
      status: 302,
      headers: { location: `${target.base}/fw.bin` },
    }));
    const err = await failure(
      downloadFileGuarded(`${base}/fw.bin`, 10, { allowedPrivateHosts: ['127.0.0.1'] }),
    );
    expect(err.reason).toBe('TransferFailed');
    expect(target.received).toHaveLength(0);
  });

  it('refuses cloud metadata even for an allowed host or in development mode', async () => {
    for (const options of [
      { allowPrivateNetworks: true },
      { allowedPrivateHosts: ['169.254.169.254'] },
    ]) {
      expect(
        (await failure(uploadFileGuarded('http://169.254.169.254/x/', 'x.log', BODY, options)))
          .reason,
      ).toBe('BlockedDestination');
    }
  });
});
