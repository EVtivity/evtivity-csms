// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import WebSocket from 'ws';
import { connect as tlsConnect } from 'node:tls';
import { OcppTestServer } from '../cs-server.js';
import {
  createRootCertificate,
  issueCertificate,
  type TestCertificate,
} from '../cs-security-pki.js';
import * as nodeNetModule from 'node:net';

let root: TestCertificate;
let serverCert: TestCertificate;
let otherServerCert: TestCertificate;
let clientCert: TestCertificate;

beforeAll(async () => {
  root = await createRootCertificate('OCTT Test Root');
  serverCert = await issueCertificate({
    subject: 'CN=localhost,O=OCTT',
    issuer: root,
    dnsNames: ['localhost'],
  });
  otherServerCert = await issueCertificate({
    subject: 'CN=localhost,O=OCTT Other',
    issuer: root,
    dnsNames: ['localhost'],
  });
  clientCert = await issueCertificate({ subject: 'CN=CS-TLS-1,O=OCTT', issuer: root });
});

function open(
  url: string,
  opts: { cert?: TestCertificate; ca?: string } = {},
): Promise<{ ws: WebSocket; peerSubject: string | undefined }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, ['ocpp2.1'], {
      ca: opts.ca ?? root.pem,
      ...(opts.cert != null ? { cert: opts.cert.pem, key: opts.cert.keyPem } : {}),
    });
    let peerSubject: string | undefined;
    ws.once('upgrade', (res) => {
      const socket = res.socket as import('node:tls').TLSSocket;
      peerSubject = String(socket.getPeerCertificate().subject.O);
    });
    ws.once('open', () => {
      resolve({ ws, peerSubject });
    });
    ws.once('error', reject);
  });
}

describe('OcppTestServer (wss://)', () => {
  let server: OcppTestServer | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await server?.stop();
    server = null;
  });

  it('serves wss:// on localhost and records the handshake, cipher suites and client certificate', async () => {
    server = new OcppTestServer();
    const { url } = await server.start({
      cert: serverCert.pem,
      key: serverCert.keyPem,
      requestCert: true,
      ca: root.pem,
    });
    expect(url).toMatch(/^wss:\/\/localhost:\d+$/);
    const handshake = server.waitForTlsHandshake(5000);
    const { ws } = await open(`${url}/CS-TLS-1`, { cert: clientCert });
    sockets.push(ws);
    await expect(server.waitForConnection(2000)).resolves.toBe('CS-TLS-1');

    const h = await handshake;
    expect(h.ok).toBe(true);
    expect(h.clientCertificate).toBeInstanceOf(Buffer);
    expect(server.tlsHandshakes()).toHaveLength(1);

    const tls = server.lastUpgrade?.tls;
    expect(tls).not.toBeNull();
    expect(tls?.protocol).toMatch(/^TLSv1\.[23]$/);
    expect(tls?.cipher).toEqual(expect.any(String));
    expect(tls?.offeredCipherSuites.length).toBeGreaterThan(0);
    expect(tls?.clientCertificate?.subject).toContain('CN=CS-TLS-1');
    expect(tls?.clientCertificateAuthorized).toBe(true);
    expect(tls?.clientCertificateError).toBeNull();
  });

  it('records an unauthorized client certificate without refusing it', async () => {
    const strangerRoot = await createRootCertificate('Stranger Root');
    const stranger = await issueCertificate({ subject: 'CN=CS-X', issuer: strangerRoot });
    server = new OcppTestServer();
    const { url } = await server.start({
      cert: serverCert.pem,
      key: serverCert.keyPem,
      requestCert: true,
      ca: root.pem,
    });
    const { ws } = await open(`${url}/CS-X`, { cert: stranger });
    sockets.push(ws);
    await server.waitForConnection(2000);
    const tls = server.lastUpgrade?.tls;
    expect(tls?.clientCertificateAuthorized).toBe(false);
    expect(tls?.clientCertificateError).toEqual(expect.any(String));
  });

  it('records a failed handshake when the client rejects the server certificate', async () => {
    const unknownRoot = await createRootCertificate('Unknown Root');
    server = new OcppTestServer();
    const { url } = await server.start({
      cert: serverCert.pem,
      key: serverCert.keyPem,
      requestCert: false,
    });
    const handshake = server.waitForTlsHandshake(5000);
    await expect(open(`${url}/CS-1`, { ca: unknownRoot.pem })).rejects.toThrow();
    const h = await handshake;
    expect(h.ok).toBe(false);
    expect(h.clientCertificate).toBeNull();
    expect(h.error).toEqual(expect.any(String));
    expect(server.isConnected).toBe(false);
  });

  it('serves a new server certificate from the next handshake', async () => {
    server = new OcppTestServer();
    const { url } = await server.start({
      cert: serverCert.pem,
      key: serverCert.keyPem,
      requestCert: false,
    });
    const first = await open(`${url}/CS-1`);
    sockets.push(first.ws);
    expect(first.peerSubject).toBe('OCTT');
    await server.waitForConnection(2000);
    server.disconnectStation();

    server.setServerCertificate(otherServerCert.pem, otherServerCert.keyPem);
    const second = await open(`${url}/CS-1`);
    sockets.push(second.ws);
    expect(second.peerSubject).toBe('OCTT Other');
  });

  it('a TLS front tolerates data that is not a ClientHello', async () => {
    server = new OcppTestServer();
    const { port } = await server.start({
      cert: serverCert.pem,
      key: serverCert.keyPem,
      requestCert: false,
      maxVersion: 'TLSv1.1',
    });
    const handshake = server.waitForTlsHandshake(5000);
    const { createConnection } = nodeNetModule;
    const sock = createConnection({ host: '127.0.0.1', port });
    sock.on('error', () => {
      // The server drops the connection.
    });
    sock.write('GET / HTTP/1.1\r\n\r\n');
    const h = await handshake;
    expect(h.ok).toBe(false);
    sock.destroy();
  });

  it('a legacy TLS server refuses a TLS 1.2-only client', async () => {
    server = new OcppTestServer();
    const { port } = await server.start({
      cert: serverCert.pem,
      key: serverCert.keyPem,
      requestCert: false,
      maxVersion: 'TLSv1.1',
    });
    const handshake = server.waitForTlsHandshake(5000);
    const err = await new Promise<Error>((resolve) => {
      const s = tlsConnect({
        host: '127.0.0.1',
        port,
        servername: 'localhost',
        ca: root.pem,
        minVersion: 'TLSv1.2',
      });
      s.once('error', resolve);
    });
    expect(err).toBeInstanceOf(Error);
    expect((await handshake).ok).toBe(false);
  });
});
