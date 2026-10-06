// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import 'reflect-metadata';
import crypto, { webcrypto } from 'node:crypto';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as x509 from '@peculiar/x509';
import { isTlsReachable } from '../tls-probe.js';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

// A self-signed certificate no trust store accepts.
let selfSigned: { cert: string; key: string };

beforeAll(async () => {
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=localhost',
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: ALG,
    keys,
    extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: 'localhost' }])],
  });
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  const key = crypto
    .createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' })
    .export({ format: 'pem', type: 'pkcs8' });
  selfSigned = { cert: cert.toString('pem'), key };
});

const servers: NetServer[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

async function listen(server: NetServer): Promise<number> {
  servers.push(server);
  server.on('connection', (socket: Socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address == null || typeof address === 'string') throw new Error('no address');
  return address.port;
}

describe('isTlsReachable', () => {
  it('reaches a TLS server with a self-signed certificate', async () => {
    const port = await listen(createTlsServer(selfSigned));
    expect(await isTlsReachable(`wss://localhost:${String(port)}`)).toBe(true);
  });

  it('counts a certificate that fails verification as reachable, whatever TLS_REJECT_UNAUTHORIZED says', async () => {
    // The station's OcppClient verifies (and reports a refused certificate);
    // the probe only decides whether to start the station.
    const port = await listen(createTlsServer(selfSigned));
    for (const value of ['true', 'false', '']) {
      vi.stubEnv('TLS_REJECT_UNAUTHORIZED', value);
      expect(await isTlsReachable(`wss://localhost:${String(port)}`)).toBe(true);
    }
  });

  it('is not reachable when nothing listens', async () => {
    const port = await listen(createNetServer());
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));
    expect(await isTlsReachable(`wss://localhost:${String(port)}`)).toBe(false);
  });

  it('is not reachable when the server never completes the handshake', async () => {
    const port = await listen(createNetServer());
    expect(await isTlsReachable(`wss://localhost:${String(port)}`, 200)).toBe(false);
  });

  it('is not reachable when the server answers without TLS', async () => {
    const server = createNetServer((socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    const port = await listen(server);
    expect(await isTlsReachable(`wss://localhost:${String(port)}`)).toBe(false);
  });

  it('is not reachable for a URL it cannot parse', async () => {
    expect(await isTlsReachable('not a url')).toBe(false);
  });
});
